import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('log', () => {
  test('log note to contact', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK(
      'log',
      'note',
      'Had a great intro call',
      '--contact',
      'jane@acme.com',
    )

    const activities = ctx.runJSON<Array<{ type: string }>>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
    expect(activities[0].type).toBe('note')
  })

  test('log call with duration as custom field', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK(
      'log',
      'call',
      'Demo scheduled',
      '--contact',
      'jane@acme.com',
      '--set',
      'duration=15m',
    )

    const activities = ctx.runJSON<Array<{ type: string }>>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
    expect(activities[0].type).toBe('call')
  })

  test('log meeting', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK(
      'log',
      'meeting',
      'Went through pricing',
      '--contact',
      'jane@acme.com',
    )

    const activities = ctx.runJSON<Array<{ type: string }>>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(activities[0].type).toBe('meeting')
  })

  test('log email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'email', 'Sent proposal PDF', '--contact', 'jane@acme.com')

    const activities = ctx.runJSON<Array<{ type: string }>>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(activities[0].type).toBe('email')
  })

  test('rejects invalid type', () => {
    const ctx = createTestContext()
    ctx.runFail('log', 'tweet', 'Hello')
  })

  test('fails for nonexistent contact', () => {
    const ctx = createTestContext()
    ctx.runFail(
      'log',
      'note',
      'This should fail',
      '--contact',
      'nobody@example.com',
    )
  })

  test('log with deal link', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    const dealID = ctx
      .runOK('deal', 'add', '--title', 'Big Deal', '--contact', 'jane@acme.com')
      .trim()

    ctx.runOK(
      'log',
      'note',
      'Discussed pricing',
      '--contact',
      'jane@acme.com',
      '--deal',
      dealID,
    )

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--deal',
      dealID,
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('log with custom timestamp', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK(
      'log',
      'note',
      'Backdated note',
      '--contact',
      'jane@acme.com',
      '--at',
      '2026-01-15',
    )

    const activities = ctx.runJSON<Array<{ created_at: string }>>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(activities[0].created_at).toContain('2026-01-15')
  })

  test('log on company', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK('log', 'note', 'Company-level note', '--company', 'Acme')

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--company',
      'acme.com',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('log on deal directly', () => {
    const ctx = createTestContext()
    const dealID = ctx.runOK('deal', 'add', '--title', 'Big Deal').trim()
    ctx.runOK('log', 'note', 'Deal-level note', '--deal', dealID)

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--deal',
      dealID,
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('log with no entity links creates standalone activity', () => {
    const ctx = createTestContext()
    ctx.runOK('log', 'note', 'General note with no links')

    const activities = ctx.runJSON<Array<{ body: string }>>(
      'activity',
      'list',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
    expect(activities[0].body).toBe('General note with no links')
  })

  test('--company auto-creates company if it does not exist', () => {
    const ctx = createTestContext()
    ctx.runOK('log', 'note', 'First touch', '--company', 'NewCo')

    // Company should have been auto-created
    const companies = ctx.runJSON<Array<{ name: string }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(1)
    expect(companies[0].name).toBe('NewCo')

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--company',
      'NewCo',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('--deal fails for nonexistent deal', () => {
    const ctx = createTestContext()
    ctx.runFail('log', 'note', 'Bad deal ref', '--deal', 'dl_nonexistent')
  })
})

describe('activity list', () => {
  test('filter by type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'A note', '--contact', 'jane@acme.com')
    ctx.runOK('log', 'call', 'A call', '--contact', 'jane@acme.com')
    ctx.runOK('log', 'note', 'Another note', '--contact', 'jane@acme.com')

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--type',
      'note',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(2)
  })

  test('filter by since', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK(
      'log',
      'note',
      'Old note',
      '--contact',
      'jane@acme.com',
      '--at',
      '2025-01-01',
    )
    ctx.runOK(
      'log',
      'note',
      'New note',
      '--contact',
      'jane@acme.com',
      '--at',
      '2026-03-01',
    )

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--since',
      '2026-01-01',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('limit', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'Note 1', '--contact', 'jane@acme.com')
    ctx.runOK('log', 'note', 'Note 2', '--contact', 'jane@acme.com')
    ctx.runOK('log', 'note', 'Note 3', '--contact', 'jane@acme.com')

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--limit',
      '2',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(2)
  })
})

describe('multi-contact activity', () => {
  test('log with multiple --contact flags', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@acme.com')
    ctx.runOK(
      'log',
      'meeting',
      'Joint call',
      '--contact',
      'jane@acme.com',
      '--contact',
      'bob@acme.com',
    )

    const janeActs = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(janeActs).toHaveLength(1)

    const bobActs = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--contact',
      'bob@acme.com',
      '--format',
      'json',
    )
    expect(bobActs).toHaveLength(1)
  })

  test('contacts array in json output', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()
    const id2 = ctx
      .runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@acme.com')
      .trim()
    ctx.runOK(
      'log',
      'call',
      'Group call',
      '--contact',
      'jane@acme.com',
      '--contact',
      'bob@acme.com',
    )

    const activities = ctx.runJSON<Array<{ contacts: string[] }>>(
      'activity',
      'list',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
    expect(activities[0].contacts).toContain(id1)
    expect(activities[0].contacts).toContain(id2)
  })

  test('activity on company has empty contacts array', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK('log', 'note', 'Company note', '--company', 'Acme')

    const activities = ctx.runJSON<Array<{ contacts: string[] }>>(
      'activity',
      'list',
      '--format',
      'json',
    )
    expect(activities[0].contacts).toEqual([])
  })

  test('--contact and --company together', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK(
      'log',
      'note',
      'Met with Jane at Acme',
      '--contact',
      'jane@acme.com',
      '--company',
      'Acme',
    )

    const janeActs = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(janeActs).toHaveLength(1)

    const coActs = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--company',
      'acme.com',
      '--format',
      'json',
    )
    expect(coActs).toHaveLength(1)
  })
})
