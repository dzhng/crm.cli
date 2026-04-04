import type { Command } from 'commander'
import { getCtx, levenshtein } from '../lib/helpers'
import { formatOutput, contactToRow, companyToRow, dealToRow, activityToRow, safeJSON } from '../format'
import { rebuildSearchIndex } from '../db'

export function registerSearchCommands(program: Command) {
  program.command('search')
    .description('Full-text search')
    .argument('<query>')
    .option('--type <type>')
    .action((query, opts) => {
      const { db, config, fmt } = getCtx()
      let results: any[] = []
      try {
        const ftsRows = db.query('SELECT * FROM search_index WHERE content MATCH ?').all(query) as any[]
        for (const fr of ftsRows) {
          if (opts.type && fr.entity_type !== opts.type) continue
          const entity = lookupEntity(db, fr.entity_type, fr.entity_id, config)
          if (entity) results.push(entity)
        }
      } catch {
        // FTS5 match can fail on certain queries, fall back to LIKE
        const likeRows = db.query('SELECT * FROM search_index WHERE content LIKE ?').all(`%${query}%`) as any[]
        for (const fr of likeRows) {
          if (opts.type && fr.entity_type !== opts.type) continue
          const entity = lookupEntity(db, fr.entity_type, fr.entity_id, config)
          if (entity) results.push(entity)
        }
      }
      if (fmt === 'json') console.log(JSON.stringify(results, null, 2))
      else {
        if (results.length === 0) { console.log(''); return }
        const lines = results.map(r => {
          if (r.type === 'contact') return `[contact] ${r.name} (${r.id})`
          if (r.type === 'company') return `[company] ${r.name} (${r.id})`
          if (r.type === 'deal') return `[deal] ${r.title} (${r.id})`
          if (r.entity_type === 'activity') return `[activity] ${r.body} (${r.id})`
          return `[${r.type}] ${r.id}`
        })
        console.log(lines.join('\n'))
      }
    })

  program.command('find')
    .description('Semantic search')
    .argument('<query>')
    .option('--type <type>')
    .option('--limit <n>')
    .action((query, opts) => {
      const { db, config, fmt } = getCtx()
      const queryWords = query.toLowerCase().split(/\s+/)
      const allEntities: any[] = []
      const indexRows = db.query('SELECT * FROM search_index').all() as any[]
      for (const row of indexRows) {
        if (opts.type && row.entity_type !== opts.type) continue
        if (row.entity_type === 'activity') continue
        const content = (row.content || '').toLowerCase()
        let score = 0
        for (const w of queryWords) {
          if (content.includes(w)) score += 1
        }
        if (score > 0) allEntities.push({ ...row, score })
      }
      allEntities.sort((a, b) => b.score - a.score)
      let limited = allEntities
      if (opts.limit) limited = limited.slice(0, Number(opts.limit))
      const results = limited.map(r => lookupEntity(db, r.entity_type, r.entity_id, config)).filter(Boolean) as any[]
      if (fmt === 'json') console.log(JSON.stringify(results, null, 2))
      else {
        if (results.length === 0) { console.log(''); return }
        const lines = results.map(r => `[${r.type}] ${r.name || r.title} (${r.id})`)
        console.log(lines.join('\n'))
      }
    })

  const idx = program.command('index').description('Search index management')
  idx.command('status').action(() => {
    const { db } = getCtx()
    const counts: Record<string, number> = {}
    const rows = db.query('SELECT entity_type, COUNT(*) as cnt FROM search_index GROUP BY entity_type').all() as any[]
    for (const r of rows) counts[r.entity_type] = r.cnt
    const contactCount = db.query('SELECT COUNT(*) as cnt FROM contacts').get() as any
    const companyCount = db.query('SELECT COUNT(*) as cnt FROM companies').get() as any
    const dealCount = db.query('SELECT COUNT(*) as cnt FROM deals').get() as any
    console.log(`contacts: ${contactCount.cnt} (indexed: ${counts.contact || 0})`)
    console.log(`companies: ${companyCount.cnt} (indexed: ${counts.company || 0})`)
    console.log(`deals: ${dealCount.cnt} (indexed: ${counts.deal || 0})`)
  })

  idx.command('rebuild').action(() => {
    const { db } = getCtx()
    rebuildSearchIndex(db)
    console.log('Index rebuilt')
  })
}

function lookupEntity(db: any, entityType: string, id: string, config: any): any | null {
  if (entityType === 'contact') {
    const c = db.query('SELECT * FROM contacts WHERE id = ?').get(id)
    if (!c) return null
    return { type: 'contact', ...contactToRow(c, config) }
  }
  if (entityType === 'company') {
    const c = db.query('SELECT * FROM companies WHERE id = ?').get(id)
    if (!c) return null
    return { type: 'company', ...companyToRow(c, config) }
  }
  if (entityType === 'deal') {
    const d = db.query('SELECT * FROM deals WHERE id = ?').get(id)
    if (!d) return null
    return { type: 'deal', ...dealToRow(d, config) }
  }
  if (entityType === 'activity') {
    const a = db.query('SELECT * FROM activities WHERE id = ?').get(id)
    if (!a) return null
    const row = activityToRow(a)
    return { entity_type: 'activity', ...row }
  }
  return null
}
