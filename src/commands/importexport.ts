import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { getCtx, makeId, now, die, collect, parseCSV, buildContactSearch, buildCompanySearch, buildDealSearch } from '../lib/helpers'
import { resolveContact, resolveCompany } from '../resolve'
import { formatOutput, contactToRow, companyToRow, dealToRow, activityToRow, safeJSON } from '../format'
import { upsertSearchIndex } from '../db'
import { tryNormalizePhone, normalizeWebsite } from '../normalize'

const CONTACT_FIELDS = new Set(['name', 'email', 'emails', 'phone', 'phones', 'company', 'companies', 'tags', 'linkedin', 'x', 'bluesky', 'telegram'])
const COMPANY_FIELDS = new Set(['name', 'website', 'websites', 'phone', 'phones', 'tags'])
const DEAL_FIELDS = new Set(['title', 'value', 'stage', 'contacts', 'company', 'expected_close', 'probability', 'tags'])

export function registerImportExportCommands(program: Command) {
  const imp = program.command('import').description('Import data')

  imp.command('contacts').argument('<file>').option('--dry-run').option('--skip-errors').option('--update')
    .action((file, opts) => {
      const { db, config } = getCtx()
      const records = readRecords(file)
      let imported = 0, skipped = 0, errors = 0
      for (const rec of records) {
        try {
          if (!rec.name) { if (opts.skipErrors) { errors++; continue }; die('Error: row missing name') }
          const name = rec.name || ''
          const emails = splitField(rec.email || rec.emails)
          const phones = splitField(rec.phone || rec.phones).map(p => {
            const n = tryNormalizePhone(p, config.phone.default_country)
            return n || p
          }).filter(p => /^\+\d+$/.test(p))
          const companies = splitField(rec.company || rec.companies)
          const tags = splitField(rec.tags)
          // Check for existing by email
          let existing: any = null
          for (const e of emails) {
            existing = findContactByEmail(db, e)
            if (existing) break
          }
          if (existing && !opts.update) { skipped++; continue }
          if (existing && opts.update) {
            const custom: Record<string, any> = safeJSON(existing.custom_fields)
            for (const [k, v] of Object.entries(rec)) {
              if (!CONTACT_FIELDS.has(k) && v) custom[k] = v
            }
            db.run('UPDATE contacts SET name=?,custom_fields=?,updated_at=? WHERE id=?',
              [name || existing.name, JSON.stringify(custom), now(), existing.id])
            const row = db.query('SELECT * FROM contacts WHERE id = ?').get(existing.id)
            upsertSearchIndex(db, 'contact', existing.id, buildContactSearch(row))
            imported++
            continue
          }
          if (opts.dryRun) { console.log(`[dry-run] ${name} (${emails.join(', ')})`); imported++; continue }
          const id = makeId('ct')
          const n = now()
          const custom: Record<string, any> = {}
          for (const [k, v] of Object.entries(rec)) {
            if (!CONTACT_FIELDS.has(k) && v) custom[k] = v
          }
          const social: Record<string, string | null> = { linkedin: rec.linkedin || null, x: rec.x || null, bluesky: rec.bluesky || null, telegram: rec.telegram || null }
          db.run('INSERT INTO contacts (id,name,emails,phones,companies,linkedin,x,bluesky,telegram,tags,custom_fields,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [id, name, JSON.stringify(emails), JSON.stringify(phones), JSON.stringify(companies), social.linkedin, social.x, social.bluesky, social.telegram, JSON.stringify(tags), JSON.stringify(custom), n, n])
          const row = db.query('SELECT * FROM contacts WHERE id = ?').get(id)
          upsertSearchIndex(db, 'contact', id, buildContactSearch(row))
          imported++
        } catch (e: any) {
          if (opts.skipErrors) { errors++; continue }
          die(`Error importing row: ${e.message}`)
        }
      }
      console.log(`Imported: ${imported}, skipped: ${skipped}, errors: ${errors}`)
    })

  imp.command('companies').argument('<file>').option('--dry-run').option('--skip-errors')
    .action((file, opts) => {
      const { db, config } = getCtx()
      const records = readRecords(file)
      let imported = 0
      for (const rec of records) {
        try {
          if (!rec.name) { if (opts.skipErrors) continue; die('Error: company missing name') }
          const websites = splitField(rec.website || rec.websites).map(w => {
            try { return normalizeWebsite(w) } catch { return w }
          })
          const phones = splitField(rec.phone || rec.phones).map(p => {
            const n = tryNormalizePhone(p, config.phone.default_country)
            return n || p
          })
          const tags = splitField(rec.tags)
          const custom: Record<string, any> = {}
          for (const [k, v] of Object.entries(rec)) {
            if (!COMPANY_FIELDS.has(k) && v) custom[k] = v
          }
          if (opts.dryRun) { console.log(`[dry-run] ${rec.name}`); imported++; continue }
          const id = makeId('co')
          const n = now()
          db.run('INSERT INTO companies (id,name,websites,phones,tags,custom_fields,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
            [id, rec.name, JSON.stringify(websites), JSON.stringify(phones), JSON.stringify(tags), JSON.stringify(custom), n, n])
          const row = db.query('SELECT * FROM companies WHERE id = ?').get(id)
          upsertSearchIndex(db, 'company', id, buildCompanySearch(row))
          imported++
        } catch (e: any) {
          if (opts.skipErrors) continue
          die(`Error: ${e.message}`)
        }
      }
      console.log(`Imported: ${imported}`)
    })

  imp.command('deals').argument('<file>').option('--dry-run').option('--skip-errors')
    .action((file, opts) => {
      const { db, config } = getCtx()
      const records = readRecords(file)
      let imported = 0
      for (const rec of records) {
        try {
          if (!rec.title) { if (opts.skipErrors) continue; die('Error: deal missing title') }
          const stage = rec.stage || config.pipeline.stages[0]
          const value = rec.value ? Number(rec.value) : null
          const tags = splitField(rec.tags)
          const custom: Record<string, any> = {}
          for (const [k, v] of Object.entries(rec)) {
            if (!DEAL_FIELDS.has(k) && v) custom[k] = v
          }
          if (opts.dryRun) { console.log(`[dry-run] ${rec.title}`); imported++; continue }
          const id = makeId('dl')
          const n = now()
          db.run('INSERT INTO deals (id,title,value,stage,contacts,company,expected_close,probability,tags,custom_fields,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [id, rec.title, value, stage, '[]', null, rec.expected_close || null, rec.probability ? Number(rec.probability) : null, JSON.stringify(tags), JSON.stringify(custom), n, n])
          const row = db.query('SELECT * FROM deals WHERE id = ?').get(id)
          upsertSearchIndex(db, 'deal', id, buildDealSearch(row))
          imported++
        } catch (e: any) {
          if (opts.skipErrors) continue
          die(`Error: ${e.message}`)
        }
      }
      console.log(`Imported: ${imported}`)
    })

  const exp = program.command('export').description('Export data')
  exp.command('contacts').action(() => {
    const { db, config, fmt } = getCtx()
    const rows = (db.query('SELECT * FROM contacts').all() as any[]).map(c => contactToRow(c, config))
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('companies').action(() => {
    const { db, config, fmt } = getCtx()
    const rows = (db.query('SELECT * FROM companies').all() as any[]).map(c => companyToRow(c, config))
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('deals').action(() => {
    const { db, config, fmt } = getCtx()
    const rows = (db.query('SELECT * FROM deals').all() as any[]).map(d => dealToRow(d, config))
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('all').action(() => {
    const { db, config, fmt } = getCtx()
    const data = {
      contacts: (db.query('SELECT * FROM contacts').all() as any[]).map(c => contactToRow(c, config)),
      companies: (db.query('SELECT * FROM companies').all() as any[]).map(c => companyToRow(c, config)),
      deals: (db.query('SELECT * FROM deals').all() as any[]).map(d => dealToRow(d, config)),
      activities: (db.query('SELECT * FROM activities').all() as any[]).map(a => activityToRow(a)),
    }
    if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
    else console.log(formatOutput(Object.entries(data).map(([k, v]) => ({ type: k, count: v.length })), fmt, config))
  })
}

function readRecords(file: string): Record<string, string>[] {
  let raw: string
  if (file === '-') {
    const chunks: Buffer[] = []
    const fd = require('fs').openSync('/dev/stdin', 'r')
    const buf = Buffer.alloc(65536)
    let n: number
    while ((n = require('fs').readSync(fd, buf)) > 0) chunks.push(buf.subarray(0, n))
    require('fs').closeSync(fd)
    raw = Buffer.concat(chunks).toString('utf-8')
  } else {
    raw = readFileSync(file, 'utf-8')
  }
  raw = raw.trim()
  if (!raw) return []
  if (raw.startsWith('[') || raw.startsWith('{')) return JSON.parse(raw)
  return parseCSV(raw)
}

function splitField(val: string | undefined): string[] {
  if (!val) return []
  if (Array.isArray(val)) return val
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

function findContactByEmail(db: any, email: string): any | null {
  const all = db.query('SELECT * FROM contacts').all() as any[]
  for (const c of all) {
    const emails: string[] = safeJSON(c.emails)
    if (emails.some((e: string) => e.toLowerCase() === email.toLowerCase())) return c
  }
  return null
}
