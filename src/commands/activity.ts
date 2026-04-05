import type { Command } from 'commander'

import { upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { activityToRow, formatOutput } from '../format'
import { runHook } from '../hooks'
import {
  collect,
  die,
  getCtx,
  getOrCreateCompanyId,
  getOrCreateContactId,
  makeId,
  now,
  parseKV,
} from '../lib/helpers'
import { resolveCompany, resolveContact, resolveDeal } from '../resolve'

const VALID_TYPES = ['note', 'call', 'meeting', 'email']

export function registerLogCommand(program: Command) {
  program
    .command('log')
    .description('Log an activity')
    .argument('<type>', 'Activity type (note, call, meeting, email)')
    .argument('<body>', 'Activity body')
    .option('--contact <ref>', 'Link to contact (repeatable)', collect, [])
    .option('--company <ref>', 'Link to company (auto-creates if needed)')
    .option('--deal <ref>', 'Link to deal')
    .option('--at <date>', 'Custom timestamp')
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (rawType, rawBody, opts) => {
      const { db, config } = await getCtx()
      const type = rawType.trim()
      const body = rawBody.trim()
      opts.contact = opts.contact.map((c: string) => c.trim())
      if (opts.company) {
        opts.company = opts.company.trim()
      }
      if (opts.deal) {
        opts.deal = opts.deal.trim()
      }
      if (!VALID_TYPES.includes(type)) {
        die(
          `Error: invalid activity type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`,
        )
      }

      const contacts: string[] = []
      let company: string | null = null
      let deal: string | null = null

      for (const cRef of opts.contact) {
        const ctId = await getOrCreateContactId(db, cRef, config)
        if (!contacts.includes(ctId)) {
          contacts.push(ctId)
        }
      }

      if (opts.company) {
        company = await getOrCreateCompanyId(db, opts.company, config)
      }

      if (opts.deal) {
        const d = await resolveDeal(db, opts.deal)
        if (!d) {
          die(`Error: deal not found: ${opts.deal}`)
        }
        deal = d.id
      }

      if (opts.at) {
        const d = new Date(opts.at)
        if (Number.isNaN(d.getTime())) {
          die('Error: invalid --at date')
        }
      }
      const id = makeId('ac')
      const ts = opts.at || now()
      const custom = parseKV(opts.set)

      if (
        !runHook(config, 'pre-activity-add', {
          type,
          body,
          contacts,
          company,
          deal,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-activity-add hook rejected creation')
      }
      await db.insert(schema.activities).values({
        id,
        type,
        body,
        contacts: JSON.stringify(contacts),
        company,
        deal,
        custom_fields: JSON.stringify(custom),
        created_at: ts,
      })
      await upsertSearchIndex(db, 'activity', id, `${type} ${body}`)
      runHook(config, 'post-activity-add', {
        id,
        type,
        body,
        contacts,
        company,
        deal,
        custom_fields: custom,
      })
    })
}

export function registerActivityCommands(program: Command) {
  const cmd = program.command('activity').description('Activity management')
  cmd
    .command('list')
    .option('--contact <ref>')
    .option('--company <ref>')
    .option('--deal <id>')
    .option('--type <type>')
    .option('--since <date>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let rows = (await db.select().from(schema.activities)).map((a) =>
        activityToRow(a),
      )
      if (opts.contact) {
        const ct = await resolveContact(db, opts.contact, config)
        if (ct) {
          rows = rows.filter((a) => (a.contacts as string[]).includes(ct.id))
        } else {
          rows = []
        }
      }
      if (opts.company) {
        const co = await resolveCompany(db, opts.company, config)
        if (co) {
          rows = rows.filter((a) => a.company === co.id)
        } else {
          rows = []
        }
      }
      if (opts.deal) {
        rows = rows.filter((a) => a.deal === opts.deal)
      }
      if (opts.type) {
        rows = rows.filter((a) => a.type === opts.type)
      }
      if (opts.since) {
        rows = rows.filter((a) => (a.created_at as string) >= opts.since)
      }
      if (opts.sort) {
        rows.sort((a, b) =>
          String(a[opts.sort] ?? '').localeCompare(String(b[opts.sort] ?? '')),
        )
      }
      if (opts.reverse) {
        rows.reverse()
      }
      if (opts.offset) {
        rows = rows.slice(Number(opts.offset))
      }
      if (opts.limit) {
        rows = rows.slice(0, Number(opts.limit))
      }
      console.log(formatOutput(rows, fmt, config))
    })
}
