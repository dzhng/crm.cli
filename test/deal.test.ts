import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('deal add', () => {
  test('basic add returns prefixed ID', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('deal', 'add', '--title', 'Acme Enterprise')
    expect(out.trim()).toStartWith('dl_')
  })

  test('full add stores all fields', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')

    const id = ctx
      .runOK(
        'deal', 'add',
        '--title', 'Acme Enterprise',
        '--value', '50000',
        '--stage', 'qualified',
        '--contact', 'jane@acme.com',
        '--company', 'acme.com',
        '--expected-close', '2026-06-01',
        '--probability', '60',
        '--tag', 'q2',
        '--set', 'source=outbound',
      )
      .trim()

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('Acme Enterprise')
    expect(show).toContain('50000')
    expect(show).toContain('qualified')
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('2026-06-01')
    expect(show).toContain('q2')
  })

  test('fails without --title', () => {
    const ctx = createTestContext()
    const result = ctx.runFail('deal', 'add', '--value', '10000')
    expect(result.stderr).toContain('title')
  })

  test('defaults to first pipeline stage', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'New Deal').trim()
    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('lead')
  })
})

describe('deal list', () => {
  test('returns all deals', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Deal A', '--value', '10000', '--stage', 'lead')
    ctx.runOK('deal', 'add', '--title', 'Deal B', '--value', '50000', '--stage', 'qualified')
    ctx.runOK('deal', 'add', '--title', 'Deal C', '--value', '20000', '--stage', 'lead')

    const deals = ctx.runJSON<unknown[]>('deal', 'list', '--format', 'json')
    expect(deals).toHaveLength(3)
  })

  test('filter by stage', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Deal A', '--stage', 'lead')
    ctx.runOK('deal', 'add', '--title', 'Deal B', '--stage', 'qualified')

    const deals = ctx.runJSON<unknown[]>('deal', 'list', '--stage', 'lead', '--format', 'json')
    expect(deals).toHaveLength(1)
  })

  test('filter by value range', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Small', '--value', '5000')
    ctx.runOK('deal', 'add', '--title', 'Medium', '--value', '25000')
    ctx.runOK('deal', 'add', '--title', 'Large', '--value', '100000')

    const deals = ctx.runJSON<unknown[]>('deal', 'list', '--min-value', '10000', '--max-value', '50000', '--format', 'json')
    expect(deals).toHaveLength(1)
  })

  test('filter by linked contact', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('deal', 'add', '--title', "Jane's Deal", '--contact', 'jane@acme.com')
    ctx.runOK('deal', 'add', '--title', 'Unlinked Deal')

    const deals = ctx.runJSON<unknown[]>('deal', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(deals).toHaveLength(1)
  })

  test('sort by value ascending', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Small', '--value', '5000')
    ctx.runOK('deal', 'add', '--title', 'Large', '--value', '100000')
    ctx.runOK('deal', 'add', '--title', 'Medium', '--value', '25000')

    const deals = ctx.runJSON<Array<{ value: number }>>('deal', 'list', '--sort', 'value', '--format', 'json')
    expect(deals[0].value).toBeLessThanOrEqual(deals[1].value)
    expect(deals[1].value).toBeLessThanOrEqual(deals[2].value)
  })
})

describe('deal move', () => {
  test('changes stage', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Moving Deal', '--stage', 'lead').trim()
    ctx.runOK('deal', 'move', id, '--stage', 'qualified')

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('qualified')
  })

  test('rejects invalid stage', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Deal').trim()
    const result = ctx.runFail('deal', 'move', id, '--stage', 'nonexistent')
    expect(result.stderr).toContain('stage')
  })

  test('records stage history', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'History Deal', '--stage', 'lead').trim()
    ctx.runOK('deal', 'move', id, '--stage', 'qualified')
    ctx.runOK('deal', 'move', id, '--stage', 'proposal')

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('lead')
    expect(show).toContain('qualified')
    expect(show).toContain('proposal')
  })

  test('with note', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Deal').trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won', '--note', 'Signed annual contract')

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('Signed annual contract')
  })

  test('closed-lost with reason', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Lost Deal').trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-lost', '--reason', 'Budget cut')

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('closed-lost')
    expect(show).toContain('Budget cut')
  })
})

describe('deal edit', () => {
  test('update title and value', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Old Title', '--value', '10000').trim()
    ctx.runOK('deal', 'edit', id, '--title', 'New Title', '--value', '20000')

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('New Title')
    expect(show).toContain('20000')
  })
})

describe('deal rm', () => {
  test('delete deal', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Delete Me').trim()
    ctx.runOK('deal', 'rm', id, '--force')
    ctx.runFail('deal', 'show', id)
  })
})

describe('pipeline', () => {
  test('shows pipeline summary', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'A', '--value', '10000', '--stage', 'lead')
    ctx.runOK('deal', 'add', '--title', 'B', '--value', '20000', '--stage', 'lead')
    ctx.runOK('deal', 'add', '--title', 'C', '--value', '50000', '--stage', 'qualified')

    const out = ctx.runOK('pipeline')
    expect(out).toContain('lead')
    expect(out).toContain('qualified')
    expect(out).toContain('Total')
  })

  test('json format', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'A', '--value', '10000', '--stage', 'lead')

    const pipeline = ctx.runJSON<Array<{ stage: string; count: number; value: number }>>('pipeline', '--format', 'json')
    expect(pipeline.length).toBeGreaterThan(0)
    expect(pipeline[0]).toHaveProperty('stage')
    expect(pipeline[0]).toHaveProperty('count')
    expect(pipeline[0]).toHaveProperty('value')
  })

  test('deal show includes linked company', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    const id = ctx.runOK('deal', 'add', '--title', 'Acme Deal', '--company', 'acme.com').trim()

    const coShow = ctx.runOK('company', 'show', 'acme.com')
    expect(coShow).toContain('Acme Deal')

    const dlShow = ctx.runOK('deal', 'show', id)
    expect(dlShow).toContain('Acme')
  })
})
