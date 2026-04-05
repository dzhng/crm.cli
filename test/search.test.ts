import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('search (keyword FTS5)', () => {
  test('search by name', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'John Smith',
      '--email',
      'john@globex.com',
    )

    const out = ctx.runOK('search', 'Jane')
    expect(out).toContain('Jane Doe')
    expect(out).not.toContain('John Smith')
  })

  test('search by email host', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
    )

    const out = ctx.runOK('search', 'acme.com')
    expect(out).toContain('Jane Doe')
  })

  test('search across entity types', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--company', 'Acme')
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK('deal', 'add', '--title', 'Acme Enterprise Deal')

    const out = ctx.runOK('search', 'Acme')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Acme Corp')
    expect(out).toContain('Acme Enterprise Deal')
  })

  test('filter by type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Acme Person')
    ctx.runOK('company', 'add', '--name', 'Acme Corp')

    const out = ctx.runOK('search', 'Acme', '--type', 'contact')
    expect(out).toContain('Acme Person')
    expect(out).not.toContain('Acme Corp')
  })

  test('search in activity notes', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK(
      'log',
      'note',
      'jane@acme.com',
      'Discussed the enterprise pricing tier',
    )

    const out = ctx.runOK('search', 'enterprise pricing')
    expect(out).toContain('enterprise pricing')
  })

  test('no results returns empty array in json', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe')

    const results = ctx.runJSON<unknown[]>(
      'search',
      'zzzznonexistent',
      '--format',
      'json',
    )
    expect(results).toHaveLength(0)
  })

  test('json format includes type field', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
    )

    const results = ctx.runJSON<Array<{ type: string }>>(
      'search',
      'Jane',
      '--format',
      'json',
    )
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('contact')
  })
})

describe('find (semantic search)', () => {
  test('natural language query returns relevant results', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice Chen',
      '--company',
      'FinTech London Ltd',
      '--set',
      'title=CTO',
      '--set',
      'location=London',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Bob Wilson',
      '--company',
      'Acme US',
      '--set',
      'title=Engineer',
    )

    const results = ctx.runJSON<Array<{ name: string }>>(
      'find',
      'fintech CTO from London',
      '--format',
      'json',
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].name).toBe('Alice Chen')
  })

  test('limit results', () => {
    const ctx = createTestContext()
    for (let i = 0; i < 5; i++) {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        `Person ${String.fromCharCode(65 + i)}`,
      )
    }

    const results = ctx.runJSON<unknown[]>(
      'find',
      'person',
      '--limit',
      '2',
      '--format',
      'json',
    )
    expect(results.length).toBeLessThanOrEqual(2)
  })

  test('filter by type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Acme Alice')
    ctx.runOK('company', 'add', '--name', 'Acme Corp')

    const results = ctx.runJSON<Array<{ type: string }>>(
      'find',
      'acme',
      '--type',
      'contact',
      '--format',
      'json',
    )
    for (const r of results) {
      expect(r.type).toBe('contact')
    }
  })

  test('threshold filters low-scoring results', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice Chen',
      '--company',
      'FinTech London Ltd',
      '--set',
      'title=CTO',
    )
    ctx.runOK('contact', 'add', '--name', 'Bob Wilson', '--company', 'Acme')

    const highThreshold = ctx.runJSON<unknown[]>(
      'find',
      'fintech CTO London',
      '--threshold',
      '0.9',
      '--format',
      'json',
    )
    const lowThreshold = ctx.runJSON<unknown[]>(
      'find',
      'fintech CTO London',
      '--threshold',
      '0.1',
      '--format',
      'json',
    )
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length)
  })
})

describe('index', () => {
  test('status shows index info', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')

    const out = ctx.runOK('index', 'status')
    expect(out).toContain('contacts')
  })

  test('rebuild then search still works', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')
    ctx.runOK('index', 'rebuild')

    const out = ctx.runOK('search', 'Jane')
    expect(out).toContain('Jane')
  })
})

describe('search edge cases', () => {
  test('search is case-insensitive', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe')

    const results = ctx.runJSON<unknown[]>('search', 'jane', '--format', 'json')
    expect(results).toHaveLength(1)
  })

  test('search finds companies', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp')

    const results = ctx.runJSON<Array<{ type: string }>>(
      'search',
      'Acme',
      '--format',
      'json',
    )
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.type === 'company')).toBe(true)
  })

  test('search finds deals', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Enterprise License')

    const results = ctx.runJSON<Array<{ type: string }>>(
      'search',
      'Enterprise',
      '--format',
      'json',
    )
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.type === 'deal')).toBe(true)
  })

  test('search with special characters does not crash', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')

    // These should not throw — they should either return results or empty
    const r1 = ctx.runJSON<unknown[]>(
      'search',
      'test@email.com',
      '--format',
      'json',
    )
    expect(Array.isArray(r1)).toBe(true)

    const r2 = ctx.runJSON<unknown[]>(
      'search',
      'hello world',
      '--format',
      'json',
    )
    expect(Array.isArray(r2)).toBe(true)
  })
})
