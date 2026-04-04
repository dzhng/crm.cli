import type { Database } from 'bun:sqlite'
import { normalizePhone, tryNormalizePhone, extractPhoneDigits, phoneMatchesByDigits, tryNormalizeWebsite, normalizeSocialHandle, tryExtractSocialHandle } from './normalize.ts'
import { safeJSON } from './format.ts'

export function resolveContact(db: Database, ref: string, config?: any): any | null {
  // By ID
  if (ref.startsWith('ct_')) {
    return db.query('SELECT * FROM contacts WHERE id = ?').get(ref)
  }

  // By email
  if (ref.includes('@') && !ref.includes('/')) {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    // First try as email
    const all = db.query('SELECT * FROM contacts').all() as any[]
    for (const c of all) {
      const emails: string[] = safeJSON(c.emails)
      if (emails.some((e) => e.toLowerCase() === ref.toLowerCase())) return c
    }
    // Try as social handle with @ prefix
    for (const c of all) {
      if (c.linkedin === handle || c.x === handle || c.bluesky === handle || c.telegram === handle) return c
    }
    return null
  }

  // Try social URL extraction
  const extracted = tryExtractSocialHandle(ref)
  if (extracted) {
    const col = extracted.platform
    const c = db.query(`SELECT * FROM contacts WHERE ${col} = ?`).get(extracted.handle)
    if (c) return c
  }

  // Try phone normalization
  const phoneNorm = tryNormalizePhone(ref, config?.phone?.default_country)
  if (phoneNorm) {
    const all = db.query('SELECT * FROM contacts').all() as any[]
    for (const c of all) {
      const phones: string[] = safeJSON(c.phones)
      if (phones.includes(phoneNorm)) return c
    }
  }

  // Try digit-based phone matching
  const digits = extractPhoneDigits(ref)
  if (digits.length >= 7) {
    const all = db.query('SELECT * FROM contacts').all() as any[]
    for (const c of all) {
      const phones: string[] = safeJSON(c.phones)
      for (const p of phones) {
        if (phoneMatchesByDigits(p, digits)) return c
      }
    }
  }

  // Try as raw social handle (no URL)
  if (!ref.includes('.') && !ref.includes('/')) {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    const all = db.query('SELECT * FROM contacts').all() as any[]
    for (const c of all) {
      if (c.linkedin === handle || c.x === handle || c.bluesky === handle || c.telegram === handle) return c
    }
  }

  // Try social handle with dots (like bsky handles)
  {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    const all = db.query('SELECT * FROM contacts').all() as any[]
    for (const c of all) {
      if (c.linkedin === handle || c.x === handle || c.bluesky === handle || c.telegram === handle) return c
    }
  }

  return null
}

export function resolveCompany(db: Database, ref: string, config?: any): any | null {
  // By ID
  if (ref.startsWith('co_')) {
    return db.query('SELECT * FROM companies WHERE id = ?').get(ref)
  }

  // By website (normalize and check)
  const all = db.query('SELECT * FROM companies').all() as any[]
  const normalizedWeb = tryNormalizeWebsite(ref)
  if (normalizedWeb) {
    for (const co of all) {
      const websites: string[] = safeJSON(co.websites)
      if (websites.some((w) => w === normalizedWeb)) return co
    }
  }

  // By phone
  const phoneNorm = tryNormalizePhone(ref, config?.phone?.default_country)
  if (phoneNorm) {
    for (const co of all) {
      const phones: string[] = safeJSON(co.phones)
      if (phones.includes(phoneNorm)) return co
    }
  }

  // By digit matching
  const digits = extractPhoneDigits(ref)
  if (digits.length >= 7) {
    for (const co of all) {
      const phones: string[] = safeJSON(co.phones)
      for (const p of phones) {
        if (phoneMatchesByDigits(p, digits)) return co
      }
    }
  }

  // By name
  for (const co of all) {
    if (co.name === ref) return co
  }

  return null
}

export function resolveDeal(db: Database, ref: string): any | null {
  if (ref.startsWith('dl_')) {
    return db.query('SELECT * FROM deals WHERE id = ?').get(ref)
  }
  return null
}

export function resolveEntity(db: Database, ref: string, config?: any): { type: string; entity: any } | null {
  // Try contact first
  const contact = resolveContact(db, ref, config)
  if (contact) return { type: 'contact', entity: contact }

  // Try company
  const company = resolveCompany(db, ref, config)
  if (company) return { type: 'company', entity: company }

  // Try deal
  const deal = resolveDeal(db, ref)
  if (deal) return { type: 'deal', entity: deal }

  return null
}

export function resolveCompanyForLink(db: Database, ref: string, config?: any): any | null {
  // Try by ID
  if (ref.startsWith('co_')) {
    return db.query('SELECT * FROM companies WHERE id = ?').get(ref)
  }

  // Try by website
  const all = db.query('SELECT * FROM companies').all() as any[]
  const normalizedWeb = tryNormalizeWebsite(ref)
  if (normalizedWeb) {
    for (const co of all) {
      const websites: string[] = safeJSON(co.websites)
      if (websites.some((w) => w === normalizedWeb)) return co
    }
  }

  // Try by name
  for (const co of all) {
    if (co.name === ref) return co
  }

  return null
}

export function resolveContactForLink(db: Database, ref: string, config?: any): any | null {
  return resolveContact(db, ref, config)
}
