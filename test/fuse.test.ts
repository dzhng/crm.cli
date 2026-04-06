import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createTestContext, type TestContext } from './helpers.ts'

/**
 * FUSE tests mount the CRM as a virtual filesystem via `crm mount` and
 * test read/write operations using standard file system calls.
 */

const canMount =
  existsSync('/dev/fuse') || // Linux FUSE
  (process.platform === 'darwin' &&
    Bun.spawnSync(['which', 'cargo']).exitCode === 0) // macOS NFS

// Clean up stale FUSE mounts from previous interrupted test runs.
// When a test run is killed (Ctrl+C, crash, OOM), afterAll never fires and
// the detached crm-fuse/fuse-daemon processes survive. Without this cleanup,
// they accumulate across runs and exhaust kernel FUSE connections.
if (canMount && process.platform === 'linux') {
  const crmDir = join(homedir(), '.crm')
  if (existsSync(crmDir)) {
    const pidFiles = readdirSync(crmDir).filter(
      (f) => f.startsWith('mount-tmp-crm-test-') && f.endsWith('.pid'),
    )
    for (const f of pidFiles) {
      const pidPath = join(crmDir, f)
      try {
        const pids = readFileSync(pidPath, 'utf-8').trim().split('\n')
        for (const pid of pids) {
          try {
            process.kill(Number(pid))
          } catch {
            // already dead
          }
        }
        unlinkSync(pidPath)
      } catch {
        // ignore
      }
    }
    // Also clean up any stale test FUSE mounts still in the kernel
    const mounts = spawnSync('bash', [
      '-c',
      "mount | grep 'fuse\\.crm-fuse' | grep '/tmp/crm-test-' | awk '{print $3}'",
    ])
    if (mounts.stdout) {
      for (const mp of mounts.stdout.toString().trim().split('\n')) {
        if (mp) {
          spawnSync('fusermount', ['-u', mp], {
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        }
      }
    }
  }
}

interface FuseTestContext extends TestContext {
  mounted: boolean
  mountPoint: string
}

let sharedCtx: FuseTestContext | null = null

function getOrCreateSharedContext(): FuseTestContext {
  if (sharedCtx) {
    return sharedCtx
  }
  const ctx = createTestContext() as FuseTestContext
  ctx.mountPoint = join(ctx.dir, 'mnt')
  mkdirSync(ctx.mountPoint)
  if (!canMount) {
    ctx.mounted = false
    sharedCtx = ctx
    return ctx
  }
  ctx.runOK('contact', 'list')
  const result = ctx.run('mount', ctx.mountPoint)
  if (result.exitCode !== 0) {
    ctx.mounted = false
    sharedCtx = ctx
    return ctx
  }
  const deadline = Date.now() + 10_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      if (readdirSync(ctx.mountPoint).includes('contacts')) {
        ready = true
        break
      }
    } catch {
      /* not mounted yet */
    }
    Bun.sleepSync(50)
  }
  ctx.mounted = ready
  sharedCtx = ctx
  return ctx
}

function cleanDB(ctx: FuseTestContext) {
  // Clear all data between tests. WAL checkpoint ensures the daemon
  // sees the changes immediately.
  const { Database } = require('bun:sqlite')
  const db = new Database(ctx.dbPath)
  db.run('DELETE FROM activities')
  db.run('DELETE FROM deals')
  db.run('DELETE FROM contacts')
  db.run('DELETE FROM companies')
  db.run('DELETE FROM search_index')
  db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

function createFuseTestContext(): FuseTestContext {
  const ctx = getOrCreateSharedContext()
  cleanDB(ctx)
  return ctx
}

function unmount(ctx: FuseTestContext) {
  if (!ctx.mounted) {
    return
  }
  ctx.run('unmount', ctx.mountPoint)
  ctx.mounted = false
}

afterAll(() => {
  if (sharedCtx) {
    unmount(sharedCtx)
    sharedCtx = null
  }
})

// No-op for per-test finally blocks — real unmount is in afterAll
function unmountIfNotShared(ctx: FuseTestContext) {
  if (ctx !== sharedCtx) {
    unmount(ctx)
  }
}

function skipIfNoFuse(ctx: FuseTestContext) {
  if (!ctx.mounted) {
    console.warn('FUSE not available — skipping test')
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Directory structure
// ---------------------------------------------------------------------------

describe('fuse: directory layout', () => {
  test('mount point contains expected top-level entries', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const entries = readdirSync(ctx.mountPoint)
      expect(entries).toContain('contacts')
      expect(entries).toContain('companies')
      expect(entries).toContain('deals')
      expect(entries).toContain('activities')
      expect(entries).toContain('pipeline.json')
      expect(entries).toContain('reports')
      expect(entries).toContain('tags.json')
      expect(entries).toContain('search')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('contacts/ has _by-email, _by-phone, _by-linkedin, _by-x, _by-bluesky, _by-telegram, _by-company, _by-tag subdirs', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const entries = readdirSync(join(ctx.mountPoint, 'contacts'))
      expect(entries).toContain('_by-email')
      expect(entries).toContain('_by-phone')
      expect(entries).toContain('_by-linkedin')
      expect(entries).toContain('_by-x')
      expect(entries).toContain('_by-bluesky')
      expect(entries).toContain('_by-telegram')
      expect(entries).toContain('_by-company')
      expect(entries).toContain('_by-tag')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('companies/ has _by-website, _by-phone, _by-tag subdirs', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const entries = readdirSync(join(ctx.mountPoint, 'companies'))
      expect(entries).toContain('_by-website')
      expect(entries).toContain('_by-phone')
      expect(entries).toContain('_by-tag')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('deals/ has _by-stage, _by-company, _by-tag subdirs', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const entries = readdirSync(join(ctx.mountPoint, 'deals'))
      expect(entries).toContain('_by-stage')
      expect(entries).toContain('_by-company')
      expect(entries).toContain('_by-tag')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('deals/_by-stage/ contains all configured pipeline stages', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const stages = readdirSync(join(ctx.mountPoint, 'deals', '_by-stage'))
      expect(stages).toContain('lead')
      expect(stages).toContain('qualified')
      expect(stages).toContain('proposal')
      expect(stages).toContain('negotiation')
      expect(stages).toContain('closed-won')
      expect(stages).toContain('closed-lost')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('activities/ has _by-contact, _by-company, _by-deal, _by-type subdirs', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const entries = readdirSync(join(ctx.mountPoint, 'activities'))
      expect(entries).toContain('_by-contact')
      expect(entries).toContain('_by-company')
      expect(entries).toContain('_by-deal')
      expect(entries).toContain('_by-type')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/ contains all report types', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const reports = readdirSync(join(ctx.mountPoint, 'reports'))
      expect(reports).toContain('pipeline.json')
      expect(reports).toContain('stale.json')
      expect(reports).toContain('forecast.json')
      expect(reports).toContain('conversion.json')
      expect(reports).toContain('velocity.json')
      expect(reports).toContain('won.json')
      expect(reports).toContain('lost.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Reading entity files
// ---------------------------------------------------------------------------

describe('fuse: read contacts', () => {
  test('contact file appears after CLI add', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--set',
        'title=CTO',
      )

      const files = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      expect(files).toHaveLength(1)
      expect(files[0]).toContain('jane-doe')

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'contacts', files[0]), 'utf-8'),
      )
      expect(data.name).toBe('Jane Doe')
      expect(data.emails).toContain('jane@acme.com')
      expect(data.custom_fields.title).toBe('CTO')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-phone symlink uses E.164 filename', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--phone',
        '+1-212-555-1234',
      )

      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'contacts', '_by-phone', '+12125551234.json'),
          'utf-8',
        ),
      )
      expect(data.name).toBe('Jane Doe')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-email symlink resolves to correct contact', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
      )

      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'contacts', '_by-email', 'jane@acme.com.json'),
          'utf-8',
        ),
      )
      expect(data.name).toBe('Jane Doe')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('contact with multiple emails has multiple symlinks', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--email',
        'jane@personal.com',
      )

      const byEmail = readdirSync(join(ctx.mountPoint, 'contacts', '_by-email'))
      expect(byEmail).toContain('jane@acme.com.json')
      expect(byEmail).toContain('jane@personal.com.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-linkedin and _by-x have symlinks for social handles', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--linkedin',
        'janedoe',
        '--x',
        'janedoe_x',
      )

      const byLinkedin = readdirSync(
        join(ctx.mountPoint, 'contacts', '_by-linkedin'),
      )
      expect(byLinkedin).toContain('janedoe.json')

      const byX = readdirSync(join(ctx.mountPoint, 'contacts', '_by-x'))
      expect(byX).toContain('janedoe_x.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-company groups contacts by company', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('company', 'add', '--name', 'Acme Corp')
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
      )
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'John',
        '--email',
        'john@acme.com',
        '--company',
        'Acme Corp',
      )

      const acmeDir = join(
        ctx.mountPoint,
        'contacts',
        '_by-company',
        'acme-corp',
      )
      const contacts = readdirSync(acmeDir)
      expect(contacts).toHaveLength(2)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-company lists contact under each linked company', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('company', 'add', '--name', 'Acme Corp')
      ctx.runOK('company', 'add', '--name', 'Globex')
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
        '--company',
        'Globex',
      )

      const acmeDir = join(
        ctx.mountPoint,
        'contacts',
        '_by-company',
        'acme-corp',
      )
      const globexDir = join(
        ctx.mountPoint,
        'contacts',
        '_by-company',
        'globex',
      )
      expect(readdirSync(acmeDir)).toHaveLength(1)
      expect(readdirSync(globexDir)).toHaveLength(1)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-tag groups contacts by tag', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('contact', 'add', '--name', 'Jane', '--tag', 'vip')
      ctx.runOK('contact', 'add', '--name', 'Bob', '--tag', 'vip')
      ctx.runOK('contact', 'add', '--name', 'Alice')

      const vipDir = join(ctx.mountPoint, 'contacts', '_by-tag', 'vip')
      const contacts = readdirSync(vipDir)
      expect(contacts).toHaveLength(2)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('contact file includes social handles, linked companies, deals, and recent activity', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--website',
        'acme.com',
      )
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
        '--linkedin',
        'janedoe',
        '--x',
        'janedoe_x',
      )
      ctx.runOK(
        'deal',
        'add',
        '--title',
        'Big Deal',
        '--value',
        '50000',
        '--contact',
        'jane@acme.com',
      )
      ctx.runOK('log', 'note', 'Great call today', '--contact', 'jane@acme.com')

      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'contacts', '_by-email', 'jane@acme.com.json'),
          'utf-8',
        ),
      )
      expect(data.linkedin).toBe('janedoe')
      expect(data.x).toBe('janedoe_x')
      expect(data.companies).toHaveLength(1)
      expect(data.companies[0].name).toBe('Acme Corp')
      expect(data.deals).toHaveLength(1)
      expect(data.deals[0].title).toBe('Big Deal')
      expect(data.recent_activity).toHaveLength(1)
      expect(data.recent_activity[0].note).toContain('Great call')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

describe('fuse: read companies', () => {
  test('company file with linked contacts and deals', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--website',
        'acme.com',
      )
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
      )
      ctx.runOK('deal', 'add', '--title', 'Acme Deal', '--company', 'acme.com')

      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'companies', '_by-website', 'acme.com.json'),
          'utf-8',
        ),
      )
      expect(data.name).toBe('Acme Corp')
      expect(data.contacts.length).toBeGreaterThanOrEqual(1)
      expect(data.deals.length).toBeGreaterThanOrEqual(1)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('company with multiple websites has multiple symlinks', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'company',
        'add',
        '--name',
        'Acme',
        '--website',
        'acme.com',
        '--website',
        'acme.co.uk',
      )

      const byWebsite = readdirSync(
        join(ctx.mountPoint, 'companies', '_by-website'),
      )
      expect(byWebsite).toContain('acme.com.json')
      expect(byWebsite).toContain('acme.co.uk.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

describe('fuse: read deals', () => {
  test('deal file includes stage history', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK('deal', 'add', '--title', 'Tracked Deal', '--stage', 'lead')
        .trim()
      ctx.runOK('deal', 'move', id, '--stage', 'qualified')

      const files = readdirSync(join(ctx.mountPoint, 'deals')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'deals', files[0]), 'utf-8'),
      )
      expect(data.stage).toBe('qualified')
      expect(data.stage_history.length).toBeGreaterThanOrEqual(2)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('_by-stage symlinks reflect current stage', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('deal', 'add', '--title', 'Lead Deal', '--stage', 'lead')
      ctx.runOK(
        'deal',
        'add',
        '--title',
        'Qualified Deal',
        '--stage',
        'qualified',
      )

      const leadDeals = readdirSync(
        join(ctx.mountPoint, 'deals', '_by-stage', 'lead'),
      )
      const qualDeals = readdirSync(
        join(ctx.mountPoint, 'deals', '_by-stage', 'qualified'),
      )
      expect(leadDeals).toHaveLength(1)
      expect(qualDeals).toHaveLength(1)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('moving a deal updates _by-stage symlinks', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK('deal', 'add', '--title', 'Moving Deal', '--stage', 'lead')
        .trim()
      expect(
        readdirSync(join(ctx.mountPoint, 'deals', '_by-stage', 'lead')),
      ).toHaveLength(1)

      ctx.runOK('deal', 'move', id, '--stage', 'qualified')
      expect(
        readdirSync(join(ctx.mountPoint, 'deals', '_by-stage', 'lead')),
      ).toHaveLength(0)
      expect(
        readdirSync(join(ctx.mountPoint, 'deals', '_by-stage', 'qualified')),
      ).toHaveLength(1)
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Reports and search (read-only virtual files)
// ---------------------------------------------------------------------------

describe('fuse: reports', () => {
  test('pipeline.json returns valid pipeline data', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'deal',
        'add',
        '--title',
        'A',
        '--value',
        '10000',
        '--stage',
        'lead',
      )

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'pipeline.json'), 'utf-8'),
      )
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThan(0)
      expect(data[0]).toHaveProperty('stage')
      expect(data[0]).toHaveProperty('count')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/stale.json returns stale entities', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Stale Bob',
        '--email',
        'bob@acme.com',
      )

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'reports', 'stale.json'), 'utf-8'),
      )
      expect(Array.isArray(data)).toBe(true)
      const bob = data.find((r: { name?: string }) => r.name === 'Stale Bob')
      expect(bob).toBeDefined()
      expect(bob.type).toBe('contact')
      expect(bob.id).toBeDefined()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/forecast.json returns open deals with weighted values', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'deal',
        'add',
        '--title',
        'Big Opp',
        '--value',
        '50000',
        '--probability',
        '80',
      )

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'reports', 'forecast.json'), 'utf-8'),
      )
      expect(data).toHaveLength(1)
      expect(data[0].title).toBe('Big Opp')
      expect(data[0].value).toBe(50_000)
      expect(data[0].weighted).toBe(40_000)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/conversion.json returns stage conversion data', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK('deal', 'add', '--title', 'Conv Deal', '--stage', 'lead')
        .trim()
      ctx.runOK('deal', 'move', id, '--stage', 'qualified')

      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'reports', 'conversion.json'),
          'utf-8',
        ),
      )
      expect(data.length).toBeGreaterThan(0)
      expect(data[0]).toHaveProperty('stage')
      expect(data[0]).toHaveProperty('entered')
      expect(data[0]).toHaveProperty('advanced')
      expect(data[0]).toHaveProperty('rate')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/won.json returns closed-won deals', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK(
          'deal',
          'add',
          '--title',
          'Winner',
          '--value',
          '25000',
          '--stage',
          'lead',
        )
        .trim()
      ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'reports', 'won.json'), 'utf-8'),
      )
      expect(data).toHaveLength(1)
      expect(data[0].title).toBe('Winner')
      expect(data[0].value).toBe(25_000)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/lost.json returns closed-lost deals with reasons', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK(
          'deal',
          'add',
          '--title',
          'Loser',
          '--value',
          '10000',
          '--stage',
          'lead',
        )
        .trim()
      ctx.runOK(
        'deal',
        'move',
        id,
        '--stage',
        'closed-lost',
        '--note',
        'Too expensive',
      )

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'reports', 'lost.json'), 'utf-8'),
      )
      expect(data).toHaveLength(1)
      expect(data[0].title).toBe('Loser')
      expect(data[0].notes).toContain('Too expensive')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reports/velocity.json returns timing data per stage', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK('deal', 'add', '--title', 'Speed Deal', '--stage', 'lead')
        .trim()
      ctx.runOK('deal', 'move', id, '--stage', 'qualified')

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'reports', 'velocity.json'), 'utf-8'),
      )
      expect(data.length).toBeGreaterThan(0)
      expect(data[0]).toHaveProperty('stage')
      expect(data[0]).toHaveProperty('avg_ms')
      expect(data[0]).toHaveProperty('deals')
      expect(data[0]).toHaveProperty('avg_display')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('tags.json lists all tags with counts', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('contact', 'add', '--name', 'Alice', '--tag', 'vip')
      ctx.runOK('contact', 'add', '--name', 'Bob', '--tag', 'vip')

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'tags.json'), 'utf-8'),
      )
      const vipTag = data.find((t: { tag: string }) => t.tag === 'vip')
      expect(vipTag).toBeDefined()
      expect(vipTag.count).toBe(2)
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

describe('fuse: search', () => {
  test('reading search/<query>.json returns results', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
      )

      const data = JSON.parse(
        readFileSync(join(ctx.mountPoint, 'search', 'Jane.json'), 'utf-8'),
      )
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThan(0)
      expect(data[0].name).toBe('Jane Doe')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('search with no matches returns empty array', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'search', 'zzzznonexistent.json'),
          'utf-8',
        ),
      )
      expect(data).toEqual([])
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

describe('fuse: write operations', () => {
  test('write new file to contacts/ creates a contact', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      writeFileSync(
        join(ctx.mountPoint, 'contacts', 'new.json'),
        JSON.stringify({
          name: 'Bob Smith',
          emails: ['bob@globex.com'],
          title: 'Engineer',
        }),
      )

      const contacts = ctx.runJSON<Array<{ name: string }>>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(1)
      expect(contacts[0].name).toBe('Bob Smith')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('overwrite existing contact file updates the contact', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--set',
        'title=Engineer',
      )

      const files = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      const filePath = join(ctx.mountPoint, 'contacts', files[0])
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      data.custom_fields.title = 'CTO'
      writeFileSync(filePath, JSON.stringify(data))

      const show = ctx.runOK('contact', 'show', 'jane@acme.com')
      expect(show).toContain('CTO')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('delete contact file via rm', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
        .trim()

      const files = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      unlinkSync(join(ctx.mountPoint, 'contacts', files[0]))

      ctx.runFail('contact', 'show', id)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('write new file to activities/ creates an activity', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')

      writeFileSync(
        join(ctx.mountPoint, 'activities', 'new.json'),
        JSON.stringify({
          type: 'note',
          entity_ref: 'jane@acme.com',
          note: 'Follow up on proposal',
        }),
      )

      const activities = ctx.runJSON<unknown[]>(
        'activity',
        'list',
        '--contact',
        'jane@acme.com',
        '--format',
        'json',
      )
      expect(activities).toHaveLength(1)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('update deal stage via file write triggers stage tracking', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK(
          'deal',
          'add',
          '--title',
          'Test Deal',
          '--stage',
          'lead',
          '--value',
          '10000',
        )
        .trim()

      const files = readdirSync(join(ctx.mountPoint, 'deals')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      const filePath = join(ctx.mountPoint, 'deals', files[0])
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      data.stage = 'qualified'
      writeFileSync(filePath, JSON.stringify(data))

      const show = ctx.runOK('deal', 'show', id)
      expect(show).toContain('qualified')
      expect(show).toContain('lead')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('write new company file creates a company', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      writeFileSync(
        join(ctx.mountPoint, 'companies', 'new.json'),
        JSON.stringify({
          name: 'Globex Corp',
          websites: ['globex.com'],
          industry: 'Manufacturing',
        }),
      )

      const companies = ctx.runJSON<Array<{ name: string }>>(
        'company',
        'list',
        '--format',
        'json',
      )
      expect(companies).toHaveLength(1)
      expect(companies[0].name).toBe('Globex Corp')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Validation: strict writes
// ---------------------------------------------------------------------------

describe('fuse: write validation', () => {
  test('malformed JSON rejects with EINVAL', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'contacts', 'bad.json'),
          'not json at all',
        )
      }).toThrow()

      const contacts = ctx.runJSON<unknown[]>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('unknown field rejects with EINVAL', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'contacts', 'bad.json'),
          JSON.stringify({ name: 'Jane', bogus: 'field' }),
        )
      }).toThrow()

      const contacts = ctx.runJSON<unknown[]>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('missing required field rejects with EINVAL', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'contacts', 'bad.json'),
          JSON.stringify({ emails: ['no-name@acme.com'] }),
        )
      }).toThrow()

      const contacts = ctx.runJSON<unknown[]>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('type mismatch rejects with EINVAL', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'contacts', 'bad.json'),
          JSON.stringify({ name: 'Jane', emails: 'not-an-array' }),
        )
      }).toThrow()

      const contacts = ctx.runJSON<unknown[]>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('valid write still succeeds after prior validation errors', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(join(ctx.mountPoint, 'contacts', 'bad.json'), 'not json')
      }).toThrow()

      writeFileSync(
        join(ctx.mountPoint, 'contacts', 'good.json'),
        JSON.stringify({ name: 'Valid Contact', emails: ['valid@acme.com'] }),
      )

      const contacts = ctx.runJSON<Array<{ name: string }>>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(1)
      expect(contacts[0].name).toBe('Valid Contact')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('update with full document replaces all fields', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--set',
        'title=CTO',
      )

      const files = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      const filePath = join(ctx.mountPoint, 'contacts', files[0])

      writeFileSync(
        filePath,
        JSON.stringify({ name: 'Jane Doe', emails: ['jane@acme.com'] }),
      )

      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(data.name).toBe('Jane Doe')
      expect(data.custom_fields).toBeUndefined()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('unknown field on update also rejects', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')

      const files = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      const filePath = join(ctx.mountPoint, 'contacts', files[0])

      expect(() => {
        writeFileSync(
          filePath,
          JSON.stringify({
            name: 'Jane',
            emails: ['jane@acme.com'],
            nonexistent: true,
          }),
        )
      }).toThrow()

      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(data.name).toBe('Jane')
      expect(data).not.toHaveProperty('nonexistent')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

describe('fuse: error states', () => {
  test('reading nonexistent contact file throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readFileSync(
          join(ctx.mountPoint, 'contacts', 'nonexistent.json'),
          'utf-8',
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reading nonexistent _by-email symlink throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readFileSync(
          join(
            ctx.mountPoint,
            'contacts',
            '_by-email',
            'nobody@nowhere.com.json',
          ),
          'utf-8',
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reading nonexistent _by-phone symlink throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readFileSync(
          join(ctx.mountPoint, 'contacts', '_by-phone', '+19999999999.json'),
          'utf-8',
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reading nonexistent company file throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readFileSync(
          join(ctx.mountPoint, 'companies', 'nonexistent.json'),
          'utf-8',
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reading nonexistent deal file throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readFileSync(join(ctx.mountPoint, 'deals', 'nonexistent.json'), 'utf-8')
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('reading nonexistent report file throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readFileSync(
          join(ctx.mountPoint, 'reports', 'nonexistent.json'),
          'utf-8',
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('listing nonexistent _by-company subdirectory throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readdirSync(
          join(ctx.mountPoint, 'contacts', '_by-company', 'nonexistent-corp'),
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('listing nonexistent _by-tag subdirectory throws ENOENT', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        readdirSync(
          join(ctx.mountPoint, 'contacts', '_by-tag', 'nonexistent-tag'),
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('writing to nonexistent top-level directory throws', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'bogus', 'new.json'),
          JSON.stringify({ name: 'test' }),
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('deleting from _by-* index directories is not allowed', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')

      expect(() => {
        unlinkSync(
          join(ctx.mountPoint, 'contacts', '_by-email', 'jane@acme.com.json'),
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Phone normalization in FUSE
// ---------------------------------------------------------------------------

describe('fuse: phone normalization', () => {
  test('_by-phone symlinks use E.164 regardless of input format', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--phone',
        '+44 20 7946 0958',
      )

      const byPhone = readdirSync(join(ctx.mountPoint, 'contacts', '_by-phone'))
      expect(byPhone).toContain('+442079460958.json')
      expect(byPhone).not.toContain('+44 20 7946 0958.json')
      expect(byPhone).not.toContain('+44-20-7946-0958.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('company _by-phone also uses E.164', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'company',
        'add',
        '--name',
        'Acme',
        '--phone',
        '+1-212-555-1234',
      )

      const byPhone = readdirSync(
        join(ctx.mountPoint, 'companies', '_by-phone'),
      )
      expect(byPhone).toContain('+12125551234.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('phones in entity JSON files are E.164', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--phone',
        '+1-212-555-1234',
      )

      const data = JSON.parse(
        readFileSync(
          join(ctx.mountPoint, 'contacts', '_by-email', 'jane@acme.com.json'),
          'utf-8',
        ),
      )
      expect(data.phones[0]).toBe('+12125551234')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('writing entity with non-E.164 phone normalizes on save', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      writeFileSync(
        join(ctx.mountPoint, 'contacts', 'new.json'),
        JSON.stringify({ name: 'Bob', phones: ['+44 20 7946 0958'] }),
      )

      const contacts = ctx.runJSON<Array<{ phones: string[] }>>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts[0].phones[0]).toBe('+442079460958')
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('writing entity with invalid phone rejects', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'contacts', 'bad.json'),
          JSON.stringify({ name: 'Bob', phones: ['not-a-number'] }),
        )
      }).toThrow()

      const contacts = ctx.runJSON<unknown[]>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(contacts).toHaveLength(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------

describe('fuse: readonly mode', () => {
  test('--readonly prevents writes', () => {
    if (process.platform === 'darwin') {
      return
    }
    if (!canMount) {
      console.warn('FUSE not available — skipping test')
      return
    }
    const ctx = createTestContext() as FuseTestContext
    ctx.mountPoint = join(ctx.dir, 'mnt-ro')
    mkdirSync(ctx.mountPoint)

    // Seed the DB
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')

    // Mount read-only via CLI
    const result = ctx.run('mount', '--readonly', ctx.mountPoint)
    if (result.exitCode !== 0) {
      console.warn('FUSE mount failed — skipping test')
      return
    }

    // Wait for mount
    const deadline = Date.now() + 5000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const entries = readdirSync(ctx.mountPoint)
        if (entries.includes('contacts')) {
          ready = true
          break
        }
      } catch {
        // not ready
      }
      Bun.sleepSync(50)
    }
    ctx.mounted = ready
    if (!ready) {
      console.warn('FUSE mount failed — skipping test')
      return
    }

    try {
      // Reading should work.
      const files = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      expect(files).toHaveLength(1)

      // Writing should fail.
      expect(() => {
        writeFileSync(
          join(ctx.mountPoint, 'contacts', 'new.json'),
          JSON.stringify({ name: 'Blocked' }),
        )
      }).toThrow()
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Live sync: CLI changes appear in FS immediately
// ---------------------------------------------------------------------------

describe('fuse: live sync', () => {
  test('CLI add appears in filesystem immediately', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const before = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      expect(before).toHaveLength(0)

      ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')

      const after = readdirSync(join(ctx.mountPoint, 'contacts')).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      expect(after).toHaveLength(1)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('CLI delete removes file from filesystem immediately', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const id = ctx
        .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
        .trim()
      expect(
        readdirSync(join(ctx.mountPoint, 'contacts')).filter(
          (f) => f.endsWith('.json') && !f.startsWith('_'),
        ),
      ).toHaveLength(1)

      ctx.runOK('contact', 'rm', id, '--force')
      expect(
        readdirSync(join(ctx.mountPoint, 'contacts')).filter(
          (f) => f.endsWith('.json') && !f.startsWith('_'),
        ),
      ).toHaveLength(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('filesystem write appears in CLI immediately', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      writeFileSync(
        join(ctx.mountPoint, 'contacts', 'new.json'),
        JSON.stringify({ name: 'FS Created', emails: ['fs@test.com'] }),
      )

      const show = ctx.runOK('contact', 'show', 'fs@test.com')
      expect(show).toContain('FS Created')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Lifecycle — must be LAST: "unmount cleans up" destroys the shared mount
// ---------------------------------------------------------------------------

describe('fuse: mount/unmount', () => {
  test('double mount to same path fails gracefully', () => {
    if (process.platform === 'darwin') {
      return
    }
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      // Second mount to the same path should fail
      const result = ctx.run('mount', ctx.mountPoint)
      expect(result.exitCode).not.toBe(0)
    } finally {
      unmountIfNotShared(ctx)
    }
  })

  test('unmount cleans up', () => {
    if (process.platform === 'darwin') {
      return
    }
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }

    unmount(ctx)

    const entries = readdirSync(ctx.mountPoint)
    expect(entries).toHaveLength(0)
  })
})
