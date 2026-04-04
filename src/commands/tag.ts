import type { Command } from 'commander'
import { getCtx, die, now } from '../lib/helpers'
import { resolveEntity } from '../resolve'
import { safeJSON, formatOutput } from '../format'

export function registerTagCommands(program: Command) {
  program.command('tag')
    .description('Tag an entity or list tags')
    .argument('[args...]')
    .option('--type <type>')
    .action((args: string[], opts) => {
      if (args[0] === 'list') return tagList(opts)
      if (args.length < 2) die('Error: usage: tag <ref> <tags...>')
      const ref = args[0]
      const tags = args.slice(1)
      const { db, config } = getCtx()
      const resolved = resolveEntity(db, ref, config)
      if (!resolved) die(`Error: entity not found: ${ref}`)
      const { type, entity } = resolved
      const table = type === 'contact' ? 'contacts' : type === 'company' ? 'companies' : 'deals'
      const existing: string[] = safeJSON(entity.tags)
      for (const t of tags) { if (!existing.includes(t)) existing.push(t) }
      db.run(`UPDATE ${table} SET tags=?,updated_at=? WHERE id=?`, [JSON.stringify(existing), now(), entity.id])
    })

  program.command('untag')
    .description('Remove tags from an entity')
    .argument('<ref>')
    .argument('<tags...>')
    .action((ref: string, tags: string[]) => {
      const { db, config } = getCtx()
      const resolved = resolveEntity(db, ref, config)
      if (!resolved) die(`Error: entity not found: ${ref}`)
      const { type, entity } = resolved
      const table = type === 'contact' ? 'contacts' : type === 'company' ? 'companies' : 'deals'
      let existing: string[] = safeJSON(entity.tags)
      for (const t of tags) existing = existing.filter(v => v !== t)
      db.run(`UPDATE ${table} SET tags=?,updated_at=? WHERE id=?`, [JSON.stringify(existing), now(), entity.id])
    })
}

function tagList(opts: { type?: string }) {
  const { db, config, fmt } = getCtx()
  const tagMap: Record<string, number> = {}
  const tables: { name: string; type: string }[] = []
  if (!opts.type || opts.type === 'contact') tables.push({ name: 'contacts', type: 'contact' })
  if (!opts.type || opts.type === 'company') tables.push({ name: 'companies', type: 'company' })
  if (!opts.type || opts.type === 'deal') tables.push({ name: 'deals', type: 'deal' })
  for (const t of tables) {
    const rows = db.query(`SELECT tags FROM ${t.name}`).all() as any[]
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) tagMap[tag] = (tagMap[tag] || 0) + 1
    }
  }
  const data = Object.entries(tagMap).map(([tag, count]) => ({ tag, count }))
  if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
  else console.log(formatOutput(data, fmt, config))
}
