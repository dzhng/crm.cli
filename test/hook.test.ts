import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from './helpers.ts'

function hookSetup(hookName: string) {
  const ctx = createTestContext()
  const hookOutput = join(ctx.dir, 'hook-output.json')
  const hookScript = join(ctx.dir, 'hook.sh')
  writeFileSync(hookScript, `#!/bin/sh\ncat > ${hookOutput}\n`, {
    mode: 0o755,
  })
  const configPath = join(ctx.dir, 'config.toml')
  writeFileSync(configPath, `[hooks]\n${hookName} = "${hookScript}"\n`)
  return { ctx, hookOutput, configPath }
}

function abortHookSetup(hookName: string) {
  const ctx = createTestContext()
  const hookScript = join(ctx.dir, 'abort.sh')
  writeFileSync(hookScript, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const configPath = join(ctx.dir, 'config.toml')
  writeFileSync(configPath, `[hooks]\n${hookName} = "${hookScript}"\n`)
  return { ctx, configPath }
}

describe('hooks', () => {
  // -------------------------------------------------------------------------
  // contact-add
  // -------------------------------------------------------------------------
  test('pre-contact-add hook can abort creation', () => {
    const { ctx, configPath } = abortHookSetup('pre-contact-add')
    ctx.runFail('--config', configPath, 'contact', 'add', '--name', 'Jane')
  })

  test('post-contact-add hook receives entity JSON', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-contact-add')
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

  // -------------------------------------------------------------------------
  // contact-edit
  // -------------------------------------------------------------------------
  test('pre-contact-edit hook can abort edit', () => {
    const { ctx, configPath } = abortHookSetup('pre-contact-edit')
    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runFail(
      '--config',
      configPath,
      'contact',
      'edit',
      id,
      '--name',
      'Janet',
    )
    // Name should be unchanged
    const out = ctx.runOK(
      '--config',
      configPath,
      '--format',
      'json',
      'contact',
      'show',
      id,
    )
    expect(out).toContain('Jane')
    expect(out).not.toContain('Janet')
  })

  test('post-contact-edit hook receives updated entity', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-contact-edit')
    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runOK('--config', configPath, 'contact', 'edit', id, '--name', 'Janet')
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('Janet')
  })

  // -------------------------------------------------------------------------
  // contact-rm
  // -------------------------------------------------------------------------
  test('pre-contact-rm hook can abort deletion', () => {
    const { ctx, configPath } = abortHookSetup('pre-contact-rm')
    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runFail('--config', configPath, 'contact', 'rm', id, '--force')
    // Contact should still exist
    ctx.runOK('--config', configPath, 'contact', 'show', id)
  })

  test('post-contact-rm hook receives deleted entity', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-contact-rm')
    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runOK('--config', configPath, 'contact', 'rm', id, '--force')
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain(id)
    expect(data).toContain('Jane')
  })

  // -------------------------------------------------------------------------
  // company-add
  // -------------------------------------------------------------------------
  test('pre-company-add hook can abort creation', () => {
    const { ctx, configPath } = abortHookSetup('pre-company-add')
    ctx.runFail('--config', configPath, 'company', 'add', '--name', 'Acme Corp')
  })

  test('post-company-add hook receives entity JSON', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-company-add')
    ctx.runOK(
      '--config',
      configPath,
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--website',
      'acme.com',
    )
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('Acme Corp')
    expect(data).toContain('acme.com')
  })

  // -------------------------------------------------------------------------
  // company-edit
  // -------------------------------------------------------------------------
  test('pre-company-edit hook can abort edit', () => {
    const { ctx, configPath } = abortHookSetup('pre-company-edit')
    const id = ctx
      .runOK('--config', configPath, 'company', 'add', '--name', 'Acme Corp')
      .trim()
    ctx.runFail(
      '--config',
      configPath,
      'company',
      'edit',
      id,
      '--name',
      'Acme Inc',
    )
    const out = ctx.runOK(
      '--config',
      configPath,
      '--format',
      'json',
      'company',
      'show',
      id,
    )
    expect(out).toContain('Acme Corp')
    expect(out).not.toContain('Acme Inc')
  })

  test('post-company-edit hook receives updated entity', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-company-edit')
    const id = ctx
      .runOK('--config', configPath, 'company', 'add', '--name', 'Acme Corp')
      .trim()
    ctx.runOK(
      '--config',
      configPath,
      'company',
      'edit',
      id,
      '--name',
      'Acme Inc',
    )
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('Acme Inc')
  })

  // -------------------------------------------------------------------------
  // company-rm
  // -------------------------------------------------------------------------
  test('pre-company-rm hook can abort deletion', () => {
    const { ctx, configPath } = abortHookSetup('pre-company-rm')
    const id = ctx
      .runOK('--config', configPath, 'company', 'add', '--name', 'Acme Corp')
      .trim()
    ctx.runFail('--config', configPath, 'company', 'rm', id, '--force')
    ctx.runOK('--config', configPath, 'company', 'show', id)
  })

  test('post-company-rm hook receives deleted entity', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-company-rm')
    const id = ctx
      .runOK('--config', configPath, 'company', 'add', '--name', 'Acme Corp')
      .trim()
    ctx.runOK('--config', configPath, 'company', 'rm', id, '--force')
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain(id)
    expect(data).toContain('Acme Corp')
  })

  // -------------------------------------------------------------------------
  // deal-add
  // -------------------------------------------------------------------------
  test('pre-deal-add hook can abort creation', () => {
    const { ctx, configPath } = abortHookSetup('pre-deal-add')
    ctx.runFail('--config', configPath, 'deal', 'add', '--title', 'Big Deal')
  })

  test('post-deal-add hook receives entity JSON', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-deal-add')
    ctx.runOK(
      '--config',
      configPath,
      'deal',
      'add',
      '--title',
      'Big Deal',
      '--value',
      '50000',
    )
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('Big Deal')
    expect(data).toContain('50000')
  })

  // -------------------------------------------------------------------------
  // deal-edit
  // -------------------------------------------------------------------------
  test('pre-deal-edit hook can abort edit', () => {
    const { ctx, configPath } = abortHookSetup('pre-deal-edit')
    const id = ctx
      .runOK('--config', configPath, 'deal', 'add', '--title', 'Big Deal')
      .trim()
    ctx.runFail(
      '--config',
      configPath,
      'deal',
      'edit',
      id,
      '--title',
      'Huge Deal',
    )
    const out = ctx.runOK(
      '--config',
      configPath,
      '--format',
      'json',
      'deal',
      'show',
      id,
    )
    expect(out).toContain('Big Deal')
    expect(out).not.toContain('Huge Deal')
  })

  test('post-deal-edit hook receives updated entity', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-deal-edit')
    const id = ctx
      .runOK('--config', configPath, 'deal', 'add', '--title', 'Big Deal')
      .trim()
    ctx.runOK(
      '--config',
      configPath,
      'deal',
      'edit',
      id,
      '--title',
      'Huge Deal',
    )
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('Huge Deal')
  })

  // -------------------------------------------------------------------------
  // deal-rm
  // -------------------------------------------------------------------------
  test('pre-deal-rm hook can abort deletion', () => {
    const { ctx, configPath } = abortHookSetup('pre-deal-rm')
    const id = ctx
      .runOK('--config', configPath, 'deal', 'add', '--title', 'Big Deal')
      .trim()
    ctx.runFail('--config', configPath, 'deal', 'rm', id, '--force')
    ctx.runOK('--config', configPath, 'deal', 'show', id)
  })

  test('post-deal-rm hook receives deleted entity', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-deal-rm')
    const id = ctx
      .runOK('--config', configPath, 'deal', 'add', '--title', 'Big Deal')
      .trim()
    ctx.runOK('--config', configPath, 'deal', 'rm', id, '--force')
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain(id)
    expect(data).toContain('Big Deal')
  })

  // -------------------------------------------------------------------------
  // deal-stage-change
  // -------------------------------------------------------------------------
  test('pre-deal-stage-change hook can abort stage move', () => {
    const { ctx, configPath } = abortHookSetup('pre-deal-stage-change')
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
    ctx.runFail(
      '--config',
      configPath,
      'deal',
      'move',
      id,
      '--stage',
      'qualified',
    )
    const out = ctx.runOK(
      '--config',
      configPath,
      '--format',
      'json',
      'deal',
      'show',
      id,
    )
    expect(out).toContain('"lead"')
  })

  test('post-deal-stage-change hook fires on move', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-deal-stage-change')
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

  // -------------------------------------------------------------------------
  // activity-add
  // -------------------------------------------------------------------------
  test('pre-activity-add hook can abort logging', () => {
    const { ctx, configPath } = abortHookSetup('pre-activity-add')
    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runFail(
      '--config',
      configPath,
      'log',
      'note',
      'Some note',
      '--contact',
      id,
    )
  })

  test('post-activity-add hook receives activity data', () => {
    const { ctx, hookOutput, configPath } = hookSetup('post-activity-add')
    const id = ctx
      .runOK('--config', configPath, 'contact', 'add', '--name', 'Jane')
      .trim()
    ctx.runOK(
      '--config',
      configPath,
      'log',
      'note',
      'Great call today',
      '--contact',
      id,
    )
    const data = readFileSync(hookOutput, 'utf-8')
    expect(data).toContain('note')
    expect(data).toContain('Great call today')
  })

  // -------------------------------------------------------------------------
  // no hooks configured
  // -------------------------------------------------------------------------
  test('no hooks configured still works', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane')
  })
})
