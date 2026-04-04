import { ulid } from 'ulid'
import type { Database } from 'bun:sqlite'
import { loadConfig, type CRMConfig } from '../config'
import { openDB, upsertSearchIndex } from '../db'
import { normalizePhone, tryNormalizePhone, normalizeWebsite, normalizeSocialHandle, formatPhone } from '../normalize'
import { safeJSON, contactToRow, companyToRow, dealToRow, activityToRow } from '../format'
import { resolveCompanyForLink } from '../resolve'

// ── Global option extraction ──
const rawArgv = process.argv.slice(2)
export let gDb: string | undefined, gConfig: string | undefined, gFmt: string | undefined
export const cleanArgv: string[] = []
for (let i = 0; i < rawArgv.length; i++) {
  if (rawArgv[i] === '--db') { gDb = rawArgv[++i]; continue }
  if (rawArgv[i] === '--config') { gConfig = rawArgv[++i]; continue }
  if (rawArgv[i] === '--format') { gFmt = rawArgv[++i]; continue }
  if (rawArgv[i] === '--no-color' || rawArgv[i] === '--verbose') continue
  cleanArgv.push(rawArgv[i])
}

export function getCtx() {
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  const db = openDB(config.database.path)
  return { config, db, fmt: config.defaults.format }
}

export function makeId(prefix: string) { return `${prefix}_${ulid()}` }
export function now() { return new Date().toISOString() }
export function die(msg: string): never { console.error(msg); process.exit(1) }
export function collect(v: string, prev: string[]) { prev.push(v); return prev }

export function parseKV(arr: string[]): Record<string, string> {
  const r: Record<string, string> = {}
  for (const s of (arr || [])) {
    const i = s.indexOf('=')
    if (i > 0) r[s.slice(0, i)] = s.slice(i + 1)
  }
  return r
}

export function getOrCreateCompany(db: Database, ref: string, config: CRMConfig): string {
  const co = resolveCompanyForLink(db, ref, config)
  if (co) return co.name
  const cid = makeId('co')
  const n = now()
  db.run('INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [cid, ref, n, n])
  upsertSearchIndex(db, 'company', cid, ref)
  return ref
}

export function getOrCreateCompanyId(db: Database, ref: string, config: CRMConfig): string {
  const co = resolveCompanyForLink(db, ref, config)
  if (co) return co.id
  const cid = makeId('co')
  const n = now()
  db.run('INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [cid, ref, n, n])
  upsertSearchIndex(db, 'company', cid, ref)
  return cid
}

export function checkDupeEmail(db: Database, email: string, excludeId?: string) {
  const all = db.query('SELECT * FROM contacts').all() as any[]
  for (const c of all) {
    if (excludeId && c.id === excludeId) continue
    const emails: string[] = safeJSON(c.emails)
    if (emails.some(e => e.toLowerCase() === email.toLowerCase()))
      die(`Error: duplicate email "${email}" — already belongs to ${c.name} (${c.id})`)
  }
}

export function checkDupePhone(db: Database, phone: string, table: string, excludeId?: string) {
  const all = db.query(`SELECT * FROM ${table}`).all() as any[]
  for (const c of all) {
    if (excludeId && c.id === excludeId) continue
    const phones: string[] = safeJSON(c.phones)
    if (phones.includes(phone))
      die(`Error: duplicate phone "${phone}" — already belongs to ${(c as any).name || (c as any).title} (${c.id})`)
  }
}

export function checkDupeWebsite(db: Database, website: string, excludeId?: string) {
  const all = db.query('SELECT * FROM companies').all() as any[]
  for (const co of all) {
    if (excludeId && co.id === excludeId) continue
    const websites: string[] = safeJSON(co.websites)
    if (websites.includes(website))
      die(`Error: duplicate website "${website}" — already belongs to ${co.name} (${co.id})`)
  }
}

export function checkDupeSocial(db: Database, platform: string, handle: string, excludeId?: string) {
  const existing = db.query(`SELECT * FROM contacts WHERE ${platform} = ?`).get(handle) as any
  if (existing && existing.id !== excludeId)
    die(`Error: duplicate ${platform} handle "${handle}" — already belongs to ${existing.name} (${existing.id})`)
}

export function buildContactSearch(c: any): string {
  return [c.name, c.emails, c.phones, c.companies, c.linkedin, c.x, c.bluesky, c.telegram,
    JSON.stringify(safeJSON(c.custom_fields)), c.tags].filter(Boolean).join(' ')
}

export function buildCompanySearch(co: any): string {
  return [co.name, co.websites, co.phones, JSON.stringify(safeJSON(co.custom_fields)), co.tags].filter(Boolean).join(' ')
}

export function buildDealSearch(d: any): string {
  return [d.title, d.stage, JSON.stringify(safeJSON(d.custom_fields)), d.tags].filter(Boolean).join(' ')
}

export function contactDetail(db: Database, c: any, config: CRMConfig): any {
  const row = contactToRow(c, config)
  const phones: string[] = safeJSON(c.phones)
  row._display_phones = phones.map(p => formatPhone(p, config.phone.display, config.phone.default_country))
  const deals = db.query('SELECT * FROM deals').all() as any[]
  row.deals = deals.filter(d => {
    const contacts: string[] = safeJSON(d.contacts)
    return contacts.includes(c.id)
  }).map(d => ({ id: d.id, title: d.title, stage: d.stage, value: d.value }))
  return row
}

export function companyDetail(db: Database, co: any, config: CRMConfig): any {
  const row = companyToRow(co, config)
  const phones: string[] = safeJSON(co.phones)
  row._display_phones = phones.map(p => formatPhone(p, config.phone.display, config.phone.default_country))
  const contacts = db.query('SELECT * FROM contacts').all() as any[]
  row.contacts = contacts.filter(ct => {
    const companies: string[] = safeJSON(ct.companies)
    return companies.includes(co.name)
  }).map(ct => ({ id: ct.id, name: ct.name, emails: safeJSON(ct.emails) }))
  const deals = db.query('SELECT * FROM deals WHERE company = ?').all(co.id) as any[]
  row.deals = deals.map(d => ({ id: d.id, title: d.title, stage: d.stage, value: d.value }))
  return row
}

export function dealDetail(db: Database, d: any, config: CRMConfig): any {
  const row = dealToRow(d, config)
  const contactIds: string[] = safeJSON(d.contacts)
  row.contacts = contactIds.map(cid => {
    const ct = db.query('SELECT * FROM contacts WHERE id = ?').get(cid) as any
    return ct ? { id: ct.id, name: ct.name, emails: safeJSON(ct.emails) } : null
  }).filter(Boolean)
  if (d.company) {
    const co = db.query('SELECT * FROM companies WHERE id = ?').get(d.company) as any
    row.company = co ? { id: co.id, name: co.name } : null
  }
  const stageChanges = db.query(
    "SELECT * FROM activities WHERE deal = ? AND type = 'stage-change' ORDER BY created_at ASC"
  ).all(d.id) as any[]
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
  row.notes = stageChanges.filter(a => a.body.includes('|')).map(a => a.body)
  return row
}

export function showEntity(detail: any, fmt: string) {
  if (fmt === 'json') {
    console.log(JSON.stringify(detail, null, 2))
    return
  }
  const lines: string[] = []
  for (const [k, v] of Object.entries(detail)) {
    if (k === '_display_phones') continue
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      if (typeof v[0] === 'object') {
        lines.push(`${k}:`)
        for (const item of v) lines.push(`  ${typeof item === 'object' ? JSON.stringify(item) : item}`)
      } else {
        lines.push(`${k}: ${v.join(', ')}`)
      }
    } else if (typeof v === 'object') {
      lines.push(`${k}:`)
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) lines.push(`  ${sk}: ${sv}`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  // Show phones with both raw E.164 and display format
  if (detail._display_phones?.length && detail.phones?.length) {
    const idx = lines.findIndex(l => l.startsWith('phones:'))
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
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 1) return []
  const headers = parseCSVLine(lines[0])
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i])
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] || ''
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
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue }
      if (ch === '"') { inQuotes = false; continue }
      current += ch
    } else {
      if (ch === '"') { inQuotes = true; continue }
      if (ch === ',') { result.push(current); current = ''; continue }
      current += ch
    }
  }
  result.push(current)
  return result
}

export function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0))
  for (let i = 0; i <= la; i++) dp[i][0] = i
  for (let j = 0; j <= lb; j++) dp[0][j] = j
  for (let i = 1; i <= la; i++)
    for (let j = 1; j <= lb; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0))
  return dp[la][lb]
}
