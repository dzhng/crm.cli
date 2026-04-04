import { eq } from 'drizzle-orm'

import type { DB } from './db'
import * as schema from './drizzle-schema'
import { safeJSON } from './format.ts'
import {
  extractPhoneDigits,
  phoneMatchesByDigits,
  tryExtractSocialHandle,
  tryNormalizePhone,
  tryNormalizeWebsite,
} from './normalize.ts'

export async function resolveContact(
  db: DB,
  ref: string,
  config?: any,
): Promise<any | null> {
  // By ID
  if (ref.startsWith('ct_')) {
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, ref))
    return results[0] || null
  }

  // By email
  if (ref.includes('@') && !ref.includes('/')) {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    // First try as email
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      const emails: string[] = safeJSON(c.emails)
      if (emails.some((e) => e.toLowerCase() === ref.toLowerCase())) {
        return c
      }
    }
    // Try as social handle with @ prefix
    for (const c of all) {
      if (
        c.linkedin === handle ||
        c.x === handle ||
        c.bluesky === handle ||
        c.telegram === handle
      ) {
        return c
      }
    }
    return null
  }

  // Try social URL extraction
  const extracted = tryExtractSocialHandle(ref)
  if (extracted) {
    const col = extracted.platform as 'linkedin' | 'x' | 'bluesky' | 'telegram'
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts[col], extracted.handle))
    if (results[0]) {
      return results[0]
    }
  }

  // Try phone normalization
  const phoneNorm = tryNormalizePhone(ref, config?.phone?.default_country)
  if (phoneNorm) {
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      const phones: string[] = safeJSON(c.phones)
      if (phones.includes(phoneNorm)) {
        return c
      }
    }
  }

  // Try digit-based phone matching
  const digits = extractPhoneDigits(ref)
  if (digits.length >= 7) {
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      const phones: string[] = safeJSON(c.phones)
      for (const p of phones) {
        if (phoneMatchesByDigits(p, digits)) {
          return c
        }
      }
    }
  }

  // Try as raw social handle (no URL)
  if (!(ref.includes('.') || ref.includes('/'))) {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      if (
        c.linkedin === handle ||
        c.x === handle ||
        c.bluesky === handle ||
        c.telegram === handle
      ) {
        return c
      }
    }
  }

  // Try social handle with dots (like bsky handles)
  {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      if (
        c.linkedin === handle ||
        c.x === handle ||
        c.bluesky === handle ||
        c.telegram === handle
      ) {
        return c
      }
    }
  }

  return null
}

export async function resolveCompany(
  db: DB,
  ref: string,
  config?: any,
): Promise<any | null> {
  // By ID
  if (ref.startsWith('co_')) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, ref))
    return results[0] || null
  }

  // By website (normalize and check)
  const all = await db.select().from(schema.companies)
  const normalizedWeb = tryNormalizeWebsite(ref)
  if (normalizedWeb) {
    for (const co of all) {
      const websites: string[] = safeJSON(co.websites)
      if (websites.some((w) => w === normalizedWeb)) {
        return co
      }
    }
  }

  // By phone
  const phoneNorm = tryNormalizePhone(ref, config?.phone?.default_country)
  if (phoneNorm) {
    for (const co of all) {
      const phones: string[] = safeJSON(co.phones)
      if (phones.includes(phoneNorm)) {
        return co
      }
    }
  }

  // By digit matching
  const digits = extractPhoneDigits(ref)
  if (digits.length >= 7) {
    for (const co of all) {
      const phones: string[] = safeJSON(co.phones)
      for (const p of phones) {
        if (phoneMatchesByDigits(p, digits)) {
          return co
        }
      }
    }
  }

  // By name
  for (const co of all) {
    if (co.name === ref) {
      return co
    }
  }

  return null
}

export async function resolveDeal(db: DB, ref: string): Promise<any | null> {
  if (ref.startsWith('dl_')) {
    const results = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, ref))
    return results[0] || null
  }
  return null
}

export async function resolveEntity(
  db: DB,
  ref: string,
  config?: any,
): Promise<{ type: string; entity: any } | null> {
  // Try contact first
  const contact = await resolveContact(db, ref, config)
  if (contact) {
    return { type: 'contact', entity: contact }
  }

  // Try company
  const company = await resolveCompany(db, ref, config)
  if (company) {
    return { type: 'company', entity: company }
  }

  // Try deal
  const deal = await resolveDeal(db, ref)
  if (deal) {
    return { type: 'deal', entity: deal }
  }

  return null
}

export async function resolveCompanyForLink(
  db: DB,
  ref: string,
  _config?: any,
): Promise<any | null> {
  // Try by ID
  if (ref.startsWith('co_')) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, ref))
    return results[0] || null
  }

  // Try by website
  const all = await db.select().from(schema.companies)
  const normalizedWeb = tryNormalizeWebsite(ref)
  if (normalizedWeb) {
    for (const co of all) {
      const websites: string[] = safeJSON(co.websites)
      if (websites.some((w) => w === normalizedWeb)) {
        return co
      }
    }
  }

  // Try by name
  for (const co of all) {
    if (co.name === ref) {
      return co
    }
  }

  return null
}

export async function resolveContactForLink(
  db: DB,
  ref: string,
  config?: any,
): Promise<any | null> {
  return await resolveContact(db, ref, config)
}
