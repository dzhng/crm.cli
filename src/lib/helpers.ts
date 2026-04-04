import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { type CRMConfig, loadConfig } from '../config'
import type { DB } from '../db'
import { openDB, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { companyToRow, contactToRow, dealToRow, safeJSON } from '../format'
import { formatPhone } from '../normalize'
import { resolveCompanyForLink } from '../resolve'

// ── Global option extraction ──
const rawArgv = process.argv.slice(2)
export let gDb: string | undefined,
  gConfig: string | undefined,
  gFmt: string | undefined
export const cleanArgv: string[] = []
let _argIdx = 0
while (_argIdx < rawArgv.length) {
  const arg = rawArgv[_argIdx]
  if (arg === '--db') {
    _argIdx++
    gDb = rawArgv[_argIdx]
  } else if (arg === '--config') {
    _argIdx++
    gConfig = rawArgv[_argIdx]
  } else if (arg === '--format') {
    _argIdx++
    gFmt = rawArgv[_argIdx]
  } else if (arg !== '--no-color' && arg !== '--verbose') {
    cleanArgv.push(arg)
  }
  _argIdx++
}

export async function getCtx() {
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  const db = await openDB(config.database.path)
  return { config, db, fmt: config.defaults.format }
}

export function makeId(prefix: string) {
  return `${prefix}_${ulid()}`
}
export function now() {
  return new Date().toISOString()
}
export function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}
export function collect(v: string, prev: string[]) {
  prev.push(v)
  return prev
}

export function parseKV(arr: string[]): Record<string, string> {
  const r: Record<string, string> = {}
  for (const s of arr || []) {
    const i = s.indexOf('=')
    if (i > 0) {
      r[s.slice(0, i)] = s.slice(i + 1)
    }
  }
  return r
}

export async function getOrCreateCompany(
  db: DB,
  ref: string,
  config: CRMConfig,
): Promise<string> {
  const co = await resolveCompanyForLink(db, ref, config)
  if (co) {
    return co.name
  }
  const cid = makeId('co')
  const n = now()
  await db.insert(schema.companies).values({
    id: cid,
    name: ref,
    websites: '[]',
    phones: '[]',
    tags: '[]',
    custom_fields: '{}',
    created_at: n,
    updated_at: n,
  })
  await upsertSearchIndex(db, 'company', cid, ref)
  return ref
}

export async function getOrCreateCompanyId(
  db: DB,
  ref: string,
  config: CRMConfig,
): Promise<string> {
  const co = await resolveCompanyForLink(db, ref, config)
  if (co) {
    return co.id
  }
  const cid = makeId('co')
  const n = now()
  await db.insert(schema.companies).values({
    id: cid,
    name: ref,
    websites: '[]',
    phones: '[]',
    tags: '[]',
    custom_fields: '{}',
    created_at: n,
    updated_at: n,
  })
  await upsertSearchIndex(db, 'company', cid, ref)
  return cid
}

export async function checkDupeEmail(
  db: DB,
  email: string,
  excludeId?: string,
) {
  const all = await db.select().from(schema.contacts)
  for (const c of all) {
    if (excludeId && c.id === excludeId) {
      continue
    }
    const emails: string[] = safeJSON(c.emails)
    if (emails.some((e) => e.toLowerCase() === email.toLowerCase())) {
      die(
        `Error: duplicate email "${email}" — already belongs to ${c.name} (${c.id})`,
      )
    }
  }
}

export async function checkDupePhone(
  db: DB,
  phone: string,
  table: string,
  excludeId?: string,
) {
  const all =
    table === 'contacts'
      ? await db.select().from(schema.contacts)
      : await db.select().from(schema.companies)
  for (const c of all) {
    if (excludeId && c.id === excludeId) {
      continue
    }
    const phones: string[] = safeJSON(c.phones)
    if (phones.includes(phone)) {
      die(
        `Error: duplicate phone "${phone}" — already belongs to ${(c as any).name || (c as any).title} (${c.id})`,
      )
    }
  }
}

export async function checkDupeWebsite(
  db: DB,
  website: string,
  excludeId?: string,
) {
  const all = await db.select().from(schema.companies)
  for (const co of all) {
    if (excludeId && co.id === excludeId) {
      continue
    }
    const websites: string[] = safeJSON(co.websites)
    if (websites.includes(website)) {
      die(
        `Error: duplicate website "${website}" — already belongs to ${co.name} (${co.id})`,
      )
    }
  }
}

export async function checkDupeSocial(
  db: DB,
  platform: string,
  handle: string,
  excludeId?: string,
) {
  const col = platform as 'linkedin' | 'x' | 'bluesky' | 'telegram'
  const existing = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts[col], handle))
  const match = existing[0]
  if (match && match.id !== excludeId) {
    die(
      `Error: duplicate ${platform} handle "${handle}" — already belongs to ${match.name} (${match.id})`,
    )
  }
}

export function buildContactSearch(c: any): string {
  return [
    c.name,
    c.emails,
    c.phones,
    c.companies,
    c.linkedin,
    c.x,
    c.bluesky,
    c.telegram,
    JSON.stringify(safeJSON(c.custom_fields)),
    c.tags,
  ]
    .filter(Boolean)
    .join(' ')
}

export function buildCompanySearch(co: any): string {
  return [
    co.name,
    co.websites,
    co.phones,
    JSON.stringify(safeJSON(co.custom_fields)),
    co.tags,
  ]
    .filter(Boolean)
    .join(' ')
}

export function buildDealSearch(d: any): string {
  return [d.title, d.stage, JSON.stringify(safeJSON(d.custom_fields)), d.tags]
    .filter(Boolean)
    .join(' ')
}

export async function contactDetail(
  db: DB,
  c: any,
  config: CRMConfig,
): Promise<any> {
  const row = contactToRow(c, config)
  const phones: string[] = safeJSON(c.phones)
  row._display_phones = phones.map((p) =>
    formatPhone(p, config.phone.display, config.phone.default_country),
  )
  const allDeals = await db.select().from(schema.deals)
  row.deals = allDeals
    .filter((d) => {
      const contacts: string[] = safeJSON(d.contacts)
      return contacts.includes(c.id)
    })
    .map((d) => ({ id: d.id, title: d.title, stage: d.stage, value: d.value }))
  return row
}

export async function companyDetail(
  db: DB,
  co: any,
  config: CRMConfig,
): Promise<any> {
  const row = companyToRow(co, config)
  const phones: string[] = safeJSON(co.phones)
  row._display_phones = phones.map((p) =>
    formatPhone(p, config.phone.display, config.phone.default_country),
  )
  const allContacts = await db.select().from(schema.contacts)
  row.contacts = allContacts
    .filter((ct) => {
      const companies: string[] = safeJSON(ct.companies)
      return companies.includes(co.name)
    })
    .map((ct) => ({ id: ct.id, name: ct.name, emails: safeJSON(ct.emails) }))
  const allDeals = await db
    .select()
    .from(schema.deals)
    .where(eq(schema.deals.company, co.id))
  row.deals = allDeals.map((d) => ({
    id: d.id,
    title: d.title,
    stage: d.stage,
    value: d.value,
  }))
  return row
}

export async function dealDetail(
  db: DB,
  d: any,
  config: CRMConfig,
): Promise<any> {
  const row = dealToRow(d, config)
  const contactIds: string[] = safeJSON(d.contacts)
  const contactPromises = contactIds.map(async (cid) => {
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, cid))
    const ct = results[0]
    return ct ? { id: ct.id, name: ct.name, emails: safeJSON(ct.emails) } : null
  })
  row.contacts = (await Promise.all(contactPromises)).filter(Boolean)
  if (d.company) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, d.company))
    const co = results[0]
    row.company = co ? { id: co.id, name: co.name } : null
  }
  const stageChanges = await db
    .select()
    .from(schema.activities)
    .where(
      sql`${schema.activities.deal} = ${d.id} AND ${schema.activities.type} = 'stage-change'`,
    )
    .orderBy(schema.activities.created_at)
  const history: { stage: string; at: string }[] = []
  if (stageChanges.length > 0) {
    const m = stageChanges[0].body.match(/from (\S+) to/)
    history.push({ stage: m ? m[1] : d.stage, at: d.created_at })
    for (const sc of stageChanges) {
      const tm = sc.body.match(/to (\S+)/)
      history.push({ stage: tm ? tm[1] : '', at: sc.created_at })
    }
  } else {
    history.push({ stage: d.stage, at: d.created_at })
  }
  row.stage_history = history
  row.notes = stageChanges
    .filter((a) => a.body.includes('|'))
    .map((a) => a.body)
  return row
}

export function showEntity(detail: any, fmt: string) {
  if (fmt === 'json') {
    console.log(JSON.stringify(detail, null, 2))
    return
  }
  const lines: string[] = []
  for (const [k, v] of Object.entries(detail)) {
    if (k === '_display_phones') {
      continue
    }
    if (v === null || v === undefined) {
      continue
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        continue
      }
      if (typeof v[0] === 'object') {
        lines.push(`${k}:`)
        for (const item of v) {
          lines.push(
            `  ${typeof item === 'object' ? JSON.stringify(item) : item}`,
          )
        }
      } else {
        lines.push(`${k}: ${v.join(', ')}`)
      }
    } else if (typeof v === 'object') {
      lines.push(`${k}:`)
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${sk}: ${sv}`)
      }
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  // Show phones with both raw E.164 and display format
  if (detail._display_phones?.length && detail.phones?.length) {
    const idx = lines.findIndex((l) => l.startsWith('phones:'))
    if (idx >= 0) {
      const combined = detail.phones.map((raw: string, i: number) => {
        const disp = detail._display_phones[i]
        return disp && disp !== raw ? `${raw} (${disp})` : raw
      })
      lines[idx] = `phones: ${combined.join(', ')}`
    }
  }
  console.log(lines.join('\n'))
}

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 1) {
    return []
  }
  const headers = parseCSVLine(lines[0])
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i])
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] || ''
    }
    rows.push(row)
  }
  return rows
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i++
        continue
      }
      if (ch === '"') {
        inQuotes = false
        continue
      }
      current += ch
    } else {
      if (ch === '"') {
        inQuotes = true
        continue
      }
      if (ch === ',') {
        result.push(current)
        current = ''
        continue
      }
      current += ch
    }
  }
  result.push(current)
  return result
}

export function levenshtein(a: string, b: string): number {
  const la = a.length,
    lb = b.length
  const dp: number[][] = Array.from({ length: la + 1 }, () =>
    new Array(lb + 1).fill(0),
  )
  for (let i = 0; i <= la; i++) {
    dp[i][0] = i
  }
  for (let j = 0; j <= lb; j++) {
    dp[0][j] = j
  }
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[la][lb]
}
