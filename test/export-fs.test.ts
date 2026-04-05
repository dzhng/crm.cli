import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from './helpers.ts'

describe('export-fs', () => {
  test('creates top-level directories', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const entries = readdirSync(outDir)
    expect(entries).toContain('contacts')
    expect(entries).toContain('companies')
    expect(entries).toContain('deals')
    expect(entries).toContain('activities')
    expect(entries).toContain('reports')
    expect(entries).toContain('search')
    expect(entries).toContain('pipeline.json')
    expect(entries).toContain('tags.json')
  })

  test('contacts/ has _by-* subdirs', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const entries = readdirSync(join(outDir, 'contacts'))
    expect(entries).toContain('_by-email')
    expect(entries).toContain('_by-phone')
    expect(entries).toContain('_by-linkedin')
    expect(entries).toContain('_by-x')
    expect(entries).toContain('_by-bluesky')
    expect(entries).toContain('_by-telegram')
    expect(entries).toContain('_by-company')
    expect(entries).toContain('_by-tag')
  })

  test('companies/ has _by-* subdirs', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const entries = readdirSync(join(outDir, 'companies'))
    expect(entries).toContain('_by-website')
    expect(entries).toContain('_by-phone')
    expect(entries).toContain('_by-tag')
  })

  test('deals/ has _by-stage with all pipeline stages', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const stages = readdirSync(join(outDir, 'deals', '_by-stage'))
    expect(stages).toContain('lead')
    expect(stages).toContain('qualified')
    expect(stages).toContain('proposal')
    expect(stages).toContain('negotiation')
    expect(stages).toContain('closed-won')
    expect(stages).toContain('closed-lost')
  })

  test('activities/ has _by-contact, _by-company, _by-deal, _by-type', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const entries = readdirSync(join(outDir, 'activities'))
    expect(entries).toContain('_by-contact')
    expect(entries).toContain('_by-company')
    expect(entries).toContain('_by-deal')
    expect(entries).toContain('_by-type')
  })

  test('contact file appears with correct JSON after add', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--set',
      'title=CTO',
    )
    ctx.runOK('export-fs', outDir)
    const files = readdirSync(join(outDir, 'contacts')).filter(
      (f) => f.endsWith('.json') && !f.startsWith('_'),
    )
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('jane-doe')
    const data = JSON.parse(
      readFileSync(join(outDir, 'contacts', files[0]), 'utf-8'),
    )
    expect(data.name).toBe('Jane Doe')
    expect(data.emails).toContain('jane@acme.com')
    expect(data.custom_fields.title).toBe('CTO')
  })

  test('_by-email symlink resolves to contact', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('export-fs', outDir)
    const emailFile = join(
      outDir,
      'contacts',
      '_by-email',
      'jane@acme.com.json',
    )
    expect(existsSync(emailFile)).toBe(true)
    const data = JSON.parse(readFileSync(emailFile, 'utf-8'))
    expect(data.name).toBe('Jane')
  })

  test('_by-tag groups contacts', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('contact', 'add', '--name', 'Jane', '--tag', 'vip')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--tag', 'vip')
    ctx.runOK('export-fs', outDir)
    const vipDir = join(outDir, 'contacts', '_by-tag', 'vip')
    expect(readdirSync(vipDir)).toHaveLength(2)
  })

  test('company file with _by-website symlinks', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK('export-fs', outDir)
    const websiteFile = join(
      outDir,
      'companies',
      '_by-website',
      'acme.com.json',
    )
    expect(existsSync(websiteFile)).toBe(true)
    const data = JSON.parse(readFileSync(websiteFile, 'utf-8'))
    expect(data.name).toBe('Acme Corp')
  })

  test('deal appears in _by-stage', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Big Deal',
      '--stage',
      'lead',
      '--value',
      '50000',
    )
    ctx.runOK('export-fs', outDir)
    const leadDeals = readdirSync(join(outDir, 'deals', '_by-stage', 'lead'))
    expect(leadDeals).toHaveLength(1)
  })

  test('pipeline.json contains valid data', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'A',
      '--value',
      '10000',
      '--stage',
      'lead',
    )
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'pipeline.json'), 'utf-8'),
    )
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    expect(data[0]).toHaveProperty('stage')
    expect(data[0]).toHaveProperty('count')
  })

  test('tags.json lists tags with counts', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('contact', 'add', '--name', 'Alice', '--tag', 'vip')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--tag', 'vip')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(readFileSync(join(outDir, 'tags.json'), 'utf-8'))
    const vip = data.find((t: { tag: string }) => t.tag === 'vip')
    expect(vip).toBeDefined()
    expect(vip.count).toBe(2)
  })

  test('reports/ contains report files', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const reports = readdirSync(join(outDir, 'reports'))
    expect(reports).toContain('pipeline.json')
    expect(reports).toContain('stale.json')
    expect(reports).toContain('forecast.json')
    expect(reports).toContain('conversion.json')
    expect(reports).toContain('velocity.json')
    expect(reports).toContain('won.json')
    expect(reports).toContain('lost.json')
  })

  test('contact file includes linked companies, deals, and recent_activity', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane',
      '--email',
      'jane@acme.com',
      '--company',
      'Acme Corp',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Big Deal',
      '--value',
      '50000',
      '--contact',
      'jane@acme.com',
    )
    ctx.runOK('log', 'note', 'jane@acme.com', 'Great call')
    ctx.runOK('export-fs', outDir)
    const emailFile = join(
      outDir,
      'contacts',
      '_by-email',
      'jane@acme.com.json',
    )
    const data = JSON.parse(readFileSync(emailFile, 'utf-8'))
    expect(data.companies).toHaveLength(1)
    expect(data.companies[0].name).toBe('Acme Corp')
    expect(data.deals).toHaveLength(1)
    expect(data.deals[0].title).toBe('Big Deal')
    expect(data.recent_activity).toHaveLength(1)
    expect(data.recent_activity[0].note).toContain('Great call')
  })

  test('activities/_by-type groups by activity type', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'A note')
    ctx.runOK('log', 'call', 'jane@acme.com', 'A call')
    ctx.runOK('export-fs', outDir)
    const noteDir = join(outDir, 'activities', '_by-type', 'note')
    const callDir = join(outDir, 'activities', '_by-type', 'call')
    expect(readdirSync(noteDir)).toHaveLength(1)
    expect(readdirSync(callDir)).toHaveLength(1)
  })
})
