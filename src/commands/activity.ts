import type { Command } from 'commander'
import { getCtx, makeId, now, die, collect, parseKV } from '../lib/helpers'
import { resolveEntity, resolveContact, resolveCompany, resolveDeal } from '../resolve'
import { formatOutput, activityToRow, safeJSON } from '../format'
import { upsertSearchIndex } from '../db'

const VALID_TYPES = ['note', 'call', 'meeting', 'email']

export function registerLogCommand(program: Command) {
  program.command('log')
    .description('Log an activity')
    .argument('<type>', 'Activity type (note, call, meeting, email)')
    .argument('<ref>', 'Entity reference')
    .argument('<body>', 'Activity body')
    .option('--deal <id>', 'Link to deal')
    .option('--at <date>', 'Custom timestamp')
    .option('--set <kv>', 'Custom field', collect, [])
    .action((type, ref, body, opts) => {
      const { db, config } = getCtx()
      if (!VALID_TYPES.includes(type)) die(`Error: invalid activity type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`)
      const resolved = resolveEntity(db, ref, config)
      if (!resolved) die(`Error: entity not found: ${ref}`)
      const id = makeId('ac')
      const ts = opts.at || now()
      const custom = parseKV(opts.set)
      let contact: string | null = null
      let company: string | null = null
      let deal: string | null = null
      if (resolved.type === 'contact') contact = resolved.entity.id
      else if (resolved.type === 'company') company = resolved.entity.id
      else if (resolved.type === 'deal') deal = resolved.entity.id
      if (opts.deal) deal = opts.deal
      db.run('INSERT INTO activities (id,type,body,contact,company,deal,custom_fields,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, type, body, contact, company, deal, JSON.stringify(custom), ts])
      upsertSearchIndex(db, 'activity', id, `${type} ${body}`)
    })
}

export function registerActivityCommands(program: Command) {
  const cmd = program.command('activity').description('Activity management')
  cmd.command('list')
    .option('--contact <ref>')
    .option('--company <ref>')
    .option('--deal <id>')
    .option('--type <type>')
    .option('--since <date>')
    .option('--limit <n>')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let rows = (db.query('SELECT * FROM activities').all() as any[]).map(a => activityToRow(a))
      if (opts.contact) {
        const ct = resolveContact(db, opts.contact, config)
        if (ct) rows = rows.filter(a => a.contact === ct.id)
        else rows = []
      }
      if (opts.company) {
        const co = resolveCompany(db, opts.company, config)
        if (co) rows = rows.filter(a => a.company === co.id)
        else rows = []
      }
      if (opts.deal) rows = rows.filter(a => a.deal === opts.deal)
      if (opts.type) rows = rows.filter(a => a.type === opts.type)
      if (opts.since) rows = rows.filter(a => a.created_at >= opts.since)
      if (opts.limit) rows = rows.slice(0, Number(opts.limit))
      console.log(formatOutput(rows, fmt, config))
    })
}
