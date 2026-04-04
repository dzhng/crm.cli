import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import * as schema from '../drizzle-schema'
import { formatOutput, safeJSON } from '../format'
import { die, getCtx, now } from '../lib/helpers'
import { resolveEntity } from '../resolve'

export function registerTagCommands(program: Command) {
  program
    .command('tag')
    .description('Tag an entity or list tags')
    .argument('[args...]')
    .option('--type <type>')
    .action(async (args: string[], opts) => {
      if (args[0] === 'list') {
        return tagList(opts)
      }
      if (args.length < 2) {
        die('Error: usage: tag <ref> <tags...>')
      }
      const ref = args[0]
      const tags = args.slice(1)
      const { db, config } = await getCtx()
      const resolved = await resolveEntity(db, ref, config)
      if (!resolved) {
        die(`Error: entity not found: ${ref}`)
      }
      const { type, entity } = resolved
      const existing: string[] = safeJSON(entity.tags)
      for (const t of tags) {
        if (!existing.includes(t)) {
          existing.push(t)
        }
      }
      if (type === 'contact') {
        await db
          .update(schema.contacts)
          .set({ tags: JSON.stringify(existing), updated_at: now() })
          .where(eq(schema.contacts.id, entity.id))
      } else if (type === 'company') {
        await db
          .update(schema.companies)
          .set({ tags: JSON.stringify(existing), updated_at: now() })
          .where(eq(schema.companies.id, entity.id))
      } else {
        await db
          .update(schema.deals)
          .set({ tags: JSON.stringify(existing), updated_at: now() })
          .where(eq(schema.deals.id, entity.id))
      }
    })

  program
    .command('untag')
    .description('Remove tags from an entity')
    .argument('<ref>')
    .argument('<tags...>')
    .action(async (ref: string, tags: string[]) => {
      const { db, config } = await getCtx()
      const resolved = await resolveEntity(db, ref, config)
      if (!resolved) {
        die(`Error: entity not found: ${ref}`)
      }
      const { type, entity } = resolved
      let existing: string[] = safeJSON(entity.tags)
      for (const t of tags) {
        existing = existing.filter((v) => v !== t)
      }
      if (type === 'contact') {
        await db
          .update(schema.contacts)
          .set({ tags: JSON.stringify(existing), updated_at: now() })
          .where(eq(schema.contacts.id, entity.id))
      } else if (type === 'company') {
        await db
          .update(schema.companies)
          .set({ tags: JSON.stringify(existing), updated_at: now() })
          .where(eq(schema.companies.id, entity.id))
      } else {
        await db
          .update(schema.deals)
          .set({ tags: JSON.stringify(existing), updated_at: now() })
          .where(eq(schema.deals.id, entity.id))
      }
    })
}

async function tagList(opts: { type?: string }) {
  const { db, config, fmt } = await getCtx()
  const tagMap: Record<string, number> = {}
  if (!opts.type || opts.type === 'contact') {
    const rows = await db
      .select({ tags: schema.contacts.tags })
      .from(schema.contacts)
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) {
        tagMap[tag] = (tagMap[tag] || 0) + 1
      }
    }
  }
  if (!opts.type || opts.type === 'company') {
    const rows = await db
      .select({ tags: schema.companies.tags })
      .from(schema.companies)
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) {
        tagMap[tag] = (tagMap[tag] || 0) + 1
      }
    }
  }
  if (!opts.type || opts.type === 'deal') {
    const rows = await db.select({ tags: schema.deals.tags }).from(schema.deals)
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) {
        tagMap[tag] = (tagMap[tag] || 0) + 1
      }
    }
  }
  const data = Object.entries(tagMap).map(([tag, count]) => ({ tag, count }))
  if (fmt === 'json') {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(formatOutput(data, fmt, config))
  }
}
