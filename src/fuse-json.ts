import { eq } from 'drizzle-orm'

import type { CRMConfig } from './config'
import type { DB } from './db'
import type { Activity, Company, Contact, Deal } from './drizzle-schema'
import * as schema from './drizzle-schema'
import { safeJSON } from './format'

export const LLM_TXT = `# CRM Filesystem

This directory is a live view of a CRM database, powered by crm.cli.
All data is JSON. Changes made here are written back to the database.

## Structure

contacts/                    → One JSON file per contact
  _by-email/                 → Lookup by email address
  _by-phone/                 → Lookup by E.164 phone (+12125551234.json)
  _by-linkedin/              → Lookup by LinkedIn handle
  _by-x/                     → Lookup by X/Twitter handle
  _by-bluesky/               → Lookup by Bluesky handle
  _by-telegram/              → Lookup by Telegram handle
  _by-company/               → Contacts grouped by company name
  _by-tag/                   → Contacts grouped by tag

companies/                   → One JSON file per company
  _by-website/               → Lookup by website domain
  _by-phone/                 → Lookup by E.164 phone
  _by-tag/                   → Companies grouped by tag

deals/                       → One JSON file per deal
  _by-stage/                 → Deals grouped by pipeline stage
  _by-company/               → Deals grouped by company name
  _by-tag/                   → Deals grouped by tag

activities/                  → One JSON file per activity (note, email, call, meeting)
  _by-contact/               → Activities grouped by contact
  _by-company/               → Activities grouped by company
  _by-deal/                  → Activities grouped by deal
  _by-type/                  → Activities grouped by type

reports/                     → Pre-computed analytics (pipeline, forecast, velocity, stale, won, lost, conversion)
search/                      → Write a query file, read back JSON results
pipeline.json                → Pipeline stage counts and values
tags.json                    → All tags with usage counts

## Reading data

Each entity file (e.g. contacts/ct_01J8Z...jane-doe.json) is self-contained JSON
with all fields, linked entities, and recent activity. The _by-* directories contain
copies of the same files, organized for lookup. Use ls + cat to explore.

## Writing data

Write a JSON file to a top-level directory to create or update an entity:

  echo '{"name":"Jane Doe","emails":["jane@acme.com"]}' > contacts/new.json

The filename doesn't matter for writes — the CRM assigns an ID and renames the file.
To update, write to the existing filename. Fields you omit are left unchanged.

## Search

Read a file in search/ where the filename is your query:

  cat search/jane.json           → contacts/companies/deals matching "jane"
  cat search/fintech-cto.json    → results matching "fintech-cto"

## Phones

Phones are stored in E.164 format (+12125551234). The _by-phone directories use E.164
filenames. When writing, any common format is accepted and normalized automatically.

## Tips for agents

- Start with \`ls\` at the root to see what's available
- Use _by-email, _by-phone, _by-linkedin for fast lookups instead of scanning all files
- Read pipeline.json for a quick overview of deal flow
- Read reports/ for pre-computed analytics — no need to calculate from raw data
- All JSON files are self-contained — no need to join across files
- The search/ directory accepts natural language queries
`

export function slugify(name: string): string {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function contactFilename(c: Contact): string {
  return `${c.id}...${slugify(c.name || '')}.json`
}

export function companyFilename(co: Company): string {
  return `${co.id}...${slugify(co.name || '')}.json`
}

export function dealFilename(d: Deal): string {
  return `${d.id}...${slugify(d.title || '')}.json`
}

export function activityFilename(a: Activity): string {
  const dateStr = (a.created_at || '').slice(0, 10)
  return `${a.id}...${a.type || 'unknown'}-${dateStr}.json`
}

export async function buildContactJSON(
  db: DB,
  c: Contact,
  config: CRMConfig,
): Promise<Record<string, unknown>> {
  const emails: string[] = safeJSON(c.emails)
  const phones: string[] = safeJSON(c.phones)
  const companyIds: string[] = safeJSON(c.companies)
  const tags: string[] = safeJSON(c.tags)
  const customFields = safeJSON(c.custom_fields) || {}

  const allCompanies = await db.select().from(schema.companies)
  const linkedCompanies = companyIds
    .map((id) => {
      const co = allCompanies.find((x) => x.id === id)
      return co ? { id: co.id, name: co.name } : { id }
    })
    .filter(Boolean)

  const allDeals = await db.select().from(schema.deals)
  const linkedDeals = allDeals
    .filter((d) => {
      const contacts: string[] = safeJSON(d.contacts)
      return contacts.includes(c.id)
    })
    .map((d) => ({ id: d.id, title: d.title, stage: d.stage, value: d.value }))

  const activities = await db.select().from(schema.activities)
  const contactActivities = activities
    .filter((a) => {
      const contacts: string[] = safeJSON(a.contacts)
      return contacts.includes(c.id)
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, config.mount.max_recent_activity)
    .map((a) => ({
      id: a.id,
      type: a.type,
      note: a.body,
      created_at: a.created_at,
    }))

  return {
    id: c.id,
    name: c.name,
    emails,
    phones,
    companies: linkedCompanies,
    linkedin: c.linkedin,
    x: c.x,
    bluesky: c.bluesky,
    telegram: c.telegram,
    tags,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    deals: linkedDeals,
    recent_activity: contactActivities,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }
}

export async function buildCompanyJSON(
  db: DB,
  co: Company,
): Promise<Record<string, unknown>> {
  const websites: string[] = safeJSON(co.websites)
  const phones: string[] = safeJSON(co.phones)
  const tags: string[] = safeJSON(co.tags)
  const customFields = safeJSON(co.custom_fields) || {}

  const allContacts = await db.select().from(schema.contacts)
  const linkedContacts = allContacts
    .filter((c) => {
      const companies: string[] = safeJSON(c.companies)
      return companies.includes(co.id)
    })
    .map((c) => ({ id: c.id, name: c.name }))

  const allDeals = await db.select().from(schema.deals)
  const linkedDeals = allDeals
    .filter((d) => d.company === co.id)
    .map((d) => ({ id: d.id, title: d.title, stage: d.stage, value: d.value }))

  return {
    id: co.id,
    name: co.name,
    websites,
    phones,
    tags,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    contacts: linkedContacts,
    deals: linkedDeals,
    created_at: co.created_at,
    updated_at: co.updated_at,
  }
}

export async function buildDealJSON(
  db: DB,
  d: Deal,
): Promise<Record<string, unknown>> {
  const contactIds: string[] = safeJSON(d.contacts)
  const tags: string[] = safeJSON(d.tags)
  const customFields = safeJSON(d.custom_fields) || {}

  const allContacts = await db.select().from(schema.contacts)
  const linkedContacts = contactIds
    .map((id) => {
      const c = allContacts.find((x) => x.id === id)
      return c ? { id: c.id, name: c.name } : { id }
    })
    .filter(Boolean)

  let companyObj: { id: string; name: string | null } | undefined
  if (d.company) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, d.company))
    if (results[0]) {
      companyObj = { id: results[0].id, name: results[0].name }
    }
  }

  const activities = await db.select().from(schema.activities)
  const stageChanges = activities
    .filter((a) => a.deal === d.id && a.type === 'stage-change')
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map((a) => ({ body: a.body, created_at: a.created_at }))

  // Derive initial stage from first stage-change body or current stage
  // Body format: "from oldStage to newStage" or "from oldStage to newStage | note"
  const firstChange = stageChanges[0]
  let initialStage = d.stage
  if (firstChange?.body) {
    const match = firstChange.body.match(/from (\S+) to/)
    if (match) {
      initialStage = match[1]
    }
  }

  const stageHistory = [
    { stage: initialStage, at: d.created_at },
    ...stageChanges.map((sc) => {
      const match = sc.body?.match(/to (\S+)/)
      return { stage: match ? match[1] : '', at: sc.created_at }
    }),
  ]

  return {
    id: d.id,
    title: d.title,
    value: d.value,
    stage: d.stage,
    contacts: linkedContacts,
    company: companyObj,
    expected_close: d.expected_close,
    probability: d.probability,
    tags,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    stage_history: stageHistory,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }
}

export function buildActivityJSON(a: Activity): Record<string, unknown> {
  const customFields = safeJSON(a.custom_fields) || {}
  return {
    id: a.id,
    type: a.type,
    body: a.body,
    contacts: safeJSON(a.contacts),
    company: a.company,
    deal: a.deal,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    created_at: a.created_at,
  }
}
