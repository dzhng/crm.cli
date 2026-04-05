import type { Command } from 'commander'
import { eq, sql } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { rebuildSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { activityToRow, companyToRow, contactToRow, dealToRow } from '../format'
import { getCtx } from '../lib/helpers'

interface FTSRow {
  content: string
  entity_id: string
  entity_type: string
}

export function registerSearchCommands(program: Command) {
  program
    .command('search')
    .description('Full-text search')
    .argument('<query>')
    .option('--type <type>')
    .action(async (query, opts) => {
      const { db, config, fmt } = await getCtx()
      const results: Record<string, unknown>[] = []
      try {
        const ftsRows = (await db.all(
          sql`SELECT * FROM search_index WHERE content MATCH ${query}`,
        )) as FTSRow[]
        for (const fr of ftsRows) {
          if (opts.type && fr.entity_type !== opts.type) {
            continue
          }
          const entity = await lookupEntity(
            db,
            fr.entity_type,
            fr.entity_id,
            config,
          )
          if (entity) {
            results.push(entity)
          }
        }
      } catch {
        // FTS5 match can fail on certain queries, fall back to LIKE
        const likeRows = (await db.all(
          sql`SELECT * FROM search_index WHERE content LIKE ${`%${query}%`}`,
        )) as FTSRow[]
        for (const fr of likeRows) {
          if (opts.type && fr.entity_type !== opts.type) {
            continue
          }
          const entity = await lookupEntity(
            db,
            fr.entity_type,
            fr.entity_id,
            config,
          )
          if (entity) {
            results.push(entity)
          }
        }
      }
      if (fmt === 'json') {
        console.log(JSON.stringify(results, null, 2))
      } else {
        if (results.length === 0) {
          console.log('')
          return
        }
        const lines = results.map((r) => {
          if (r.type === 'contact') {
            return `[contact] ${r.name} (${r.id})`
          }
          if (r.type === 'company') {
            return `[company] ${r.name} (${r.id})`
          }
          if (r.type === 'deal') {
            return `[deal] ${r.title} (${r.id})`
          }
          if (r.entity_type === 'activity') {
            return `[activity] ${r.body} (${r.id})`
          }
          return `[${r.type}] ${r.id}`
        })
        console.log(lines.join('\n'))
      }
    })

  program
    .command('find')
    .description('Semantic search')
    .argument('<query>')
    .option('--type <type>')
    .option('--limit <n>')
    .option('--threshold <n>', 'Minimum similarity score 0.0-1.0')
    .action(async (query, opts) => {
      const { db, config, fmt } = await getCtx()
      const queryWords = query.toLowerCase().split(/\s+/)
      const allEntities: (FTSRow & { score: number })[] = []
      const indexRows = (await db.all(
        sql`SELECT * FROM search_index`,
      )) as FTSRow[]
      for (const row of indexRows) {
        if (opts.type && row.entity_type !== opts.type) {
          continue
        }
        if (row.entity_type === 'activity') {
          continue
        }
        const content = (row.content || '').toLowerCase()
        let score = 0
        for (const w of queryWords) {
          if (content.includes(w)) {
            score += 1
          }
        }
        if (score > 0) {
          const normalized =
            queryWords.length > 0 ? score / queryWords.length : 0
          allEntities.push({ ...row, score: normalized })
        }
      }
      allEntities.sort((a, b) => b.score - a.score)
      let limited = allEntities
      if (opts.threshold) {
        const t = Number(opts.threshold)
        limited = limited.filter((e) => e.score >= t)
      }
      if (opts.limit) {
        limited = limited.slice(0, Number(opts.limit))
      }
      const resultPromises = limited.map((r) =>
        lookupEntity(db, r.entity_type, r.entity_id, config),
      )
      const results = (await Promise.all(resultPromises)).filter(
        Boolean,
      ) as Record<string, unknown>[]
      if (fmt === 'json') {
        console.log(JSON.stringify(results, null, 2))
      } else {
        if (results.length === 0) {
          console.log('')
          return
        }
        const lines = results.map(
          (r) => `[${r.type}] ${r.name || r.title} (${r.id})`,
        )
        console.log(lines.join('\n'))
      }
    })

  const idx = program.command('index').description('Search index management')
  idx.command('status').action(async () => {
    const { db } = await getCtx()
    const countRows = (await db.all(
      sql`SELECT entity_type, COUNT(*) as cnt FROM search_index GROUP BY entity_type`,
    )) as { entity_type: string; cnt: number }[]
    const counts: Record<string, number> = {}
    for (const r of countRows) {
      counts[r.entity_type] = r.cnt
    }
    const contactCount = (
      await db.select({ cnt: sql<number>`COUNT(*)` }).from(schema.contacts)
    )[0]
    const companyCount = (
      await db.select({ cnt: sql<number>`COUNT(*)` }).from(schema.companies)
    )[0]
    const dealCount = (
      await db.select({ cnt: sql<number>`COUNT(*)` }).from(schema.deals)
    )[0]
    console.log(
      `contacts: ${contactCount.cnt} (indexed: ${counts.contact || 0})`,
    )
    console.log(
      `companies: ${companyCount.cnt} (indexed: ${counts.company || 0})`,
    )
    console.log(`deals: ${dealCount.cnt} (indexed: ${counts.deal || 0})`)
  })

  idx.command('rebuild').action(async () => {
    const { db } = await getCtx()
    await rebuildSearchIndex(db)
    console.log('Index rebuilt')
  })
}

async function lookupEntity(
  db: DB,
  entityType: string,
  id: string,
  config: CRMConfig,
): Promise<Record<string, unknown> | null> {
  if (entityType === 'contact') {
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id))
    const c = results[0]
    if (!c) {
      return null
    }
    return { type: 'contact', ...contactToRow(c, config) }
  }
  if (entityType === 'company') {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, id))
    const c = results[0]
    if (!c) {
      return null
    }
    return { type: 'company', ...companyToRow(c, config) }
  }
  if (entityType === 'deal') {
    const results = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, id))
    const d = results[0]
    if (!d) {
      return null
    }
    return { type: 'deal', ...dealToRow(d, config) }
  }
  if (entityType === 'activity') {
    const results = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, id))
    const a = results[0]
    if (!a) {
      return null
    }
    const row = activityToRow(a)
    return { entity_type: 'activity', ...row }
  }
  return null
}
