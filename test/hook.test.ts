import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from './helpers.ts'

describe('hooks', () => {
  test('post-contact-add hook receives entity JSON', () => {
    const ctx = createTestContext()
    const hookOutput = join(ctx.dir, 'hook-output.json')
    const hookScript = join(ctx.dir, 'hook.sh')
    writeFileSync(hookScript, `#!/bin/sh\ncat > ${hookOutput}\n`, {
      mode: 0o755,
    })

    const configPath = join(ctx.dir, 'config.toml')
    writeFileSync(configPath, `[hooks]\npost-contact-add = "${hookScript}"\n`)

    ctx.runOK(
      '--config',
      configPath,
      'contact',
      'add',
      '--name',
      'Jane',
      '--email',
      'jane@acme.com',
    )

    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('Jane')
    expect(data).toContain('jane@acme.com')
  })

  test('pre-contact-rm hook can abort deletion', () => {
    const ctx = createTestContext()
    const hookScript = join(ctx.dir, 'abort.sh')
    writeFileSync(hookScript, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const configPath = join(ctx.dir, 'config.toml')
    writeFileSync(configPath, `[hooks]\npre-contact-rm = "${hookScript}"\n`)

    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runFail('--config', configPath, 'contact', 'rm', id, '--force')

    // Contact should still exist.
    ctx.runOK('--config', configPath, 'contact', 'show', id)
  })

  test('post-deal-stage-change hook fires on move', () => {
    const ctx = createTestContext()
    const hookOutput = join(ctx.dir, 'stage-change.json')
    const hookScript = join(ctx.dir, 'stage-hook.sh')
    writeFileSync(hookScript, `#!/bin/sh\ncat > ${hookOutput}\n`, {
      mode: 0o755,
    })

    const configPath = join(ctx.dir, 'config.toml')
    writeFileSync(
      configPath,
      `[hooks]\npost-deal-stage-change = "${hookScript}"\n`,
    )

    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Hook Deal',
        '--stage',
        'lead',
      )
      .trim()
    ctx.runOK(
      '--config',
      configPath,
      'deal',
      'move',
      id,
      '--stage',
      'qualified',
    )

    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('qualified')
  })

  test('no hooks configured still works', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')
  })
})
