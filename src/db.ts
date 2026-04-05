import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './drizzle-schema'
import {
  buildCompanySearch,
  buildContactSearch,
  buildDealSearch,
} from './lib/helpers'

export type DB = ReturnType<typeof drizzle<typeof schema>>

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  companies TEXT NOT NULL DEFAULT '[]',
  linkedin TEXT,
  x TEXT,
  bluesky TEXT,
  telegram TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_linkedin ON contacts(linkedin) WHERE linkedin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_x ON contacts(x) WHERE x IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_bluesky ON contacts(bluesky) WHERE bluesky IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_telegram ON contacts(telegram) WHERE telegram IS NOT NULL;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  websites TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  value INTEGER,
  stage TEXT NOT NULL,
  contacts TEXT NOT NULL DEFAULT '[]',
  company TEXT REFERENCES companies(id) ON DELETE SET NULL,
  expected_close TEXT,
  probability INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  contacts TEXT NOT NULL DEFAULT '[]',
  company TEXT,
  deal TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  entity_type, entity_id, content
);
`

export async function openDB(dbPath: string): Promise<DB> {
  mkdirSync(dirname(dbPath), { recursive: true })
  const client = createClient({ url: `file:${dbPath}` })
  const db = drizzle(client, { schema })

  // Initialize schema: execute each statement separately since libSQL
  // doesn't support multi-statement exec natively
  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const stmt of statements) {
    await client.execute(stmt)
  }

  await client.execute('PRAGMA journal_mode=WAL')
  await client.execute('PRAGMA foreign_keys=ON')

  return db
}

export async function upsertSearchIndex(
  db: DB,
  entityType: string,
  entityId: string,
  content: string,
): Promise<void> {
  await db.run(sql`DELETE FROM search_index WHERE entity_id = ${entityId}`)
  await db.run(
    sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${entityType}, ${entityId}, ${content})`,
  )
}

export async function removeSearchIndex(
  db: DB,
  entityId: string,
): Promise<void> {
  await db.run(sql`DELETE FROM search_index WHERE entity_id = ${entityId}`)
}

export async function rebuildSearchIndex(db: DB): Promise<void> {
  await db.run(sql`DELETE FROM search_index`)

  const allContacts = await db.select().from(schema.contacts)
  for (const c of allContacts) {
    const content = await buildContactSearch(db, c)
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'contact'}, ${c.id}, ${content})`,
    )
  }

  const allCompanies = await db.select().from(schema.companies)
  for (const co of allCompanies) {
    const content = buildCompanySearch(co)
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'company'}, ${co.id}, ${content})`,
    )
  }

  const allDeals = await db.select().from(schema.deals)
  for (const d of allDeals) {
    const content = buildDealSearch(d)
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'deal'}, ${d.id}, ${content})`,
    )
  }

  const allActivities = await db.select().from(schema.activities)
  for (const a of allActivities) {
    const content = [a.type, a.body, a.custom_fields].filter(Boolean).join(' ')
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'activity'}, ${a.id}, ${content})`,
    )
  }
}
