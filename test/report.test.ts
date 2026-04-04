import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('report pipeline', () => {
  test('shows stage breakdown', () => {
    const ctx = createTestContext()
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
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'B',
      '--value',
      '20000',
      '--stage',
      'lead',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'C',
      '--value',
      '50000',
      '--stage',
      'qualified',
    )

    const out = ctx.runOK('report', 'pipeline')
    expect(out).toContain('lead')
    expect(out).toContain('qualified')
    expect(out).toContain('Total')
  })

  test('json format has stage/count/value fields', () => {
    const ctx = createTestContext()
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

    const report = ctx.runJSON<
      Array<{ stage: string; count: number; value: number }>
    >('report', 'pipeline', '--format', 'json')
    expect(report.length).toBeGreaterThan(0)
    expect(report[0]).toHaveProperty('stage')
    expect(report[0]).toHaveProperty('count')
    expect(report[0]).toHaveProperty('value')
  })

  test('works with no deals', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('report', 'pipeline')
    expect(out).toContain('Total')
  })
})

describe('report activity', () => {
  test('shows activity summary', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Note 1')
    ctx.runOK('log', 'call', 'jane@acme.com', 'Call 1')

    const out = ctx.runOK('report', 'activity')
    expect(out).toContain('note')
    expect(out).toContain('call')
  })

  test('group by type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'N1')
    ctx.runOK('log', 'note', 'jane@acme.com', 'N2')
    ctx.runOK('log', 'call', 'jane@acme.com', 'C1')

    const report = ctx.runJSON<unknown[]>(
      'report',
      'activity',
      '--by',
      'type',
      '--format',
      'json',
    )
    expect(report.length).toBeGreaterThan(0)
  })

  test('group by contact', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'N1')
    ctx.runOK('log', 'note', 'jane@acme.com', 'N2')
    ctx.runOK('log', 'note', 'bob@acme.com', 'N3')

    const report = ctx.runJSON<unknown[]>(
      'report',
      'activity',
      '--by',
      'contact',
      '--format',
      'json',
    )
    expect(report.length).toBeGreaterThanOrEqual(2)
  })

  test('period filter', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Old', '--at', '2025-01-01')
    ctx.runOK('log', 'note', 'jane@acme.com', 'Recent')

    const report = ctx.runJSON<Array<{ count: number }>>(
      'report',
      'activity',
      '--period',
      '7d',
      '--format',
      'json',
    )
    const hasActivity = report.some((r) => r.count > 0)
    expect(hasActivity).toBe(true)
  })
})

describe('report stale', () => {
  test('flags contacts with no activity', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Active Jane',
      '--email',
      'jane@acme.com',
    )
    ctx.runOK('log', 'note', 'jane@acme.com', 'Just spoke')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Stale Bob',
      '--email',
      'bob@acme.com',
    )

    const out = ctx.runOK('report', 'stale', '--days', '1')
    expect(out).toContain('Stale Bob')
    expect(out).not.toContain('Active Jane')
  })

  test('recently created deals are not stale', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Fresh Deal')

    const out = ctx.runOK('report', 'stale', '--type', 'deal')
    expect(out).not.toContain('Fresh Deal')
  })
})

describe('report conversion', () => {
  test('shows stage conversion rates', () => {
    const ctx = createTestContext()
    for (let i = 0; i < 5; i++) {
      ctx.runOK('deal', 'add', '--title', `Lead ${i}`, '--stage', 'lead')
    }
    const deals = ctx.runJSON<Array<{ id: string }>>(
      'deal',
      'list',
      '--stage',
      'lead',
      '--format',
      'json',
    )
    for (let i = 0; i < 3; i++) {
      ctx.runOK('deal', 'move', deals[i].id, '--stage', 'qualified')
    }

    const out = ctx.runOK('report', 'conversion')
    expect(out).toContain('lead')
    expect(out).toContain('qualified')
  })

  test('json format', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Deal A', '--stage', 'lead')

    const report = ctx.runJSON<unknown[]>(
      'report',
      'conversion',
      '--format',
      'json',
    )
    expect(report.length).toBeGreaterThan(0)
  })
})

describe('report velocity', () => {
  test('shows time per stage', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Fast Deal', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'qualified')
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const out = ctx.runOK('report', 'velocity')
    expect(out).toContain('lead')
    expect(out).toContain('qualified')
  })
})

describe('report forecast', () => {
  test('shows weighted forecast', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Deal A',
      '--value',
      '50000',
      '--probability',
      '80',
      '--expected-close',
      '2026-06-15',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Deal B',
      '--value',
      '30000',
      '--probability',
      '50',
      '--expected-close',
      '2026-06-20',
    )

    const out = ctx.runOK('report', 'forecast')
    expect(out).toContain('Deal A')
    expect(out).toContain('Deal B')
  })

  test('period filter', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Q2 Deal',
      '--value',
      '50000',
      '--expected-close',
      '2026-06-15',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Q3 Deal',
      '--value',
      '30000',
      '--expected-close',
      '2026-09-15',
    )

    const report = ctx.runJSON<unknown[]>(
      'report',
      'forecast',
      '--period',
      '2026-06',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
  })
})

describe('report won/lost', () => {
  test('report won shows closed-won deals', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Won Deal',
        '--value',
        '25000',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const out = ctx.runOK('report', 'won')
    expect(out).toContain('Won Deal')
    expect(out).toContain('25000')
  })

  test('report lost shows reasons', () => {
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
      '--reason',
      'Too expensive',
    )

    const out = ctx.runOK('report', 'lost', '--reasons')
    expect(out).toContain('Lost Deal')
    expect(out).toContain('Too expensive')
  })

  test('report won with period', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Won Deal',
        '--value',
        '25000',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const report = ctx.runJSON<unknown[]>(
      'report',
      'won',
      '--period',
      '30d',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
  })
})
