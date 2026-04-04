import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

export interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

export function createTestContext() {
  const dir = mkdtempSync(join(tmpdir(), 'crm-test-'))
  const dbPath = join(dir, 'test.db')

  function run(...args: string[]): RunResult {
    const proc = Bun.spawnSync(
      ['bun', 'run', CRM_BIN, '--db', dbPath, ...args],
      {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1' },
      },
    )
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  function runOK(...args: string[]): string {
    const result = run(...args)
    if (result.exitCode !== 0) {
      throw new Error(
        `crm ${args.join(' ')} failed (exit ${result.exitCode}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      )
    }
    return result.stdout
  }

  function runFail(...args: string[]): RunResult {
    const result = run(...args)
    if (result.exitCode === 0) {
      throw new Error(
        `expected crm ${args.join(' ')} to fail, but it succeeded:\nstdout: ${result.stdout}`,
      )
    }
    return result
  }

  function runJSON<T = unknown>(...args: string[]): T {
    const out = runOK(...args)
    return JSON.parse(out) as T
  }

  function runWithEnv(
    env: Record<string, string>,
    ...args: string[]
  ): RunResult {
    const proc = Bun.spawnSync(['bun', 'run', CRM_BIN, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', ...env },
    })
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  return { dir, dbPath, run, runOK, runFail, runJSON, runWithEnv }
}

export type TestContext = ReturnType<typeof createTestContext>
