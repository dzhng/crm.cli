import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('import contacts', () => {
  test('import CSV', () => {
    const ctx = createTestContext()
    const csv = `name,email,phone,company,title,source,tags
Jane Doe,jane@acme.com,+1-555-0100,Acme,CTO,conference,"hot-lead,enterprise"
John Smith,john@globex.com,,Globex,Engineer,inbound,`
    const csvPath = join(ctx.dir, 'contacts.csv')
    writeFileSync(csvPath, csv)

    ctx.runOK('import', 'contacts', csvPath)

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(contacts).toHaveLength(2)
  })

  test('import JSON', () => {
    const ctx = createTestContext()
    const data = [
      { name: 'Alice', email: 'alice@example.com', title: 'CEO' },
      { name: 'Bob', email: 'bob@example.com', title: 'CTO' },
    ]
    const jsonPath = join(ctx.dir, 'contacts.json')
    writeFileSync(jsonPath, JSON.stringify(data))

    ctx.runOK('import', 'contacts', jsonPath)

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(contacts).toHaveLength(2)
  })

  test('dry-run does not persist', () => {
    const ctx = createTestContext()
    const csv = `name,email\nJane,jane@acme.com\n`
    const csvPath = join(ctx.dir, 'contacts.csv')
    writeFileSync(csvPath, csv)

    const out = ctx.runOK('import', 'contacts', csvPath, '--dry-run')
    expect(out).toContain('Jane')

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(contacts).toHaveLength(0)
  })

  test('skip-errors continues past bad rows', () => {
    const ctx = createTestContext()
    const csv = `name,email\nJane,jane@acme.com\n,invalid@example.com\nBob,bob@example.com\n`
    const csvPath = join(ctx.dir, 'contacts.csv')
    writeFileSync(csvPath, csv)

    ctx.runOK('import', 'contacts', csvPath, '--skip-errors')

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(contacts).toHaveLength(2)
  })

  test('update mode updates existing records', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--set', 'title=Engineer')

    const csv = `name,email,title\nJane Doe,jane@acme.com,CTO\n`
    const csvPath = join(ctx.dir, 'contacts.csv')
    writeFileSync(csvPath, csv)

    ctx.runOK('import', 'contacts', csvPath, '--update')

    const show = ctx.runOK('contact', 'show', 'jane@acme.com')
    expect(show).toContain('CTO')
  })
})

describe('import companies', () => {
  test('import CSV', () => {
    const ctx = createTestContext()
    const csv = `name,website,industry,size\nAcme Corp,acme.com,SaaS,50-200\nGlobex,globex.com,Manufacturing,1000+\n`
    const csvPath = join(ctx.dir, 'companies.csv')
    writeFileSync(csvPath, csv)

    ctx.runOK('import', 'companies', csvPath)

    const companies = ctx.runJSON<unknown[]>('company', 'list', '--format', 'json')
    expect(companies).toHaveLength(2)
  })
})

describe('import deals', () => {
  test('import CSV', () => {
    const ctx = createTestContext()
    const csv = `title,value,stage\nDeal A,50000,lead\nDeal B,25000,qualified\n`
    const csvPath = join(ctx.dir, 'deals.csv')
    writeFileSync(csvPath, csv)

    ctx.runOK('import', 'deals', csvPath)

    const deals = ctx.runJSON<unknown[]>('deal', 'list', '--format', 'json')
    expect(deals).toHaveLength(2)
  })
})

describe('export', () => {
  test('export contacts CSV', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com')
    ctx.runOK('contact', 'add', '--name', 'Bob Smith', '--email', 'bob@globex.com')

    const out = ctx.runOK('export', 'contacts', '--format', 'csv')
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(3) // header + 2 rows
  })

  test('export contacts JSON', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com')

    const contacts = ctx.runJSON<unknown[]>('export', 'contacts', '--format', 'json')
    expect(contacts).toHaveLength(1)
  })

  test('export deals JSON', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Deal A', '--value', '50000')

    const deals = ctx.runJSON<unknown[]>('export', 'deals', '--format', 'json')
    expect(deals).toHaveLength(1)
  })

  test('export all', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('company', 'add', '--name', 'Acme')
    ctx.runOK('deal', 'add', '--title', 'Deal')

    const exported = ctx.runJSON<Record<string, unknown>>('export', 'all', '--format', 'json')
    expect(exported).toHaveProperty('contacts')
    expect(exported).toHaveProperty('companies')
    expect(exported).toHaveProperty('deals')
    expect(exported).toHaveProperty('activities')
  })
})

describe('roundtrip', () => {
  test('export then import preserves data', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--tag', 'vip')

    const exported = ctx.runOK('export', 'contacts', '--format', 'json')
    const exportPath = join(ctx.dir, 'exported.json')
    writeFileSync(exportPath, exported)

    const ctx2 = createTestContext()
    ctx2.runOK('import', 'contacts', exportPath)

    const show = ctx2.runOK('contact', 'show', 'jane@acme.com')
    expect(show).toContain('Jane Doe')
    expect(show).toContain('vip')
  })
})
