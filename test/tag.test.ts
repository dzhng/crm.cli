import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('tag', () => {
  test('tag contact by ID', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()
    ctx.runOK('tag', id, 'hot-lead', 'enterprise')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('hot-lead')
    expect(show).toContain('enterprise')
  })

  test('tag company by website', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    ctx.runOK('tag', 'acme.com', 'target-account')

    const show = ctx.runOK('company', 'show', 'acme.com')
    expect(show).toContain('target-account')
  })

  test('tag deal', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('deal', 'add', '--title', 'Big Deal').trim()
    ctx.runOK('tag', id, 'q2', 'priority')

    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('q2')
    expect(show).toContain('priority')
  })

  test('tag contact by email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('tag', 'jane@acme.com', 'vip')

    const show = ctx.runOK('contact', 'show', 'jane@acme.com')
    expect(show).toContain('vip')
  })

  test('tagging is idempotent', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--tag', 'vip')
      .trim()
    ctx.runOK('tag', id, 'vip')

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--tag',
      'vip',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
  })
})

describe('untag', () => {
  test('removes tag', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--tag',
        'vip',
        '--tag',
        'cold',
      )
      .trim()
    ctx.runOK('untag', id, 'cold')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('vip')
    expect(show).not.toContain('cold')
  })
})

describe('tag list', () => {
  test('shows all tags with counts', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--tag',
      'vip',
      '--tag',
      'hot-lead',
    )
    ctx.runOK('contact', 'add', '--name', 'Bob', '--tag', 'vip')
    ctx.runOK('company', 'add', '--name', 'Acme', '--tag', 'enterprise')

    const out = ctx.runOK('tag', 'list')
    expect(out).toContain('vip')
    expect(out).toContain('hot-lead')
    expect(out).toContain('enterprise')
  })

  test('filter by entity type', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--tag', 'person-tag')
    ctx.runOK('company', 'add', '--name', 'Acme', '--tag', 'company-tag')

    const out = ctx.runOK('tag', 'list', '--type', 'contact')
    expect(out).toContain('person-tag')
    expect(out).not.toContain('company-tag')
  })
})
