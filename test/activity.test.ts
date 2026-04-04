import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('log', () => {
  test('log note to contact', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Had a great intro call')

    const activities = ctx.runJSON<Array<{ type: string }>>('activity', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(activities).toHaveLength(1)
    expect(activities[0].type).toBe('note')
  })

  test('log call with duration as custom field', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'call', 'jane@acme.com', 'Demo scheduled', '--set', 'duration=15m')

    const activities = ctx.runJSON<Array<{ type: string }>>('activity', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(activities).toHaveLength(1)
    expect(activities[0].type).toBe('call')
  })

  test('log meeting', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'meeting', 'jane@acme.com', 'Went through pricing')

    const activities = ctx.runJSON<Array<{ type: string }>>('activity', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(activities[0].type).toBe('meeting')
  })

  test('log email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'email', 'jane@acme.com', 'Sent proposal PDF')

    const activities = ctx.runJSON<Array<{ type: string }>>('activity', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(activities[0].type).toBe('email')
  })

  test('rejects invalid type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runFail('log', 'tweet', 'jane@acme.com', 'Hello')
  })

  test('fails for nonexistent contact', () => {
    const ctx = createTestContext()
    ctx.runFail('log', 'note', 'nobody@example.com', 'This should fail')
  })

  test('log with deal link', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    const dealID = ctx.runOK('deal', 'add', '--title', 'Big Deal', '--contact', 'jane@acme.com').trim()

    ctx.runOK('log', 'note', 'jane@acme.com', 'Discussed pricing', '--deal', dealID)

    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--deal', dealID, '--format', 'json')
    expect(activities).toHaveLength(1)
  })

  test('log with custom timestamp', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Backdated note', '--at', '2026-01-15')

    const activities = ctx.runJSON<Array<{ created_at: string }>>('activity', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(activities[0].created_at).toContain('2026-01-15')
  })
})

describe('activity list', () => {
  test('filter by type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'A note')
    ctx.runOK('log', 'call', 'jane@acme.com', 'A call')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Another note')

    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--type', 'note', '--format', 'json')
    expect(activities).toHaveLength(2)
  })

  test('filter by since', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Old note', '--at', '2025-01-01')
    ctx.runOK('log', 'note', 'jane@acme.com', 'New note', '--at', '2026-03-01')

    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--since', '2026-01-01', '--format', 'json')
    expect(activities).toHaveLength(1)
  })

  test('limit', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Note 1')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Note 2')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Note 3')

    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--contact', 'jane@acme.com', '--limit', '2', '--format', 'json')
    expect(activities).toHaveLength(2)
  })

  test('activity on company', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK('log', 'note', 'acme.com', 'Company-level note')

    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--company', 'acme.com', '--format', 'json')
    expect(activities).toHaveLength(1)
  })

  test('activity on deal', () => {
    const ctx = createTestContext()
    const dealID = ctx.runOK('deal', 'add', '--title', 'Big Deal').trim()
    ctx.runOK('log', 'note', dealID, 'Deal-level note')

    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--deal', dealID, '--format', 'json')
    expect(activities).toHaveLength(1)
  })
})
