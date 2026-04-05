import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from './helpers.ts'

describe('export-fs', () => {
  test('uses custom pipeline stages from config', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["discovery", "demo", "trial", "won", "lost"]\n`,
    )
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('--config', configPath, 'export-fs', outDir)
    const stages = readdirSync(join(outDir, 'deals', '_by-stage'))
    expect(stages).toContain('discovery')
    expect(stages).toContain('demo')
    expect(stages).toContain('trial')
    expect(stages).toContain('won')
    expect(stages).toContain('lost')
    expect(stages).not.toContain('lead')
    expect(stages).not.toContain('qualified')
  })

  test('pipeline.json reflects custom stages from config', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["alpha", "beta", "gamma"]\n`,
    )
    ctx.runOK(
      '--config',
      configPath,
      'deal',
      'add',
      '--title',
      'A',
      '--value',
      '5000',
      '--stage',
      'alpha',
    )
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('--config', configPath, 'export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'pipeline.json'), 'utf-8'),
    )
    const stageNames = data.map((s: { stage: string }) => s.stage)
    expect(stageNames).toContain('alpha')
    expect(stageNames).toContain('beta')
    expect(stageNames).toContain('gamma')
    expect(stageNames).not.toContain('lead')
    const alpha = data.find((s: { stage: string }) => s.stage === 'alpha')
    expect(alpha.count).toBe(1)
    expect(alpha.value).toBe(5000)
  })

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

  test('reports/stale.json contains stale contacts', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Stale Bob', '--email', 'bob@co.com')
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'reports', 'stale.json'), 'utf-8'),
    )
    const bob = data.find((r: { name?: string }) => r.name === 'Stale Bob')
    expect(bob).toBeDefined()
    expect(bob.type).toBe('contact')
    expect(bob.id).toBeDefined()
  })

  test('reports/forecast.json contains open deals with weighted values', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Forecast Deal',
      '--value',
      '40000',
      '--probability',
      '50',
    )
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'reports', 'forecast.json'), 'utf-8'),
    )
    expect(data).toHaveLength(1)
    expect(data[0].title).toBe('Forecast Deal')
    expect(data[0].value).toBe(40_000)
    expect(data[0].weighted).toBe(20_000)
  })

  test('reports/conversion.json has stage conversion rates', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Conv', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'qualified')
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'reports', 'conversion.json'), 'utf-8'),
    )
    expect(data.length).toBeGreaterThan(0)
    const lead = data.find((r: { stage: string }) => r.stage === 'lead')
    expect(lead).toBeDefined()
    expect(lead.entered).toBeGreaterThanOrEqual(1)
    expect(lead.advanced).toBeGreaterThanOrEqual(1)
  })

  test('reports/won.json contains closed-won deals', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Won Deal',
        '--value',
        '30000',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'reports', 'won.json'), 'utf-8'),
    )
    expect(data).toHaveLength(1)
    expect(data[0].title).toBe('Won Deal')
    expect(data[0].value).toBe(30_000)
  })

  test('reports/lost.json contains closed-lost deals with reasons', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Lost Deal',
        '--value',
        '15000',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK(
      'deal',
      'move',
      id,
      '--stage',
      'closed-lost',
      '--note',
      'Budget cut',
    )
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'reports', 'lost.json'), 'utf-8'),
    )
    expect(data).toHaveLength(1)
    expect(data[0].title).toBe('Lost Deal')
    expect(data[0].notes).toContain('Budget cut')
  })

  test('reports/velocity.json has timing data per stage', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Fast Deal', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'qualified')
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('export-fs', outDir)
    const data = JSON.parse(
      readFileSync(join(outDir, 'reports', 'velocity.json'), 'utf-8'),
    )
    expect(data.length).toBeGreaterThan(0)
    expect(data[0]).toHaveProperty('stage')
    expect(data[0]).toHaveProperty('avg_ms')
    expect(data[0]).toHaveProperty('deals')
    expect(data[0]).toHaveProperty('avg_display')
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
    ctx.runOK('log', 'note', 'Great call', '--contact', 'jane@acme.com')
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
    ctx.runOK('log', 'note', 'A note', '--contact', 'jane@acme.com')
    ctx.runOK('log', 'call', 'A call', '--contact', 'jane@acme.com')
    ctx.runOK('export-fs', outDir)
    const noteDir = join(outDir, 'activities', '_by-type', 'note')
    const callDir = join(outDir, 'activities', '_by-type', 'call')
    expect(readdirSync(noteDir)).toHaveLength(1)
    expect(readdirSync(callDir)).toHaveLength(1)
  })
})
