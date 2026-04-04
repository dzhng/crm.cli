import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('dupes', () => {
  test('finds likely duplicate contacts by fuzzy name', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--company', 'Acme')
    ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.doe@gmail.com', '--company', 'Acme')

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('J. Doe')
  })

  test('finds likely duplicate companies by fuzzy name', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'https://acme.com')
    ctx.runOK('company', 'add', '--name', 'Acme Inc', '--website', 'https://acme.ai')

    const out = ctx.runOK('dupes', '--type', 'company')
    expect(out).toContain('Acme')
    expect(out).toContain('Acme Inc')
  })

  test('json output includes candidate pairs and reasons', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--company', 'Acme')
    ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.doe@gmail.com', '--company', 'Acme')

    const results = ctx.runJSON<Array<{ left: unknown; right: unknown; reasons: string[] }>>('dupes', '--type', 'contact', '--format', 'json')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toHaveProperty('left')
    expect(results[0]).toHaveProperty('right')
    expect(results[0]).toHaveProperty('reasons')
  })

  test('does not rely on exact overlapping emails or phones', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com')
    ctx.runOK('contact', 'add', '--name', 'Jane D', '--email', 'jane.personal@gmail.com')

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Jane D')
  })

  test('finds likely duplicate companies by similar website hosts even with paths', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Example Docs', '--website', 'https://example.com/a')
    ctx.runOK('company', 'add', '--name', 'Example Docs Inc', '--website', 'https://example.com/b')

    const out = ctx.runOK('dupes', '--type', 'company')
    expect(out).toContain('Example Docs')
    expect(out).toContain('Example Docs Inc')
  })

  test('finds likely duplicate contacts by same company plus fuzzy name when emails differ', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--company', 'Acme')
    ctx.runOK('contact', 'add', '--name', 'Jane D', '--email', 'jane.personal@gmail.com', '--company', 'Acme')

    const out = ctx.runOK('dupes', '--type', 'contact')
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Jane D')
  })
})
