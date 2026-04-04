import { readFileSync } from 'node:fs'

import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import type { DB } from '../db'
import { upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import {
  activityToRow,
  companyToRow,
  contactToRow,
  dealToRow,
  formatOutput,
  safeJSON,
} from '../format'
import {
  buildCompanySearch,
  buildContactSearch,
  buildDealSearch,
  die,
  getCtx,
  makeId,
  now,
  parseCSV,
} from '../lib/helpers'
import { normalizeWebsite, tryNormalizePhone } from '../normalize'

const CONTACT_FIELDS = new Set([
  'name',
  'email',
  'emails',
  'phone',
  'phones',
  'company',
  'companies',
  'tags',
  'linkedin',
  'x',
  'bluesky',
  'telegram',
])
const COMPANY_FIELDS = new Set([
  'name',
  'website',
  'websites',
  'phone',
  'phones',
  'tags',
])
const DEAL_FIELDS = new Set([
  'title',
  'value',
  'stage',
  'contacts',
  'company',
  'expected_close',
  'probability',
  'tags',
])

export function registerImportExportCommands(program: Command) {
  const imp = program.command('import').description('Import data')

  imp
    .command('contacts')
    .argument('<file>')
    .option('--dry-run')
    .option('--skip-errors')
    .option('--update')
    .action(async (file, opts) => {
      const { db, config } = await getCtx()
      const records = readRecords(file)
      let imported = 0,
        skipped = 0,
        errors = 0
      for (const rec of records) {
        try {
          if (!rec.name) {
            if (opts.skipErrors) {
              errors++
              continue
            }
            die('Error: row missing name')
          }
          const name = rec.name || ''
          const emails = splitField(rec.email || rec.emails)
          const phones = splitField(rec.phone || rec.phones)
            .map((p) => {
              const n = tryNormalizePhone(p, config.phone.default_country)
              return n || p
            })
            .filter((p) => /^\+\d+$/.test(p))
          const companies = splitField(rec.company || rec.companies)
          const tags = splitField(rec.tags)
          // Check for existing by email
          let existing: any = null
          for (const e of emails) {
            existing = await findContactByEmail(db, e)
            if (existing) {
              break
            }
          }
          if (existing && !opts.update) {
            skipped++
            continue
          }
          if (existing && opts.update) {
            const custom: Record<string, any> = safeJSON(existing.custom_fields)
            for (const [k, v] of Object.entries(rec)) {
              if (!CONTACT_FIELDS.has(k) && v) {
                custom[k] = v
              }
            }
            await db
              .update(schema.contacts)
              .set({
                name: name || existing.name,
                custom_fields: JSON.stringify(custom),
                updated_at: now(),
              })
              .where(eq(schema.contacts.id, existing.id))
            const results = await db
              .select()
              .from(schema.contacts)
              .where(eq(schema.contacts.id, existing.id))
            const row = results[0]
            await upsertSearchIndex(
              db,
              'contact',
              existing.id,
              buildContactSearch(row),
            )
            imported++
            continue
          }
          if (opts.dryRun) {
            console.log(`[dry-run] ${name} (${emails.join(', ')})`)
            imported++
            continue
          }
          const id = makeId('ct')
          const n = now()
          const custom: Record<string, any> = {}
          for (const [k, v] of Object.entries(rec)) {
            if (!CONTACT_FIELDS.has(k) && v) {
              custom[k] = v
            }
          }
          const social: Record<string, string | null> = {
            linkedin: rec.linkedin || null,
            x: rec.x || null,
            bluesky: rec.bluesky || null,
            telegram: rec.telegram || null,
          }
          await db.insert(schema.contacts).values({
            id,
            name,
            emails: JSON.stringify(emails),
            phones: JSON.stringify(phones),
            companies: JSON.stringify(companies),
            linkedin: social.linkedin,
            x: social.x,
            bluesky: social.bluesky,
            telegram: social.telegram,
            tags: JSON.stringify(tags),
            custom_fields: JSON.stringify(custom),
            created_at: n,
            updated_at: n,
          })
          const results = await db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.id, id))
          const row = results[0]
          await upsertSearchIndex(db, 'contact', id, buildContactSearch(row))
          imported++
        } catch (e: any) {
          if (opts.skipErrors) {
            errors++
            continue
          }
          die(`Error importing row: ${e.message}`)
        }
      }
      console.log(
        `Imported: ${imported}, skipped: ${skipped}, errors: ${errors}`,
      )
    })

  imp
    .command('companies')
    .argument('<file>')
    .option('--dry-run')
    .option('--skip-errors')
    .action(async (file, opts) => {
      const { db, config } = await getCtx()
      const records = readRecords(file)
      let imported = 0
      for (const rec of records) {
        try {
          if (!rec.name) {
            if (opts.skipErrors) {
              continue
            }
            die('Error: company missing name')
          }
          const websites = splitField(rec.website || rec.websites).map((w) => {
            try {
              return normalizeWebsite(w)
            } catch {
              return w
            }
          })
          const phones = splitField(rec.phone || rec.phones).map((p) => {
            const n = tryNormalizePhone(p, config.phone.default_country)
            return n || p
          })
          const tags = splitField(rec.tags)
          const custom: Record<string, any> = {}
          for (const [k, v] of Object.entries(rec)) {
            if (!COMPANY_FIELDS.has(k) && v) {
              custom[k] = v
            }
          }
          if (opts.dryRun) {
            console.log(`[dry-run] ${rec.name}`)
            imported++
            continue
          }
          const id = makeId('co')
          const n = now()
          await db.insert(schema.companies).values({
            id,
            name: rec.name,
            websites: JSON.stringify(websites),
            phones: JSON.stringify(phones),
            tags: JSON.stringify(tags),
            custom_fields: JSON.stringify(custom),
            created_at: n,
            updated_at: n,
          })
          const results = await db
            .select()
            .from(schema.companies)
            .where(eq(schema.companies.id, id))
          const row = results[0]
          await upsertSearchIndex(db, 'company', id, buildCompanySearch(row))
          imported++
        } catch (e: any) {
          if (opts.skipErrors) {
            continue
          }
          die(`Error: ${e.message}`)
        }
      }
      console.log(`Imported: ${imported}`)
    })

  imp
    .command('deals')
    .argument('<file>')
    .option('--dry-run')
    .option('--skip-errors')
    .action(async (file, opts) => {
      const { db, config } = await getCtx()
      const records = readRecords(file)
      let imported = 0
      for (const rec of records) {
        try {
          if (!rec.title) {
            if (opts.skipErrors) {
              continue
            }
            die('Error: deal missing title')
          }
          const stage = rec.stage || config.pipeline.stages[0]
          const value = rec.value ? Number(rec.value) : null
          const tags = splitField(rec.tags)
          const custom: Record<string, any> = {}
          for (const [k, v] of Object.entries(rec)) {
            if (!DEAL_FIELDS.has(k) && v) {
              custom[k] = v
            }
          }
          if (opts.dryRun) {
            console.log(`[dry-run] ${rec.title}`)
            imported++
            continue
          }
          const id = makeId('dl')
          const n = now()
          await db.insert(schema.deals).values({
            id,
            title: rec.title,
            value,
            stage,
            contacts: '[]',
            company: null,
            expected_close: rec.expected_close || null,
            probability: rec.probability ? Number(rec.probability) : null,
            tags: JSON.stringify(tags),
            custom_fields: JSON.stringify(custom),
            created_at: n,
            updated_at: n,
          })
          const results = await db
            .select()
            .from(schema.deals)
            .where(eq(schema.deals.id, id))
          const row = results[0]
          await upsertSearchIndex(db, 'deal', id, buildDealSearch(row))
          imported++
        } catch (e: any) {
          if (opts.skipErrors) {
            continue
          }
          die(`Error: ${e.message}`)
        }
      }
      console.log(`Imported: ${imported}`)
    })

  const exp = program.command('export').description('Export data')
  exp.command('contacts').action(async () => {
    const { db, config, fmt } = await getCtx()
    const rows = (await db.select().from(schema.contacts)).map((c) =>
      contactToRow(c, config),
    )
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('companies').action(async () => {
    const { db, config, fmt } = await getCtx()
    const rows = (await db.select().from(schema.companies)).map((c) =>
      companyToRow(c, config),
    )
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('deals').action(async () => {
    const { db, config, fmt } = await getCtx()
    const rows = (await db.select().from(schema.deals)).map((d) =>
      dealToRow(d, config),
    )
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('all').action(async () => {
    const { db, config, fmt } = await getCtx()
    const data = {
      contacts: (await db.select().from(schema.contacts)).map((c) =>
        contactToRow(c, config),
      ),
      companies: (await db.select().from(schema.companies)).map((c) =>
        companyToRow(c, config),
      ),
      deals: (await db.select().from(schema.deals)).map((d) =>
        dealToRow(d, config),
      ),
      activities: (await db.select().from(schema.activities)).map((a) =>
        activityToRow(a),
      ),
    }
    if (fmt === 'json') {
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log(
        formatOutput(
          Object.entries(data).map(([k, v]) => ({ type: k, count: v.length })),
          fmt,
          config,
        ),
      )
    }
  })
}

function readRecords(file: string): Record<string, string>[] {
  let raw: string
  if (file === '-') {
    const chunks: Buffer[] = []
    const fd = require('node:fs').openSync('/dev/stdin', 'r')
    const buf = Buffer.alloc(65_536)
    let n = require('node:fs').readSync(fd, buf) as number
    while (n > 0) {
      chunks.push(buf.subarray(0, n))
      n = require('node:fs').readSync(fd, buf) as number
    }
    require('node:fs').closeSync(fd)
    raw = Buffer.concat(chunks).toString('utf-8')
  } else {
    raw = readFileSync(file, 'utf-8')
  }
  raw = raw.trim()
  if (!raw) {
    return []
  }
  if (raw.startsWith('[') || raw.startsWith('{')) {
    return JSON.parse(raw)
  }
  return parseCSV(raw)
}

function splitField(val: string | undefined): string[] {
  if (!val) {
    return []
  }
  if (Array.isArray(val)) {
    return val
  }
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function findContactByEmail(db: DB, email: string): Promise<any | null> {
  const all = await db.select().from(schema.contacts)
  for (const c of all) {
    const emails: string[] = safeJSON(c.emails)
    if (emails.some((e: string) => e.toLowerCase() === email.toLowerCase())) {
      return c
    }
  }
  return null
}
