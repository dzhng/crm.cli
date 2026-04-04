import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from './helpers.ts'

describe('global flags', () => {
  test('--version prints version', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('--version')
    expect(out.trim()).not.toBe('')
  })

  test('--db uses custom database path', () => {
    const ctx = createTestContext()
    const customDB = join(ctx.dir, 'custom.db')
    ctx.run('--db', customDB, 'contact', 'add', '--name', 'Jane')
    expect(existsSync(customDB)).toBe(true)

    const contacts = ctx.runJSON<unknown[]>(
      '--db',
      customDB,
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
  })

  test('CRM_DB env var sets database path', () => {
    const ctx = createTestContext()
    const customDB = join(ctx.dir, 'env.db')
    const result = ctx.runWithEnv(
      { CRM_DB: customDB },
      'contact',
      'add',
      '--name',
      'Jane',
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toStartWith('ct_')
  })

  test('CRM_FORMAT env var sets default format', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')
    const result = ctx.runWithEnv(
      { CRM_FORMAT: 'json' },
      '--db',
      ctx.dbPath,
      'contact',
      'list',
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toStartWith('[')
  })

  test('--no-color suppresses ANSI codes', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')
    const out = ctx.runOK('contact', 'list', '--no-color')
    expect(out).not.toContain('\x1b[')
  })

  test('database auto-created on first command', () => {
    const ctx = createTestContext()
    expect(existsSync(ctx.dbPath)).toBe(false)
    ctx.runOK('contact', 'add', '--name', 'Jane')
    expect(existsSync(ctx.dbPath)).toBe(true)
  })

  test('unknown command fails', () => {
    const ctx = createTestContext()
    const result = ctx.runFail('notacommand')
    expect(result.stderr).not.toBe('')
  })
})

describe('help', () => {
  test('--help lists all commands', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('--help')
    expect(out).toContain('contact')
    expect(out).toContain('company')
    expect(out).toContain('deal')
    expect(out).toContain('search')
    expect(out).toContain('find')
    expect(out).toContain('report')
  })

  test('subcommand --help lists subcommands', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('contact', '--help')
    expect(out).toContain('add')
    expect(out).toContain('list')
    expect(out).toContain('show')
    expect(out).toContain('edit')
    expect(out).toContain('rm')
  })
})
