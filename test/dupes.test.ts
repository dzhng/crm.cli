import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('dupes', () => {
  test('finds likely duplicate contacts by fuzzy name', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--company',
      'Acme',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'J. Doe',
      '--email',
      'jane.doe@gmail.com',
      '--company',
      'Acme',
    )

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('J. Doe')
  })

  test('finds likely duplicate companies by fuzzy name', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK('company', 'add', '--name', 'Acme Inc', '--website', 'acme.ai')

    const out = ctx.runOK('dupes', '--type', 'company')
    expect(out).toContain('Acme')
    expect(out).toContain('Acme Inc')
  })

  test('json output includes candidate pairs and reasons', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--company',
      'Acme',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'J. Doe',
      '--email',
      'jane.doe@gmail.com',
      '--company',
      'Acme',
    )

    const results = ctx.runJSON<
      Array<{ left: unknown; right: unknown; reasons: string[] }>
    >('dupes', '--type', 'contact', '--format', 'json')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toHaveProperty('left')
    expect(results[0]).toHaveProperty('right')
    expect(results[0]).toHaveProperty('reasons')
  })

  test('does not rely on exact overlapping emails or phones', () => {
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
      'Jane D',
      '--email',
      'jane.personal@gmail.com',
    )

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Jane D')
  })

  test('finds likely duplicate companies by fuzzy name even when websites differ', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Example Docs',
      '--website',
      'example.com/research',
    )
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Example Docs Inc',
      '--website',
      'example.com/consulting',
    )

    const out = ctx.runOK('dupes', '--type', 'company')
    expect(out).toContain('Example Docs')
    expect(out).toContain('Example Docs Inc')
  })

  test('finds likely duplicate contacts by same company plus fuzzy name when emails differ', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--company',
      'Acme',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane D',
      '--email',
      'jane.personal@gmail.com',
      '--company',
      'Acme',
    )

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Jane D')
  })

  test('finds likely duplicate contacts by similar social handles', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--linkedin',
      'janedoe',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Janet Doe',
      '--email',
      'janet@acme.com',
      '--linkedin',
      'janetdoe',
    )

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Janet Doe')
  })

  test('contacts with shared email domain flagged when names are similar', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Bob Johnson',
      '--email',
      'bob@acme.com',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Robert Johnson',
      '--email',
      'robert.johnson@acme.com',
    )

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Bob Johnson')
    expect(out).toContain('Robert Johnson')
  })

  test('completely different contacts are not flagged', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice Chen',
      '--email',
      'alice@fintech.com',
      '--company',
      'FinTech Co',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Bob Wilson',
      '--email',
      'bob@globex.com',
      '--company',
      'Globex',
    )

    const results = ctx.runJSON<unknown[]>(
      'dupes',
      '--type',
      'contact',
      '--format',
      'json',
    )
    expect(results).toHaveLength(0)
  })

  test('threshold flag filters by similarity score', () => {
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
      'Jane D',
      '--email',
      'jane.d@other.com',
    )

    // High threshold should filter out lower-confidence matches
    const high = ctx.runJSON<unknown[]>(
      'dupes',
      '--type',
      'contact',
      '--threshold',
      '0.9',
      '--format',
      'json',
    )
    const low = ctx.runJSON<unknown[]>(
      'dupes',
      '--type',
      'contact',
      '--threshold',
      '0.3',
      '--format',
      'json',
    )
    expect(low.length).toBeGreaterThanOrEqual(high.length)
  })

  test('limit flag caps results', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane1@acme.com',
    )
    ctx.runOK('contact', 'add', '--name', 'Jane D', '--email', 'jane2@acme.com')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jan Doe',
      '--email',
      'jane3@acme.com',
    )

    const results = ctx.runJSON<unknown[]>(
      'dupes',
      '--type',
      'contact',
      '--limit',
      '1',
      '--format',
      'json',
    )
    expect(results).toHaveLength(1)
  })

  test('dupes with no data returns empty', () => {
    const ctx = createTestContext()
    const results = ctx.runJSON<unknown[]>('dupes', '--format', 'json')
    expect(results).toHaveLength(0)
  })

  test('dupes without --type searches both contacts and companies', () => {
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
      'J. Doe',
      '--email',
      'j.doe@gmail.com',
    )
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK('company', 'add', '--name', 'Acme Inc', '--website', 'acme.ai')

    const results = ctx.runJSON<unknown[]>('dupes', '--format', 'json')
    expect(results.length).toBeGreaterThanOrEqual(2)
  })
})
