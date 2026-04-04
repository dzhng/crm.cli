import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
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
  contact TEXT,
  company TEXT,
  deal TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  entity_type, entity_id, content
);
`;

export function openDB(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
  return db
}

export function upsertSearchIndex(db: Database, entityType: string, entityId: string, content: string): void {
  db.run('DELETE FROM search_index WHERE entity_id = ?', [entityId])
  db.run('INSERT INTO search_index (entity_type, entity_id, content) VALUES (?, ?, ?)', [entityType, entityId, content])
}

export function removeSearchIndex(db: Database, entityId: string): void {
  db.run('DELETE FROM search_index WHERE entity_id = ?', [entityId])
}

export function rebuildSearchIndex(db: Database): void {
  db.run('DELETE FROM search_index')

  const contacts = db.query('SELECT * FROM contacts').all() as any[]
  for (const c of contacts) {
    const content = [c.name, c.emails, c.phones, c.linkedin, c.x, c.bluesky, c.telegram, c.tags, c.custom_fields].filter(Boolean).join(' ')
    db.run('INSERT INTO search_index (entity_type, entity_id, content) VALUES (?, ?, ?)', ['contact', c.id, content])
  }

  const companies = db.query('SELECT * FROM companies').all() as any[]
  for (const co of companies) {
    const content = [co.name, co.websites, co.phones, co.tags, co.custom_fields].filter(Boolean).join(' ')
    db.run('INSERT INTO search_index (entity_type, entity_id, content) VALUES (?, ?, ?)', ['company', co.id, content])
  }

  const deals = db.query('SELECT * FROM deals').all() as any[]
  for (const d of deals) {
    const content = [d.title, d.stage, d.tags, d.custom_fields].filter(Boolean).join(' ')
    db.run('INSERT INTO search_index (entity_type, entity_id, content) VALUES (?, ?, ?)', ['deal', d.id, content])
  }

  const activities = db.query('SELECT * FROM activities').all() as any[]
  for (const a of activities) {
    const content = [a.type, a.body, a.custom_fields].filter(Boolean).join(' ')
    db.run('INSERT INTO search_index (entity_type, entity_id, content) VALUES (?, ?, ?)', ['activity', a.id, content])
  }
}
