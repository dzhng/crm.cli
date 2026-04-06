import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Whether the current platform supports FUSE/NFS mount tests */
export const canMount = existsSync('/dev/fuse') // Linux FUSE only — macOS NFS mount causes kernel panics, skip for now

const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

const TEST_CONFIG = `[phone]
default_country = "US"
display = "international"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"
`

export interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

export function createTestContext(opts?: { noConfig?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'crm-test-'))
  const dbPath = join(dir, 'test.db')
  const configPath = join(dir, 'config.toml')
  if (!opts?.noConfig) {
    writeFileSync(configPath, TEST_CONFIG)
  }
  const baseEnv = opts?.noConfig
    ? { ...process.env, NO_COLOR: '1' }
    : { ...process.env, NO_COLOR: '1', CRM_CONFIG: configPath }

  function run(...args: string[]): RunResult {
    const proc = Bun.spawnSync(
      ['bun', 'run', CRM_BIN, '--db', dbPath, ...args],
      {
        cwd: dir,
        env: baseEnv,
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
    const proc = Bun.spawnSync(
      ['bun', 'run', CRM_BIN, '--db', dbPath, ...args],
      {
        cwd: dir,
        env: { ...baseEnv, ...env },
      },
    )
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  return { dir, dbPath, configPath, run, runOK, runFail, runJSON, runWithEnv }
}

export type TestContext = ReturnType<typeof createTestContext>
