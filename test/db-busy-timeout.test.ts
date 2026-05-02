import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createTestContext } from './helpers.ts'

/**
 * `PRAGMA busy_timeout` makes concurrent writers wait for the SQLite write
 * lock instead of immediately erroring. Without it, parallel `crm contact
 * add` calls return `SQLITE_BUSY: database is locked` under load.
 */
describe('SQLite busy timeout', () => {
  test('parallel contact adds all succeed under contention', async () => {
    const ctx = createTestContext()
    // Empirically: N=20 doesn't reliably contend on this machine, but
    // N=40 produces ~4 SQLITE_BUSY failures consistently when the
    // busy_timeout PRAGMA isn't set.
    const N = 40
    const procs = Array.from({ length: N }, (_, i) =>
      Bun.spawn(
        [
          'bun',
          'run',
          join(import.meta.dir, '..', 'src', 'cli.ts'),
          '--db',
          ctx.dbPath,
          '--config',
          ctx.configPath,
          'contact',
          'add',
          '--name',
          `User ${i}`,
          '--email',
          `u${i}@busy.test`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      ),
    )
    const results = await Promise.all(
      procs.map(async (p) => ({
        exitCode: await p.exited,
        stderr: await new Response(p.stderr).text(),
      })),
    )
    const failures = results.filter((r) => r.exitCode !== 0)
    if (failures.length > 0) {
      // Surface the first failure so the test output is actionable.
      throw new Error(
        `${failures.length}/${N} parallel adds failed; first stderr: ${failures[0].stderr}`,
      )
    }

    const list = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(list).toHaveLength(N)
  }, 30_000)
})
