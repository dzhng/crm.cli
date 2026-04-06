/**
 * FUSE daemon — serves CRM data over a Unix socket.
 *
 * Architecture:
 *   `crm mount` spawns this daemon as a background process via `crm __daemon`.
 *   The daemon listens on a Unix socket. On macOS, the NFS server (Rust binary)
 *   connects to this socket. On Linux, the FUSE helper (C binary) connects.
 *   Both forward filesystem operations here; this daemon handles all business
 *   logic (enriched JSON, validation, writes, phone normalization, search).
 *
 * How it's invoked:
 *   The `crm` binary spawns itself: `crm __daemon <socket> <db> [stages...]`
 *   This works identically for compiled binaries and `bun run src/cli.ts`.
 *   The __daemon subcommand is handled in cli.ts before commander parses,
 *   and calls startDaemon() exported from this file.
 *
 * Protocol: newline-delimited JSON over Unix socket.
 *   Request:  {"op":"getattr"|"readdir"|"read"|"write"|"unlink","path":"/...", ...}\n
 *   Response: {...}\n
 */

import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { type CRMConfig, loadConfig } from './config'
import { type DB, openDB, removeSearchIndex } from './db'
import * as schema from './drizzle-schema'
import { safeJSON } from './format'
import {
  buildActivityJSON,
  buildCompanyJSON,
  buildContactJSON,
  buildDealJSON,
  LLM_TXT,
  slugify,
} from './fuse-json'
import { getOrCreateCompanyId } from './lib/helpers'
import { normalizePhone } from './normalize'
import {
  computeConversion,
  computeForecast,
  computeLost,
  computeStale,
  computeVelocity,
  computeWon,
} from './reports'
import { resolveContact } from './resolve'

function makeId(prefix: string): string {
  return `${prefix}_${ulid()}`
}

// ── Path parsing helpers ──

function extractId(filename: string): string | null {
  const dots = filename.indexOf('...')
  if (dots === -1) {
    return null
  }
  return filename.slice(0, dots)
}

function stripJsonExt(s: string): string {
  return s.endsWith('.json') ? s.slice(0, -5) : s
}

function extractCompanyId(val: unknown): string {
  if (typeof val === 'object' && val !== null && 'id' in val) {
    return (val as { id: string }).id
  }
  return val as string
}

// ── Field validation whitelists ──

const CONTACT_WRITE_FIELDS = new Set([
  'id',
  'name',
  'emails',
  'email',
  'phones',
  'phone',
  'linkedin',
  'x',
  'bluesky',
  'telegram',
  'companies',
  'company',
  'tags',
  'custom_fields',
  'created_at',
  'updated_at',
  'title',
  'department',
  'source',
  'notes',
  'address',
  'birthday',
  'website',
  'job_title',
  'role',
  'position',
  // Read-only enriched fields (ignored on write)
  'deals',
  'recent_activity',
])

const COMPANY_WRITE_FIELDS = new Set([
  'id',
  'name',
  'websites',
  'website',
  'phones',
  'phone',
  'tags',
  'custom_fields',
  'created_at',
  'updated_at',
  'industry',
  'address',
  'notes',
  'source',
  'description',
  'size',
  // Read-only enriched fields (ignored on write)
  'contacts',
  'deals',
])

const DEAL_WRITE_FIELDS = new Set([
  'id',
  'title',
  'value',
  'stage',
  'contacts',
  'company',
  'expected_close',
  'probability',
  'tags',
  'custom_fields',
  'created_at',
  'updated_at',
  // Read-only enriched fields (ignored on write)
  'stage_history',
])

const ACTIVITY_WRITE_FIELDS = new Set([
  'id',
  'type',
  'body',
  'note',
  'contacts',
  'contact',
  'company',
  'deal',
  'entity_ref',
  'custom_fields',
  'created_at',
])

// Known report files
const KNOWN_REPORTS = new Set([
  'pipeline.json',
  'stale.json',
  'forecast.json',
  'conversion.json',
  'velocity.json',
  'won.json',
  'lost.json',
])

// ── Request handler ──

async function handleRequest(
  db: DB,
  config: CRMConfig,
  stages: string[],
  req: { op: string; path: string; data?: string },
): Promise<Record<string, unknown>> {
  const { op, path } = req
  const p = path.startsWith('/') ? path.slice(1) : path

  switch (op) {
    case 'getattr':
      return await handleGetattr(db, config, p, stages)
    case 'readdir':
      return await handleReaddir(db, p, stages)
    case 'read':
      return await handleRead(db, config, p, stages)
    case 'write':
      return await handleWrite(db, config, p, req.data || '')
    case 'unlink':
      return await handleUnlink(db, p)
    default:
      return { error: 'ENOSYS' }
  }
}

// ── getattr ──

// Computes actual file size via handleRead — without this, FUSE reports
// st_size=65536 and the NFS/FUSE client zero-pads reads to that size.
async function handleGetattr(
  db: DB,
  config: CRMConfig,
  p: string,
  stages: string[],
): Promise<Record<string, unknown>> {
  const result = await _handleGetattr(db, p, stages)
  if (result.type === 'file') {
    const readResult = await handleRead(db, config, p, stages)
    if ('data' in readResult && typeof readResult.data === 'string') {
      return { type: 'file', size: Buffer.byteLength(readResult.data, 'utf-8') }
    }
  }
  return result
}

async function _handleGetattr(
  db: DB,
  p: string,
  stages: string[],
): Promise<Record<string, unknown>> {
  // Root
  if (p === '') {
    return { type: 'dir' }
  }

  // Top-level dirs
  if (
    [
      'contacts',
      'companies',
      'deals',
      'activities',
      'reports',
      'search',
    ].includes(p)
  ) {
    return { type: 'dir' }
  }

  // Top-level virtual files
  if (p === 'pipeline.json' || p === 'tags.json') {
    return { type: 'file' }
  }

  // Entity files: contacts/<file>.json, companies/<file>.json, etc.
  const parts = p.split('/')

  if (parts.length === 2) {
    const [dir, file] = parts

    // Entity JSON files
    if (
      ['contacts', 'companies', 'deals', 'activities'].includes(dir) &&
      file.endsWith('.json')
    ) {
      const id = extractId(file)
      if (id) {
        // Check entity exists in DB
        const exists = await entityExists(db, dir, id)
        return exists ? { type: 'file' } : { error: 'ENOENT' }
      }
      // File like "new.json" for writes — treat as creatable
      return { type: 'file' }
    }

    // _by-* index directories
    if (file.startsWith('_by-')) {
      return { type: 'dir' }
    }

    // reports/<name>.json
    if (dir === 'reports') {
      if (KNOWN_REPORTS.has(file)) {
        return { type: 'file' }
      }
      return { error: 'ENOENT' }
    }

    // search/<query>.json
    if (dir === 'search' && file.endsWith('.json')) {
      return { type: 'file' }
    }
  }

  // _by-* subdirectories and files within them
  if (parts.length === 3) {
    const [dir, byDir, item] = parts

    // contacts/_by-tag/<tag> or contacts/_by-company/<slug> — these are dirs
    if (dir === 'contacts' && byDir === '_by-tag') {
      const exists = await tagExists(db, item)
      return exists ? { type: 'dir' } : { error: 'ENOENT' }
    }
    if (dir === 'contacts' && byDir === '_by-company') {
      const exists = await companySlugExists(db, item)
      return exists ? { type: 'dir' } : { error: 'ENOENT' }
    }

    // deals/_by-stage/<stage> — dir
    if (dir === 'deals' && byDir === '_by-stage') {
      return stages.includes(item) ? { type: 'dir' } : { error: 'ENOENT' }
    }

    // _by-email/<email>.json, _by-phone/<phone>.json, etc — files
    if (item.endsWith('.json')) {
      const val = stripJsonExt(item)
      const exists = await byIndexExists(db, dir, byDir, val)
      return exists ? { type: 'file' } : { error: 'ENOENT' }
    }
  }

  // deals/_by-stage/<stage>/<file>.json
  if (
    parts.length === 4 &&
    parts[0] === 'deals' &&
    parts[1] === '_by-stage' &&
    parts[3].endsWith('.json')
  ) {
    const id = extractId(parts[3])
    if (id) {
      const exists = await entityExists(db, 'deals', id)
      return exists ? { type: 'file' } : { error: 'ENOENT' }
    }
  }

  // contacts/_by-tag/<tag>/<file>.json or contacts/_by-company/<slug>/<file>.json
  if (
    parts.length === 4 &&
    parts[0] === 'contacts' &&
    parts[1].startsWith('_by-') &&
    parts[3].endsWith('.json')
  ) {
    const id = extractId(parts[3])
    if (id) {
      const exists = await entityExists(db, 'contacts', id)
      return exists ? { type: 'file' } : { error: 'ENOENT' }
    }
  }

  return { error: 'ENOENT' }
}

async function entityExists(
  db: DB,
  entityDir: string,
  id: string,
): Promise<boolean> {
  // Check entity existence by querying the specific table
  switch (entityDir) {
    case 'contacts': {
      const r = await db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(eq(schema.contacts.id, id))
      return r.length > 0
    }
    case 'companies': {
      const r = await db
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(eq(schema.companies.id, id))
      return r.length > 0
    }
    case 'deals': {
      const r = await db
        .select({ id: schema.deals.id })
        .from(schema.deals)
        .where(eq(schema.deals.id, id))
      return r.length > 0
    }
    case 'activities': {
      const r = await db
        .select({ id: schema.activities.id })
        .from(schema.activities)
        .where(eq(schema.activities.id, id))
      return r.length > 0
    }
    default:
      return false
  }
}

async function tagExists(db: DB, tag: string): Promise<boolean> {
  const contacts = await db
    .select({ tags: schema.contacts.tags })
    .from(schema.contacts)
  for (const c of contacts) {
    const tags: string[] = safeJSON(c.tags)
    if (tags.includes(tag)) {
      return true
    }
  }
  const companies = await db
    .select({ tags: schema.companies.tags })
    .from(schema.companies)
  for (const co of companies) {
    const tags: string[] = safeJSON(co.tags)
    if (tags.includes(tag)) {
      return true
    }
  }
  const deals = await db.select({ tags: schema.deals.tags }).from(schema.deals)
  for (const d of deals) {
    const tags: string[] = safeJSON(d.tags)
    if (tags.includes(tag)) {
      return true
    }
  }
  return false
}

async function companySlugExists(db: DB, slug: string): Promise<boolean> {
  const allCompanies = await db.select().from(schema.companies)
  const contacts = await db
    .select({ companies: schema.contacts.companies })
    .from(schema.contacts)
  for (const c of contacts) {
    const companyIds: string[] = safeJSON(c.companies)
    for (const compId of companyIds) {
      const co = allCompanies.find((x) => x.id === compId)
      if (co && slugify(co.name) === slug) {
        return true
      }
    }
  }
  return false
}

async function byIndexExists(
  db: DB,
  dir: string,
  byDir: string,
  val: string,
): Promise<boolean> {
  if (dir === 'contacts') {
    if (byDir === '_by-email') {
      const all = await db.select().from(schema.contacts)
      return all.some((c) => (safeJSON(c.emails) as string[]).includes(val))
    }
    if (byDir === '_by-phone') {
      const all = await db.select().from(schema.contacts)
      return all.some((c) => (safeJSON(c.phones) as string[]).includes(val))
    }
    if (byDir === '_by-linkedin') {
      const all = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.linkedin, val))
      return all.length > 0
    }
    if (byDir === '_by-x') {
      const all = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.x, val))
      return all.length > 0
    }
    if (byDir === '_by-bluesky') {
      const all = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.bluesky, val))
      return all.length > 0
    }
    if (byDir === '_by-telegram') {
      const all = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.telegram, val))
      return all.length > 0
    }
  }
  if (dir === 'companies') {
    if (byDir === '_by-website') {
      const all = await db.select().from(schema.companies)
      return all.some((co) => (safeJSON(co.websites) as string[]).includes(val))
    }
    if (byDir === '_by-phone') {
      const all = await db.select().from(schema.companies)
      return all.some((co) => (safeJSON(co.phones) as string[]).includes(val))
    }
  }
  return false
}

// ── readdir ──

async function handleReaddir(
  db: DB,
  p: string,
  stages: string[],
): Promise<Record<string, unknown>> {
  if (p === '') {
    return {
      entries: [
        'llm.txt',
        'contacts',
        'companies',
        'deals',
        'activities',
        'reports',
        'search',
        'pipeline.json',
        'tags.json',
      ],
    }
  }

  if (p === 'contacts') {
    const contacts = await db.select().from(schema.contacts)
    const files = contacts.map((c) => `${c.id}...${slugify(c.name || '')}.json`)
    return {
      entries: [
        '_by-email',
        '_by-phone',
        '_by-linkedin',
        '_by-x',
        '_by-bluesky',
        '_by-telegram',
        '_by-company',
        '_by-tag',
        ...files,
      ],
    }
  }

  if (p === 'companies') {
    const companies = await db.select().from(schema.companies)
    const files = companies.map(
      (co) => `${co.id}...${slugify(co.name || '')}.json`,
    )
    return {
      entries: ['_by-website', '_by-phone', '_by-tag', ...files],
    }
  }

  if (p === 'deals') {
    const deals = await db.select().from(schema.deals)
    const files = deals.map((d) => `${d.id}...${slugify(d.title || '')}.json`)
    return {
      entries: ['_by-stage', '_by-company', '_by-tag', ...files],
    }
  }

  if (p === 'activities') {
    return {
      entries: ['_by-contact', '_by-company', '_by-deal', '_by-type'],
    }
  }

  if (p === 'reports') {
    return {
      entries: [
        'pipeline.json',
        'stale.json',
        'forecast.json',
        'conversion.json',
        'velocity.json',
        'won.json',
        'lost.json',
      ],
    }
  }

  if (p === 'search') {
    return { entries: [] }
  }

  // deals/_by-stage
  if (p === 'deals/_by-stage') {
    return { entries: stages }
  }

  // deals/_by-stage/<stage>
  if (p.startsWith('deals/_by-stage/')) {
    const stage = p.slice('deals/_by-stage/'.length)
    if (!stage.includes('/')) {
      const deals = await db
        .select()
        .from(schema.deals)
        .where(eq(schema.deals.stage, stage))
      return {
        entries: deals.map((d) => `${d.id}...${slugify(d.title || '')}.json`),
      }
    }
  }

  // contacts/_by-email
  if (p === 'contacts/_by-email') {
    const all = await db.select().from(schema.contacts)
    const entries: string[] = []
    for (const c of all) {
      for (const e of safeJSON(c.emails) as string[]) {
        entries.push(`${e}.json`)
      }
    }
    return { entries }
  }

  // contacts/_by-phone
  if (p === 'contacts/_by-phone') {
    const all = await db.select().from(schema.contacts)
    const entries: string[] = []
    for (const c of all) {
      for (const ph of safeJSON(c.phones) as string[]) {
        entries.push(`${ph}.json`)
      }
    }
    return { entries }
  }

  // contacts/_by-linkedin, _by-x, _by-bluesky, _by-telegram
  for (const field of ['linkedin', 'x', 'bluesky', 'telegram'] as const) {
    if (p === `contacts/_by-${field}`) {
      const all = await db.select().from(schema.contacts)
      const entries = all.filter((c) => c[field]).map((c) => `${c[field]}.json`)
      return { entries }
    }
  }

  // contacts/_by-tag
  if (p === 'contacts/_by-tag') {
    const all = await db.select().from(schema.contacts)
    const tagSet = new Set<string>()
    for (const c of all) {
      for (const t of safeJSON(c.tags) as string[]) {
        tagSet.add(t)
      }
    }
    return { entries: [...tagSet] }
  }

  // contacts/_by-tag/<tag>
  if (p.startsWith('contacts/_by-tag/')) {
    const tag = p.slice('contacts/_by-tag/'.length)
    if (!tag.includes('/')) {
      const all = await db.select().from(schema.contacts)
      const entries = all
        .filter((c) => (safeJSON(c.tags) as string[]).includes(tag))
        .map((c) => `${c.id}...${slugify(c.name || '')}.json`)
      return { entries }
    }
  }

  // contacts/_by-company
  if (p === 'contacts/_by-company') {
    const allContacts = await db.select().from(schema.contacts)
    const allCompanies = await db.select().from(schema.companies)
    const slugSet = new Set<string>()
    for (const c of allContacts) {
      for (const compId of safeJSON(c.companies) as string[]) {
        const co = allCompanies.find((x) => x.id === compId)
        if (co) {
          slugSet.add(slugify(co.name))
        }
      }
    }
    return { entries: [...slugSet] }
  }

  // contacts/_by-company/<slug>
  if (p.startsWith('contacts/_by-company/')) {
    const cslug = p.slice('contacts/_by-company/'.length)
    if (!cslug.includes('/')) {
      const allContacts = await db.select().from(schema.contacts)
      const allCompanies = await db.select().from(schema.companies)
      const entries = allContacts
        .filter((c) => {
          const compIds: string[] = safeJSON(c.companies)
          return compIds.some((compId) => {
            const co = allCompanies.find((x) => x.id === compId)
            return co && slugify(co.name) === cslug
          })
        })
        .map((c) => `${c.id}...${slugify(c.name || '')}.json`)
      return { entries }
    }
  }

  // companies/_by-website
  if (p === 'companies/_by-website') {
    const all = await db.select().from(schema.companies)
    const entries: string[] = []
    for (const co of all) {
      for (const w of safeJSON(co.websites) as string[]) {
        entries.push(`${w}.json`)
      }
    }
    return { entries }
  }

  // companies/_by-phone
  if (p === 'companies/_by-phone') {
    const all = await db.select().from(schema.companies)
    const entries: string[] = []
    for (const co of all) {
      for (const ph of safeJSON(co.phones) as string[]) {
        entries.push(`${ph}.json`)
      }
    }
    return { entries }
  }

  // companies/_by-tag
  if (p === 'companies/_by-tag') {
    const all = await db.select().from(schema.companies)
    const tagSet = new Set<string>()
    for (const co of all) {
      for (const t of safeJSON(co.tags) as string[]) {
        tagSet.add(t)
      }
    }
    return { entries: [...tagSet] }
  }

  return { error: 'ENOENT' }
}

// ── read ──

async function handleRead(
  db: DB,
  config: CRMConfig,
  p: string,
  stages: string[],
): Promise<Record<string, unknown>> {
  // llm.txt — agent instructions
  if (p === 'llm.txt') {
    return { data: LLM_TXT }
  }

  // pipeline.json (top-level)
  if (p === 'pipeline.json' || p === 'reports/pipeline.json') {
    const deals = await db.select().from(schema.deals)
    const data = stages.map((stage) => ({
      stage,
      count: deals.filter((d) => d.stage === stage).length,
      value: deals
        .filter((d) => d.stage === stage)
        .reduce((s, d) => s + (d.value || 0), 0),
    }))
    return { data: JSON.stringify(data) }
  }

  // tags.json
  if (p === 'tags.json') {
    const tagCounts: Record<string, number> = {}
    const contacts = await db.select().from(schema.contacts)
    for (const c of contacts) {
      for (const t of safeJSON(c.tags) as string[]) {
        tagCounts[t] = (tagCounts[t] || 0) + 1
      }
    }
    const companies = await db.select().from(schema.companies)
    for (const co of companies) {
      for (const t of safeJSON(co.tags) as string[]) {
        tagCounts[t] = (tagCounts[t] || 0) + 1
      }
    }
    const deals = await db.select().from(schema.deals)
    for (const d of deals) {
      for (const t of safeJSON(d.tags) as string[]) {
        tagCounts[t] = (tagCounts[t] || 0) + 1
      }
    }
    const data = Object.entries(tagCounts).map(([tag, count]) => ({
      tag,
      count,
    }))
    return { data: JSON.stringify(data) }
  }

  if (p === 'reports/stale.json') {
    const data = await computeStale(db, config)
    return { data: JSON.stringify(data) }
  }

  if (p === 'reports/conversion.json') {
    const data = await computeConversion(db, stages)
    return { data: JSON.stringify(data) }
  }

  if (p === 'reports/velocity.json') {
    const data = await computeVelocity(db, stages)
    return { data: JSON.stringify(data) }
  }

  if (p === 'reports/forecast.json') {
    const data = await computeForecast(db, config)
    return { data: JSON.stringify(data) }
  }

  if (p === 'reports/won.json') {
    const data = await computeWon(db, config)
    return { data: JSON.stringify(data) }
  }

  if (p === 'reports/lost.json') {
    const data = await computeLost(db, config)
    return { data: JSON.stringify(data) }
  }

  // search/<query>.json
  if (p.startsWith('search/') && p.endsWith('.json')) {
    const query = stripJsonExt(p.slice('search/'.length))
    return handleSearch(db, query)
  }

  // contacts/<file>.json
  if (p.startsWith('contacts/')) {
    return readContactPath(db, config, p.slice('contacts/'.length))
  }

  // companies/<file>.json
  if (p.startsWith('companies/')) {
    return readCompanyPath(db, p.slice('companies/'.length))
  }

  // deals/<file>.json
  if (p.startsWith('deals/')) {
    return readDealPath(db, p.slice('deals/'.length))
  }

  // activities/<file>.json
  if (p.startsWith('activities/')) {
    return readActivityPath(db, p.slice('activities/'.length))
  }

  return { error: 'ENOENT' }
}

async function readContactPath(
  db: DB,
  config: CRMConfig,
  sub: string,
): Promise<Record<string, unknown>> {
  // _by-email/<email>.json
  if (sub.startsWith('_by-email/')) {
    const email = stripJsonExt(sub.slice('_by-email/'.length))
    const all = await db.select().from(schema.contacts)
    const c = all.find((x) => (safeJSON(x.emails) as string[]).includes(email))
    if (!c) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(await buildContactJSON(db, c, config)) }
  }
  // _by-phone/<phone>.json
  if (sub.startsWith('_by-phone/')) {
    const phone = stripJsonExt(sub.slice('_by-phone/'.length))
    const all = await db.select().from(schema.contacts)
    const c = all.find((x) => (safeJSON(x.phones) as string[]).includes(phone))
    if (!c) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(await buildContactJSON(db, c, config)) }
  }
  // _by-linkedin, _by-x, _by-bluesky, _by-telegram
  for (const field of ['linkedin', 'x', 'bluesky', 'telegram'] as const) {
    if (sub.startsWith(`_by-${field}/`)) {
      const handle = stripJsonExt(sub.slice(`_by-${field}/`.length))
      const results = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts[field], handle))
      if (!results[0]) {
        return { error: 'ENOENT' }
      }
      return {
        data: JSON.stringify(await buildContactJSON(db, results[0], config)),
      }
    }
  }
  // _by-tag/<tag>/<file>.json or _by-company/<slug>/<file>.json
  if (sub.startsWith('_by-tag/') || sub.startsWith('_by-company/')) {
    const lastSlash = sub.lastIndexOf('/')
    const file = sub.slice(lastSlash + 1)
    const id = extractId(file)
    if (id) {
      const results = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, id))
      if (!results[0]) {
        return { error: 'ENOENT' }
      }
      return {
        data: JSON.stringify(await buildContactJSON(db, results[0], config)),
      }
    }
  }
  // Direct file: <id>...slug.json
  const id = extractId(sub)
  if (id) {
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id))
    if (!results[0]) {
      return { error: 'ENOENT' }
    }
    return {
      data: JSON.stringify(await buildContactJSON(db, results[0], config)),
    }
  }
  return { error: 'ENOENT' }
}

async function readCompanyPath(
  db: DB,
  sub: string,
): Promise<Record<string, unknown>> {
  if (sub.startsWith('_by-website/')) {
    const website = stripJsonExt(sub.slice('_by-website/'.length))
    const all = await db.select().from(schema.companies)
    const co = all.find((x) =>
      (safeJSON(x.websites) as string[]).includes(website),
    )
    if (!co) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(await buildCompanyJSON(db, co)) }
  }
  if (sub.startsWith('_by-phone/')) {
    const phone = stripJsonExt(sub.slice('_by-phone/'.length))
    const all = await db.select().from(schema.companies)
    const co = all.find((x) => (safeJSON(x.phones) as string[]).includes(phone))
    if (!co) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(await buildCompanyJSON(db, co)) }
  }
  const id = extractId(sub)
  if (id) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, id))
    if (!results[0]) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(await buildCompanyJSON(db, results[0])) }
  }
  return { error: 'ENOENT' }
}

async function readDealPath(
  db: DB,
  sub: string,
): Promise<Record<string, unknown>> {
  // _by-stage/<stage>/<file>.json
  if (sub.startsWith('_by-stage/')) {
    const rest = sub.slice('_by-stage/'.length)
    const slash = rest.indexOf('/')
    if (slash !== -1) {
      const file = rest.slice(slash + 1)
      const id = extractId(file)
      if (id) {
        const results = await db
          .select()
          .from(schema.deals)
          .where(eq(schema.deals.id, id))
        if (!results[0]) {
          return { error: 'ENOENT' }
        }
        return { data: JSON.stringify(await buildDealJSON(db, results[0])) }
      }
    }
  }
  const id = extractId(sub)
  if (id) {
    const results = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, id))
    if (!results[0]) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(await buildDealJSON(db, results[0])) }
  }
  return { error: 'ENOENT' }
}

async function readActivityPath(
  db: DB,
  sub: string,
): Promise<Record<string, unknown>> {
  const id = extractId(sub)
  if (id) {
    const results = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, id))
    if (!results[0]) {
      return { error: 'ENOENT' }
    }
    return { data: JSON.stringify(buildActivityJSON(results[0])) }
  }
  return { error: 'ENOENT' }
}

// ── search ──

async function handleSearch(
  db: DB,
  query: string,
): Promise<Record<string, unknown>> {
  const contacts = await db.select().from(schema.contacts)
  const companies = await db.select().from(schema.companies)
  const deals = await db.select().from(schema.deals)

  const results: Record<string, unknown>[] = []

  for (const c of contacts) {
    if (
      c.name?.includes(query) ||
      (safeJSON(c.emails) as string[]).some((e) => e.includes(query))
    ) {
      results.push({
        type: 'contact',
        id: c.id,
        name: c.name,
        emails: safeJSON(c.emails),
      })
    }
  }
  for (const co of companies) {
    if (co.name?.includes(query)) {
      results.push({ type: 'company', id: co.id, name: co.name })
    }
  }
  for (const d of deals) {
    if (d.title?.includes(query)) {
      results.push({ type: 'deal', id: d.id, title: d.title })
    }
  }

  return { data: JSON.stringify(results) }
}

// ── write ──

async function handleWrite(
  db: DB,
  config: CRMConfig,
  p: string,
  rawData: string,
): Promise<Record<string, unknown>> {
  // Parse JSON
  let data: Record<string, unknown>
  try {
    data = JSON.parse(rawData)
  } catch {
    return { error: 'EINVAL', msg: 'malformed JSON' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'EINVAL', msg: 'expected JSON object' }
  }

  if (p.startsWith('contacts/')) {
    return await writeContact(db, config, p.slice('contacts/'.length), data)
  }
  if (p.startsWith('companies/')) {
    return await writeCompany(db, config, p.slice('companies/'.length), data)
  }
  if (p.startsWith('deals/')) {
    return await writeDeal(db, config, p.slice('deals/'.length), data)
  }
  if (p.startsWith('activities/')) {
    return await writeActivity(db, config, p.slice('activities/'.length), data)
  }

  return { error: 'EPERM' }
}

async function writeContact(
  db: DB,
  config: CRMConfig,
  sub: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Validate fields
  const customFieldKeys: string[] = []
  for (const key of Object.keys(data)) {
    if (!CONTACT_WRITE_FIELDS.has(key)) {
      return { error: 'EINVAL', msg: `unknown field: ${key}` }
    }
    if (
      [
        'title',
        'department',
        'source',
        'notes',
        'address',
        'birthday',
        'website',
        'job_title',
        'role',
        'position',
      ].includes(key)
    ) {
      customFieldKeys.push(key)
    }
  }

  // emails type check
  if (data.emails !== undefined && !Array.isArray(data.emails)) {
    return { error: 'EINVAL', msg: 'emails must be an array' }
  }
  if (data.phones !== undefined && !Array.isArray(data.phones)) {
    return { error: 'EINVAL', msg: 'phones must be an array' }
  }

  // Normalize phones
  let phones = (data.phones || data.phone) as string[] | string | undefined
  if (typeof phones === 'string') {
    phones = [phones]
  }
  if (phones && Array.isArray(phones)) {
    const normalized: string[] = []
    for (const p of phones) {
      try {
        normalized.push(normalizePhone(p, config.phone.default_country))
      } catch {
        return { error: 'EINVAL', msg: `invalid phone: ${p}` }
      }
    }
    phones = normalized
  }

  // Check if update or create
  const id = extractId(sub)
  const now = new Date().toISOString()

  // Build custom_fields
  let customFields = (data.custom_fields || {}) as Record<string, unknown>
  for (const key of customFieldKeys) {
    customFields = { ...customFields, [key]: data[key] }
  }
  const cfStr =
    Object.keys(customFields).length > 0 ? JSON.stringify(customFields) : '{}'

  // Handle emails/email alias
  let emails = data.emails as string[] | undefined
  if (!emails && data.email) {
    emails = Array.isArray(data.email) ? data.email : [data.email as string]
  }

  // Handle companies/company alias — accept enriched [{id,name}] format too
  let companies = data.companies as unknown[] | undefined
  if (!companies && data.company) {
    companies = Array.isArray(data.company) ? data.company : [data.company]
  }
  if (companies && Array.isArray(companies)) {
    const resolved: string[] = []
    for (const c of companies) {
      if (typeof c === 'object' && c !== null && 'id' in c) {
        resolved.push((c as { id: string }).id)
      } else if (typeof c === 'string' && c.startsWith('co_')) {
        resolved.push(c)
      } else if (typeof c === 'string') {
        const coId = await getOrCreateCompanyId(db, c)
        resolved.push(coId)
      }
    }
    companies = resolved
  }

  if (id) {
    // Update existing
    const existing = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id))
    if (!existing[0]) {
      return { error: 'ENOENT' }
    }

    await db
      .update(schema.contacts)
      .set({
        name: (data.name as string) || existing[0].name,
        emails: JSON.stringify(emails || safeJSON(existing[0].emails)),
        phones: JSON.stringify(phones || safeJSON(existing[0].phones)),
        companies: JSON.stringify(companies ?? safeJSON(existing[0].companies)),
        linkedin:
          data.linkedin === undefined
            ? existing[0].linkedin
            : (data.linkedin as string),
        x: data.x === undefined ? existing[0].x : (data.x as string),
        bluesky:
          data.bluesky === undefined
            ? existing[0].bluesky
            : (data.bluesky as string),
        telegram:
          data.telegram === undefined
            ? existing[0].telegram
            : (data.telegram as string),
        tags:
          data.tags === undefined
            ? existing[0].tags
            : JSON.stringify(data.tags),
        custom_fields: cfStr,
        updated_at: now,
      })
      .where(eq(schema.contacts.id, id))

    return { ok: true }
  }

  // Create new
  if (!data.name) {
    return { error: 'EINVAL', msg: 'missing required field: name' }
  }

  const newId = makeId('ct')
  await db.insert(schema.contacts).values({
    id: newId,
    name: data.name as string,
    emails: JSON.stringify(emails || []),
    phones: JSON.stringify(phones || []),
    companies: JSON.stringify(companies || []),
    linkedin: (data.linkedin as string) || null,
    x: (data.x as string) || null,
    bluesky: (data.bluesky as string) || null,
    telegram: (data.telegram as string) || null,
    tags: JSON.stringify((data.tags as string[]) || []),
    custom_fields: cfStr,
    created_at: now,
    updated_at: now,
  })

  return { ok: true }
}

async function writeCompany(
  db: DB,
  config: CRMConfig,
  sub: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const customFieldKeys: string[] = []
  for (const key of Object.keys(data)) {
    if (!COMPANY_WRITE_FIELDS.has(key)) {
      return { error: 'EINVAL', msg: `unknown field: ${key}` }
    }
    if (
      [
        'industry',
        'address',
        'notes',
        'source',
        'description',
        'size',
      ].includes(key)
    ) {
      customFieldKeys.push(key)
    }
  }

  // Normalize phones
  let phones = (data.phones || data.phone) as string[] | string | undefined
  if (typeof phones === 'string') {
    phones = [phones]
  }
  if (phones && Array.isArray(phones)) {
    const normalized: string[] = []
    for (const p of phones) {
      try {
        normalized.push(normalizePhone(p, config.phone.default_country))
      } catch {
        return { error: 'EINVAL', msg: `invalid phone: ${p}` }
      }
    }
    phones = normalized
  }

  let customFields = (data.custom_fields || {}) as Record<string, unknown>
  for (const key of customFieldKeys) {
    customFields = { ...customFields, [key]: data[key] }
  }
  const cfStr =
    Object.keys(customFields).length > 0 ? JSON.stringify(customFields) : '{}'

  let websites = data.websites as string[] | undefined
  if (!websites && data.website) {
    websites = Array.isArray(data.website)
      ? data.website
      : [data.website as string]
  }

  const id = extractId(sub)
  const now = new Date().toISOString()

  if (id) {
    const existing = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, id))
    if (!existing[0]) {
      return { error: 'ENOENT' }
    }
    await db
      .update(schema.companies)
      .set({
        name: (data.name as string) || existing[0].name,
        websites: JSON.stringify(websites || safeJSON(existing[0].websites)),
        phones: JSON.stringify(phones || safeJSON(existing[0].phones)),
        tags:
          data.tags === undefined
            ? existing[0].tags
            : JSON.stringify(data.tags),
        custom_fields: cfStr,
        updated_at: now,
      })
      .where(eq(schema.companies.id, id))
    return { ok: true }
  }

  if (!data.name) {
    return { error: 'EINVAL', msg: 'missing required field: name' }
  }

  const newId = makeId('co')
  await db.insert(schema.companies).values({
    id: newId,
    name: data.name as string,
    websites: JSON.stringify(websites || []),
    phones: JSON.stringify(phones || []),
    tags: JSON.stringify((data.tags as string[]) || []),
    custom_fields: cfStr,
    created_at: now,
    updated_at: now,
  })

  return { ok: true }
}

async function writeDeal(
  db: DB,
  config: CRMConfig,
  sub: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (const key of Object.keys(data)) {
    if (!DEAL_WRITE_FIELDS.has(key)) {
      return { error: 'EINVAL', msg: `unknown field: ${key}` }
    }
  }

  const id = extractId(sub)
  const now = new Date().toISOString()

  if (id) {
    const existing = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, id))
    if (!existing[0]) {
      return { error: 'ENOENT' }
    }

    // Track stage change
    if (data.stage && data.stage !== existing[0].stage) {
      const acId = makeId('ac')
      await db.insert(schema.activities).values({
        id: acId,
        type: 'stage-change',
        body: `from ${existing[0].stage} to ${data.stage}`,
        deal: id,
        contacts: '[]',
        company: null,
        custom_fields: '{}',
        created_at: now,
      })
    }

    await db
      .update(schema.deals)
      .set({
        title: (data.title as string) || existing[0].title,
        value:
          data.value === undefined ? existing[0].value : (data.value as number),
        stage: (data.stage as string) || existing[0].stage,
        contacts:
          data.contacts === undefined
            ? existing[0].contacts
            : JSON.stringify(
                Array.isArray(data.contacts)
                  ? (data.contacts as unknown[]).map((c: unknown) =>
                      typeof c === 'object' && c !== null && 'id' in c
                        ? (c as { id: string }).id
                        : c,
                    )
                  : data.contacts,
              ),
        company:
          data.company === undefined
            ? existing[0].company
            : extractCompanyId(data.company),
        expected_close:
          data.expected_close === undefined
            ? existing[0].expected_close
            : (data.expected_close as string),
        probability:
          data.probability === undefined
            ? existing[0].probability
            : (data.probability as number),
        tags:
          data.tags === undefined
            ? existing[0].tags
            : JSON.stringify(data.tags),
        custom_fields:
          data.custom_fields === undefined
            ? existing[0].custom_fields
            : JSON.stringify(data.custom_fields),
        updated_at: now,
      })
      .where(eq(schema.deals.id, id))

    return { ok: true }
  }

  if (!data.title) {
    return { error: 'EINVAL', msg: 'missing required field: title' }
  }

  const newId = makeId('dl')
  await db.insert(schema.deals).values({
    id: newId,
    title: data.title as string,
    value: (data.value as number) || null,
    stage: (data.stage as string) || config.pipeline.stages[0] || 'lead',
    contacts: JSON.stringify((data.contacts as string[]) || []),
    company: (data.company as string) || null,
    expected_close: (data.expected_close as string) || null,
    probability: (data.probability as number) || null,
    tags: JSON.stringify((data.tags as string[]) || []),
    custom_fields: JSON.stringify(
      (data.custom_fields as Record<string, unknown>) || {},
    ),
    created_at: now,
    updated_at: now,
  })

  return { ok: true }
}

async function writeActivity(
  db: DB,
  config: CRMConfig,
  _sub: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (const key of Object.keys(data)) {
    if (!ACTIVITY_WRITE_FIELDS.has(key)) {
      return { error: 'EINVAL', msg: `unknown field: ${key}` }
    }
  }

  if (!data.type) {
    return { error: 'EINVAL', msg: 'missing required field: type' }
  }

  // Build contacts array
  const contacts: string[] = []
  if (data.contacts && Array.isArray(data.contacts)) {
    contacts.push(...(data.contacts as string[]))
  } else if (data.contact) {
    contacts.push(data.contact as string)
  }
  if (data.entity_ref && contacts.length === 0) {
    const resolved = await resolveContact(db, data.entity_ref as string, config)
    if (resolved) {
      contacts.push(resolved.id)
    }
  }

  const body = (data.note || data.body || '') as string
  const now = new Date().toISOString()

  const newId = makeId('ac')
  await db.insert(schema.activities).values({
    id: newId,
    type: data.type as string,
    body,
    contacts: JSON.stringify(contacts),
    company: (data.company as string) || null,
    deal: (data.deal as string) || null,
    custom_fields: JSON.stringify(
      (data.custom_fields as Record<string, unknown>) || {},
    ),
    created_at: now,
  })

  return { ok: true }
}

// ── unlink ──

async function handleUnlink(
  db: DB,
  p: string,
): Promise<Record<string, unknown>> {
  // Only allow delete from entity root dirs, not from _by-* indexes
  if (
    p.startsWith('contacts/_by-') ||
    p.startsWith('companies/_by-') ||
    p.startsWith('deals/_by-')
  ) {
    return { error: 'EPERM' }
  }

  if (p.startsWith('contacts/')) {
    const file = p.slice('contacts/'.length)
    const id = extractId(file)
    if (id) {
      await db.delete(schema.contacts).where(eq(schema.contacts.id, id))
      await removeSearchIndex(db, id)
      return { ok: true }
    }
  }

  if (p.startsWith('companies/')) {
    const file = p.slice('companies/'.length)
    const id = extractId(file)
    if (id) {
      await db.delete(schema.companies).where(eq(schema.companies.id, id))
      await removeSearchIndex(db, id)
      return { ok: true }
    }
  }

  if (p.startsWith('deals/')) {
    const file = p.slice('deals/'.length)
    const id = extractId(file)
    if (id) {
      await db.delete(schema.deals).where(eq(schema.deals.id, id))
      await removeSearchIndex(db, id)
      return { ok: true }
    }
  }

  if (p.startsWith('activities/')) {
    const file = p.slice('activities/'.length)
    const id = extractId(file)
    if (id) {
      await db.delete(schema.activities).where(eq(schema.activities.id, id))
      await removeSearchIndex(db, id)
      return { ok: true }
    }
  }

  return { error: 'EPERM' }
}

// ── Main: start Unix socket server ──

export async function startDaemon(daemonArgs: string[]) {
  if (daemonArgs.length < 2) {
    console.error(
      'Usage: crm __daemon <socket-path> <db-path> [stage1 stage2 ...]',
    )
    process.exit(1)
  }

  const socketPath = daemonArgs[0]
  const dbPath = daemonArgs[1]
  const stages = daemonArgs.slice(2)

  if (stages.length === 0) {
    stages.push(
      'lead',
      'qualified',
      'proposal',
      'negotiation',
      'closed-won',
      'closed-lost',
    )
  }

  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath)
  }

  const db = await openDB(dbPath)
  const config = loadConfig({ dbPath })
  // Override DB path to match what we were given
  config.database.path = dbPath

  const server = createServer((conn: Socket) => {
    let buffer = ''

    conn.on('data', (chunk) => {
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (line.trim()) {
          processLine(conn, db, config, stages, line)
        }
      }
    })

    conn.on('error', () => {
      // Client disconnected
    })
  })

  server.listen(socketPath, () => {
    // Signal readiness by writing to stdout
    process.stdout.write('READY\n')
  })

  // Graceful shutdown
  process.on('SIGTERM', () => {
    server.close()
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
    process.exit(0)
  })
  process.on('SIGINT', () => {
    server.close()
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
    process.exit(0)
  })
}

async function processLine(
  conn: Socket,
  db: DB,
  config: CRMConfig,
  stages: string[],
  line: string,
) {
  try {
    const req = JSON.parse(line)
    const resp = await handleRequest(db, config, stages, req)
    conn.write(`${JSON.stringify(resp)}\n`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    conn.write(`${JSON.stringify({ error: 'EIO', msg })}\n`)
  }
}

// Allow direct invocation for development: bun run fuse-daemon.ts <args>
if (process.argv[1]?.endsWith('fuse-daemon.ts')) {
  startDaemon(process.argv.slice(2)).catch((err) => {
    console.error('fuse-daemon fatal:', err)
    process.exit(1)
  })
}
