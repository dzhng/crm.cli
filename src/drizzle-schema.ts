import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emails: text('emails').notNull().default('[]'),
  phones: text('phones').notNull().default('[]'),
  companies: text('companies').notNull().default('[]'),
  linkedin: text('linkedin'),
  x: text('x'),
  bluesky: text('bluesky'),
  telegram: text('telegram'),
  tags: text('tags').notNull().default('[]'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  websites: text('websites').notNull().default('[]'),
  phones: text('phones').notNull().default('[]'),
  tags: text('tags').notNull().default('[]'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const deals = sqliteTable('deals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  value: integer('value'),
  stage: text('stage').notNull(),
  contacts: text('contacts').notNull().default('[]'),
  company: text('company'),
  expected_close: text('expected_close'),
  probability: integer('probability'),
  tags: text('tags').notNull().default('[]'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const activities = sqliteTable('activities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  body: text('body').notNull().default(''),
  contact: text('contact'),
  company: text('company'),
  deal: text('deal'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
})
