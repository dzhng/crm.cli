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

  test('report lost without --reasons omits reason field', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Lost', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-lost', '--reason', 'Price')

    const report = ctx.runJSON<Record<string, unknown>[]>(
      'report',
      'lost',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0]).not.toHaveProperty('reason')
  })

  test('report lost with --period filters old deals', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Recent Loss', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-lost')

    const report = ctx.runJSON<unknown[]>(
      'report',
      'lost',
      '--period',
      '30d',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
  })

  test('report won json format includes all deal fields', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Full Won',
        '--value',
        '50000',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const report = ctx.runJSON<Record<string, unknown>[]>(
      'report',
      'won',
      '--format',
      'json',
    )
    expect(report[0]).toHaveProperty('id')
    expect(report[0]).toHaveProperty('title')
    expect(report[0]).toHaveProperty('value')
    expect(report[0]).toHaveProperty('stage')
    expect(report[0].stage).toBe('closed-won')
  })
})

describe('report edge cases', () => {
  test('stale report excludes closed-won deals', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Closed Won', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const report = ctx.runJSON<Array<{ title?: string }>>(
      'report',
      'stale',
      '--type',
      'deal',
      '--format',
      'json',
    )
    const titles = report.map((r) => r.title)
    expect(titles).not.toContain('Closed Won')
  })

  test('stale report excludes closed-lost deals', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Closed Lost', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-lost')

    const report = ctx.runJSON<Array<{ title?: string }>>(
      'report',
      'stale',
      '--type',
      'deal',
      '--format',
      'json',
    )
    const titles = report.map((r) => r.title)
    expect(titles).not.toContain('Closed Lost')
  })

  test('stale report with no stale entities shows message', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Active Jane', '--email', 'j@co.com')
    ctx.runOK('log', 'note', 'j@co.com', 'Just talked')

    const out = ctx.runOK('report', 'stale', '--days', '30')
    expect(out).toContain('No stale entities found')
  })

  test('stale --type contact filters to contacts only', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Stale Jane')
    ctx.runOK('deal', 'add', '--title', 'Stale Deal')

    const report = ctx.runJSON<Array<{ type: string }>>(
      'report',
      'stale',
      '--type',
      'contact',
      '--days',
      '0',
      '--format',
      'json',
    )
    for (const r of report) {
      expect(r.type).toBe('contact')
    }
  })

  test('forecast excludes terminal stage deals', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Open',
      '--value',
      '5000',
      '--stage',
      'lead',
    )
    const id = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Won',
        '--value',
        '3000',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const report = ctx.runJSON<Array<{ title: string }>>(
      'report',
      'forecast',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0].title).toBe('Open')
  })

  test('forecast defaults probability to 100 when not set', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'No Prob', '--value', '10000')

    const report = ctx.runJSON<
      Array<{ probability: number; weighted: number }>
    >('report', 'forecast', '--format', 'json')
    expect(report[0].probability).toBe(100)
    expect(report[0].weighted).toBe(10_000)
  })

  test('forecast with relative period filter (30d)', () => {
    const ctx = createTestContext()
    const future = new Date(Date.now() + 15 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Soon',
      '--value',
      '1000',
      '--expected-close',
      future,
    )

    const report = ctx.runJSON<unknown[]>(
      'report',
      'forecast',
      '--period',
      '30d',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
  })

  test('velocity with empty DB returns stages with 0', () => {
    const ctx = createTestContext()
    const report = ctx.runJSON<Array<{ avg_ms: number; deals: number }>>(
      'report',
      'velocity',
      '--format',
      'json',
    )
    expect(report.length).toBeGreaterThan(0)
    for (const s of report) {
      expect(s.avg_ms).toBe(0)
      expect(s.deals).toBe(0)
    }
  })

  test('conversion with empty DB returns 0% rates', () => {
    const ctx = createTestContext()
    const report = ctx.runJSON<Array<{ rate: string }>>(
      'report',
      'conversion',
      '--format',
      'json',
    )
    expect(report.length).toBeGreaterThan(0)
    for (const s of report) {
      expect(s.rate).toBe('0%')
    }
  })

  test('conversion tracks entries and exits correctly', () => {
    const ctx = createTestContext()
    for (let i = 0; i < 4; i++) {
      ctx.runOK('deal', 'add', '--title', `D${i}`, '--stage', 'lead')
    }
    const deals = ctx.runJSON<Array<{ id: string }>>(
      'deal',
      'list',
      '--stage',
      'lead',
      '--format',
      'json',
    )
    // Move 2 of 4 to qualified
    ctx.runOK('deal', 'move', deals[0].id, '--stage', 'qualified')
    ctx.runOK('deal', 'move', deals[1].id, '--stage', 'qualified')

    const report = ctx.runJSON<
      Array<{ stage: string; entered: number; advanced: number; rate: string }>
    >('report', 'conversion', '--format', 'json')
    const lead = report.find((r) => r.stage === 'lead')
    expect(lead).toBeDefined()
    expect(lead!.entered).toBe(4)
    expect(lead!.advanced).toBe(2)
    expect(lead!.rate).toBe('50%')
  })

  test('velocity json includes avg_display', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'V', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'qualified')

    const report = ctx.runJSON<Array<{ stage: string; avg_display: string }>>(
      'report',
      'velocity',
      '--format',
      'json',
    )
    const lead = report.find((r) => r.stage === 'lead')
    expect(lead).toBeDefined()
    expect(lead!.avg_display).toBeDefined()
    expect(typeof lead!.avg_display).toBe('string')
  })

  test('lost deal with no reason returns empty reason', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'No Reason', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-lost')

    const report = ctx.runJSON<Array<{ reason: string }>>(
      'report',
      'lost',
      '--reasons',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0].reason).toBe('')
  })
})
