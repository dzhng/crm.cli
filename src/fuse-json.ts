import { eq } from 'drizzle-orm'

import type { CRMConfig } from './config'
import type { DB } from './db'
import type { Activity, Company, Contact, Deal } from './drizzle-schema'
import * as schema from './drizzle-schema'
import { safeJSON } from './format'

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
  const companyNames: string[] = safeJSON(c.companies)
  const tags: string[] = safeJSON(c.tags)
  const customFields = safeJSON(c.custom_fields) || {}

  const allCompanies = await db.select().from(schema.companies)
  const linkedCompanies = companyNames
    .map((name) => {
      const co = allCompanies.find((x) => x.name === name)
      return co ? { id: co.id, name: co.name } : { name }
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
    .filter((a) => a.contact === c.id)
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
      return companies.includes(co.name)
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
    contact: a.contact,
    company: a.company,
    deal: a.deal,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    created_at: a.created_at,
  }
}
