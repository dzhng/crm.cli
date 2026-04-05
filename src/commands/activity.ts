import type { Command } from 'commander'

import { upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { activityToRow, formatOutput } from '../format'
import { runHook } from '../hooks'
import { collect, die, getCtx, makeId, now, parseKV } from '../lib/helpers'
import { resolveCompany, resolveContact, resolveEntity } from '../resolve'

const VALID_TYPES = ['note', 'call', 'meeting', 'email']

export function registerLogCommand(program: Command) {
  program
    .command('log')
    .description('Log an activity')
    .argument('<type>', 'Activity type (note, call, meeting, email)')
    .argument('<ref>', 'Entity reference')
    .argument('<body>', 'Activity body')
    .option('--deal <id>', 'Link to deal')
    .option('--at <date>', 'Custom timestamp')
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (type, ref, body, opts) => {
      const { db, config } = await getCtx()
      if (!VALID_TYPES.includes(type)) {
        die(
          `Error: invalid activity type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`,
        )
      }
      const resolved = await resolveEntity(db, ref, config)
      if (!resolved) {
        die(`Error: entity not found: ${ref}`)
      }
      const id = makeId('ac')
      const ts = opts.at || now()
      const custom = parseKV(opts.set)
      let contact: string | null = null
      let company: string | null = null
      let deal: string | null = null
      if (resolved.type === 'contact') {
        contact = resolved.entity.id
      } else if (resolved.type === 'company') {
        company = resolved.entity.id
      } else if (resolved.type === 'deal') {
        deal = resolved.entity.id
      }
      if (opts.deal) {
        deal = opts.deal
      }
      if (
        !runHook(config, 'pre-activity-add', {
          type,
          body,
          contact,
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
        contact,
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
        contact,
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
    .option('--limit <n>')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let rows = (await db.select().from(schema.activities)).map((a) =>
        activityToRow(a),
      )
      if (opts.contact) {
        const ct = await resolveContact(db, opts.contact, config)
        if (ct) {
          rows = rows.filter((a) => a.contact === ct.id)
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
      if (opts.limit) {
        rows = rows.slice(0, Number(opts.limit))
      }
      console.log(formatOutput(rows, fmt, config))
    })
}
