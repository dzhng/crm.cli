import { afterAll, describe, expect, test } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
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

import { canMount, createTestContext, type TestContext } from './helpers.ts'

// Use shell echo instead of fs.writeFileSync for NFS writes.
// Bun's writeFileSync uses O_TRUNC which triggers a macOS NFS kernel panic
// after enough accumulated NFS client state.
function writeFile(path: string, content: string) {
  execSync(`printf '%s' '${content.replace(/'/g, "'\\''")}' > '${path}'`)
}

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

function createFuseTestContext(): FuseTestContext {
  return getOrCreateSharedContext()
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
    console.warn('mount not available — skipping test')
    return true
  }
  return false
}

/** Helper: list only entity .json files (excludes _by-* dirs) */
function entityFiles(dir: string): string[] {
  return readdirSync(dir).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_'),
  )
}

/** Helper: read + parse a JSON file from the mount */
function readJSON<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

// ---------------------------------------------------------------------------
// Full scenario: one sequential flow, data accumulates naturally
// ---------------------------------------------------------------------------

describe('fuse scenarios', () => {
  test('full scenario', () => {
    const ctx = createFuseTestContext()
    if (skipIfNoFuse(ctx)) {
      return
    }
    try {
      const mp = ctx.mountPoint

      // --- Layout ---

      // Root entries
      const root = readdirSync(ctx.mountPoint)
      expect(root).toContain('contacts')
      expect(root).toContain('companies')
      expect(root).toContain('deals')
      expect(root).toContain('activities')
      expect(root).toContain('pipeline.json')
      expect(root).toContain('reports')
      expect(root).toContain('tags.json')
      expect(root).toContain('search')

      // contacts/ subdirs
      const contacts = readdirSync(join(ctx.mountPoint, 'contacts'))
      for (const sub of [
        '_by-email',
        '_by-phone',
        '_by-linkedin',
        '_by-x',
        '_by-bluesky',
        '_by-telegram',
        '_by-company',
        '_by-tag',
      ]) {
        expect(contacts).toContain(sub)
      }

      // companies/ subdirs
      const companies = readdirSync(join(ctx.mountPoint, 'companies'))
      for (const sub of ['_by-website', '_by-phone', '_by-tag']) {
        expect(companies).toContain(sub)
      }

      // deals/ subdirs
      const deals = readdirSync(join(ctx.mountPoint, 'deals'))
      for (const sub of ['_by-stage', '_by-company', '_by-tag']) {
        expect(deals).toContain(sub)
      }

      // deals/_by-stage/ pipeline stages
      const stages = readdirSync(join(ctx.mountPoint, 'deals', '_by-stage'))
      for (const stage of [
        'lead',
        'qualified',
        'proposal',
        'negotiation',
        'closed-won',
        'closed-lost',
      ]) {
        expect(stages).toContain(stage)
      }

      // activities/ subdirs
      const activities = readdirSync(join(ctx.mountPoint, 'activities'))
      for (const sub of [
        '_by-contact',
        '_by-company',
        '_by-deal',
        '_by-type',
      ]) {
        expect(activities).toContain(sub)
      }

      // reports/ entries
      const reports = readdirSync(join(ctx.mountPoint, 'reports'))
      for (const r of [
        'pipeline.json',
        'stale.json',
        'forecast.json',
        'conversion.json',
        'velocity.json',
        'won.json',
        'lost.json',
      ]) {
        expect(reports).toContain(r)
      }

      // --- Lifecycle ---

      // 1. Add contact Jane Doe with email, phone, linkedin, x, title
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--phone',
        '+1-212-555-1234',
        '--linkedin',
        'janedoe',
        '--x',
        'janedoe_x',
        '--set',
        'title=CTO',
      )

      // 2. Contact appears in readdir
      const lifecycleContactFiles = entityFiles(join(mp, 'contacts'))
      expect(lifecycleContactFiles).toHaveLength(1)
      const janeFile = lifecycleContactFiles.find((f) => f.includes('jane-doe'))
      expect(janeFile).toBeDefined()

      // 3. Read contact file, verify all fields
      const jane = readJSON<{
        name: string
        emails: string[]
        phones: string[]
        linkedin: string
        x: string
        custom_fields: { title: string }
        companies: Array<{ name: string }>
        deals: Array<{ title: string }>
        recent_activity: Array<{ note: string }>
      }>(join(mp, 'contacts', janeFile!))
      expect(jane.name).toBe('Jane Doe')
      expect(jane.emails).toContain('jane@acme.com')
      expect(jane.phones[0]).toBe('+12125551234')
      expect(jane.custom_fields.title).toBe('CTO')

      // 4. _by-email resolves
      const byEmail = readJSON<{ name: string }>(
        join(mp, 'contacts', '_by-email', 'jane@acme.com.json'),
      )
      expect(byEmail.name).toBe('Jane Doe')

      // 5. _by-phone uses E.164
      const byPhone = readJSON<{ name: string }>(
        join(mp, 'contacts', '_by-phone', '+12125551234.json'),
      )
      expect(byPhone.name).toBe('Jane Doe')

      // 6. _by-linkedin and _by-x
      const linkedinDir = readdirSync(join(mp, 'contacts', '_by-linkedin'))
      expect(linkedinDir).toContain('janedoe.json')
      const xDir = readdirSync(join(mp, 'contacts', '_by-x'))
      expect(xDir).toContain('janedoe_x.json')

      // 7. Add Bob with two emails
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Bob',
        '--email',
        'bob@acme.com',
        '--email',
        'bob@personal.com',
      )
      // Running total: 2 contacts (Jane Doe, Bob)

      // 8. _by-email has both bob emails
      const allByEmail = readdirSync(join(mp, 'contacts', '_by-email'))
      expect(allByEmail).toContain('bob@acme.com.json')
      expect(allByEmail).toContain('bob@personal.com.json')

      // 9. Add company Acme Corp with website
      ctx.runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--website',
        'acme.com',
      )
      // Running total: 1 company (Acme Corp)

      // 10. Link Jane to Acme Corp
      ctx.runOK(
        'contact',
        'edit',
        'jane@acme.com',
        '--add-company',
        'Acme Corp',
      )

      // 11. _by-company/acme-corp lists Jane
      const acmeContacts = readdirSync(
        join(mp, 'contacts', '_by-company', 'acme-corp'),
      )
      expect(acmeContacts.length).toBeGreaterThanOrEqual(1)

      // 12. Add a deal linked to Jane and Acme Corp
      const dealId = ctx
        .runOK(
          'deal',
          'add',
          '--title',
          'Big Deal',
          '--value',
          '50000',
          '--contact',
          'jane@acme.com',
          '--company',
          'acme.com',
          '--stage',
          'lead',
        )
        .trim()
      // Running total: 1 deal (Big Deal)

      // 13. Move deal to qualified
      ctx.runOK('deal', 'move', dealId, '--stage', 'qualified')

      // 14. Read deal file — stage=qualified, stage_history has 2 entries
      const dealFiles = entityFiles(join(mp, 'deals'))
      expect(dealFiles).toHaveLength(1)
      const deal = readJSON<{
        stage: string
        stage_history: unknown[]
      }>(join(mp, 'deals', dealFiles[0]))
      expect(deal.stage).toBe('qualified')
      expect(deal.stage_history.length).toBeGreaterThanOrEqual(2)

      // 15. _by-stage/qualified has the deal, lead is empty
      expect(
        readdirSync(join(mp, 'deals', '_by-stage', 'qualified')),
      ).toHaveLength(1)
      expect(readdirSync(join(mp, 'deals', '_by-stage', 'lead'))).toHaveLength(
        0,
      )

      // 16. Log a note
      ctx.runOK('log', 'note', 'Great call', '--contact', 'jane@acme.com')
      // Running total: 1 activity

      // 17. Jane's contact file now has deals and recent_activity
      const janeUpdated = readJSON<{
        deals: Array<{ title: string }>
        recent_activity: Array<{ note: string }>
        companies: Array<{ name: string }>
      }>(join(mp, 'contacts', '_by-email', 'jane@acme.com.json'))
      expect(janeUpdated.deals).toHaveLength(1)
      expect(janeUpdated.deals[0].title).toBe('Big Deal')
      expect(janeUpdated.recent_activity).toHaveLength(1)
      expect(janeUpdated.recent_activity[0].note).toContain('Great call')

      // 18. Company file via _by-website has contacts and deals linked
      const acme = readJSON<{
        name: string
        contacts: unknown[]
        deals: unknown[]
      }>(join(mp, 'companies', '_by-website', 'acme.com.json'))
      expect(acme.name).toBe('Acme Corp')
      expect(acme.contacts.length).toBeGreaterThanOrEqual(1)
      expect(acme.deals.length).toBeGreaterThanOrEqual(1)

      // 19. Tag Jane with "vip", verify _by-tag
      ctx.runOK('contact', 'edit', 'jane@acme.com', '--add-tag', 'vip')
      const vipContacts = readdirSync(join(mp, 'contacts', '_by-tag', 'vip'))
      expect(vipContacts.length).toBeGreaterThanOrEqual(1)

      // 20. tags.json returns vip with count
      const tags = readJSON<Array<{ tag: string; count: number }>>(
        join(mp, 'tags.json'),
      )
      const vipTag = tags.find((t) => t.tag === 'vip')
      expect(vipTag).toBeDefined()
      expect(vipTag!.count).toBeGreaterThanOrEqual(1)

      // --- Reports ---
      // Running total so far: 2 contacts, 1 company, 1 deal (qualified), 1 activity

      // Seed some data for reports
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Stale Bob',
        '--email',
        'staleb@acme.com',
      )
      // Running total: 3 contacts

      // 1. pipeline.json — add a deal and check structure
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
      // Running total: 2 deals (Big Deal=qualified, A=lead)
      const pipeline = readJSON<Array<{ stage: string; count: number }>>(
        join(mp, 'pipeline.json'),
      )
      expect(Array.isArray(pipeline)).toBe(true)
      expect(pipeline.length).toBeGreaterThan(0)
      expect(pipeline[0]).toHaveProperty('stage')
      expect(pipeline[0]).toHaveProperty('count')

      // 2. Won deal — add, move to closed-won, check reports/won.json
      const wonId = ctx
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
      ctx.runOK('deal', 'move', wonId, '--stage', 'closed-won')
      // Running total: 3 deals (Big Deal=qualified, A=lead, Winner=closed-won)
      const won = readJSON<Array<{ title: string; value: number }>>(
        join(mp, 'reports', 'won.json'),
      )
      expect(won).toHaveLength(1)
      expect(won[0].title).toBe('Winner')
      expect(won[0].value).toBe(25_000)

      // 3. Lost deal — add, move to closed-lost with note
      const lostId = ctx
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
        lostId,
        '--stage',
        'closed-lost',
        '--note',
        'Too expensive',
      )
      // Running total: 4 deals (Big Deal=qualified, A=lead, Winner=closed-won, Loser=closed-lost)
      const lost = readJSON<Array<{ title: string; notes: string }>>(
        join(mp, 'reports', 'lost.json'),
      )
      expect(lost).toHaveLength(1)
      expect(lost[0].title).toBe('Loser')
      expect(lost[0].notes).toContain('Too expensive')

      // 4. Stale report — Stale Bob has no recent activity
      const stale = readJSON<
        Array<{ name?: string; type: string; id: string }>
      >(join(mp, 'reports', 'stale.json'))
      expect(Array.isArray(stale)).toBe(true)
      const staleBob = stale.find((r) => r.name === 'Stale Bob')
      expect(staleBob).toBeDefined()
      expect(staleBob!.type).toBe('contact')
      expect(staleBob!.id).toBeDefined()

      // 5. Forecast — open deals with weighted values
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
      // Running total: 5 deals
      const forecast = readJSON<
        Array<{ title: string; value: number; weighted: number }>
      >(join(mp, 'reports', 'forecast.json'))
      const bigOpp = forecast.find((d) => d.title === 'Big Opp')
      expect(bigOpp).toBeDefined()
      expect(bigOpp!.value).toBe(50_000)
      expect(bigOpp!.weighted).toBe(40_000)

      // 6. Conversion — create a deal and move it for conversion data
      const convId = ctx
        .runOK('deal', 'add', '--title', 'Conv Deal', '--stage', 'lead')
        .trim()
      ctx.runOK('deal', 'move', convId, '--stage', 'qualified')
      // Running total: 6 deals
      const conversion = readJSON<
        Array<{
          stage: string
          entered: number
          advanced: number
          rate: number
        }>
      >(join(mp, 'reports', 'conversion.json'))
      expect(conversion.length).toBeGreaterThan(0)
      expect(conversion[0]).toHaveProperty('stage')
      expect(conversion[0]).toHaveProperty('entered')
      expect(conversion[0]).toHaveProperty('advanced')
      expect(conversion[0]).toHaveProperty('rate')

      // 7. Velocity
      const velocity = readJSON<
        Array<{
          stage: string
          avg_ms: number
          deals: number
          avg_display: string
        }>
      >(join(mp, 'reports', 'velocity.json'))
      expect(velocity.length).toBeGreaterThan(0)
      expect(velocity[0]).toHaveProperty('stage')
      expect(velocity[0]).toHaveProperty('avg_ms')
      expect(velocity[0]).toHaveProperty('deals')
      expect(velocity[0]).toHaveProperty('avg_display')

      // Search: reading search/<query>.json
      const searchResults = readJSON<Array<{ name: string }>>(
        join(mp, 'search', 'Stale Bob.json'),
      )
      expect(Array.isArray(searchResults)).toBe(true)
      expect(searchResults.length).toBeGreaterThan(0)
      const staleBobResult = searchResults.find((r) => r.name === 'Stale Bob')
      expect(staleBobResult).toBeDefined()

      // Search with no matches returns empty array
      const noMatch = readJSON<unknown[]>(
        join(mp, 'search', 'zzzznonexistent.json'),
      )
      expect(noMatch).toEqual([])

      // --- Write operations ---
      // Running total: 3 contacts, 1 company, 6 deals, 1 activity

      // 1. Write a new contact via writeFileSync
      writeFile(
        join(mp, 'contacts', 'new.json'),
        JSON.stringify({
          name: 'Charlie Smith',
          emails: ['charlie@globex.com'],
          title: 'Engineer',
        }),
      )
      // Running total: 4 contacts

      // 2. Verify it appears in CLI list
      const writeContacts = ctx.runJSON<Array<{ name: string }>>(
        'contact',
        'list',
        '--format',
        'json',
      )
      const charlieInList = writeContacts.find(
        (c) => c.name === 'Charlie Smith',
      )
      expect(charlieInList).toBeDefined()

      // 3. Read the contact file, update a field, write it back
      const charlieFiles = entityFiles(join(mp, 'contacts')).filter((f) =>
        f.includes('charlie-smith'),
      )
      expect(charlieFiles.length).toBeGreaterThanOrEqual(1)
      const charliePath = join(mp, 'contacts', charlieFiles[0])
      const charlieData = readJSON<{
        name: string
        emails: string[]
        custom_fields?: { title?: string }
      }>(charliePath)
      // Add custom_fields via overwrite
      writeFile(
        charliePath,
        JSON.stringify({
          ...charlieData,
          custom_fields: { title: 'CTO' },
        }),
      )

      // 4. Verify change appears in CLI show
      const charlieShow = ctx.runOK('contact', 'show', 'charlie@globex.com')
      expect(charlieShow).toContain('CTO')

      // 5. Delete contact via unlinkSync
      unlinkSync(charliePath)
      // Running total: 3 contacts (Charlie deleted)

      // 6. CLI can't find it
      ctx.runFail('contact', 'show', 'charlie@globex.com')

      // 7. Write a new company and activity via filesystem
      writeFile(
        join(mp, 'companies', 'new.json'),
        JSON.stringify({
          name: 'Globex Corp',
          websites: ['globex.com'],
          industry: 'Manufacturing',
        }),
      )
      // Running total: 2 companies (Acme Corp, Globex Corp)
      const companyList = ctx.runJSON<Array<{ name: string }>>(
        'company',
        'list',
        '--format',
        'json',
      )
      const globexInList = companyList.find((c) => c.name === 'Globex Corp')
      expect(globexInList).toBeDefined()

      // Add a contact for activity linking
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Diana',
        '--email',
        'diana@acme.com',
      )
      // Running total: 4 contacts
      writeFile(
        join(mp, 'activities', 'new.json'),
        JSON.stringify({
          type: 'note',
          entity_ref: 'diana@acme.com',
          note: 'Follow up on proposal',
        }),
      )
      // Running total: 2 activities
      const dianaActivities = ctx.runJSON<unknown[]>(
        'activity',
        'list',
        '--contact',
        'diana@acme.com',
        '--format',
        'json',
      )
      expect(dianaActivities).toHaveLength(1)

      // 8. Write a deal, change stage via filesystem, verify stage tracking
      const writeDealId = ctx
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
      // Running total: 7 deals
      const writeDealFiles = entityFiles(join(mp, 'deals'))
      const writeDealFile = writeDealFiles.find((f) => f.includes('test-deal'))
      expect(writeDealFile).toBeDefined()
      const writeDealPath = join(mp, 'deals', writeDealFile!)
      const writeDealData = readJSON<{ stage: string }>(writeDealPath)
      writeDealData.stage = 'qualified'
      writeFile(writeDealPath, JSON.stringify(writeDealData))

      const dealShow = ctx.runOK('deal', 'show', writeDealId)
      expect(dealShow).toContain('qualified')
      expect(dealShow).toContain('lead')

      // Full document replacement clears fields
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'Eve Doe',
        '--email',
        'eve@acme.com',
        '--set',
        'title=CTO',
      )
      // Running total: 5 contacts
      const eveFiles = entityFiles(join(mp, 'contacts')).filter((f) =>
        f.includes('eve-doe'),
      )
      const evePath = join(mp, 'contacts', eveFiles[0])
      writeFile(
        evePath,
        JSON.stringify({ name: 'Eve Doe', emails: ['eve@acme.com'] }),
      )
      const eveData = readJSON<{ name: string; custom_fields?: unknown }>(
        evePath,
      )
      expect(eveData.name).toBe('Eve Doe')
      expect(eveData.custom_fields).toBeUndefined()

      // --- Write validation and error handling ---

      // 1. Malformed JSON rejects
      expect(() => {
        writeFileSync(join(mp, 'contacts', 'bad.json'), 'not json at all')
      }).toThrow()

      // 2. Unknown field rejects
      expect(() => {
        writeFileSync(
          join(mp, 'contacts', 'bad.json'),
          JSON.stringify({ name: 'Nobody', bogus: 'field' }),
        )
      }).toThrow()

      // 3. Missing required field rejects
      expect(() => {
        writeFileSync(
          join(mp, 'contacts', 'bad.json'),
          JSON.stringify({ emails: ['no-name@acme.com'] }),
        )
      }).toThrow()

      // 4. Type mismatch (emails as string not array) rejects
      expect(() => {
        writeFileSync(
          join(mp, 'contacts', 'bad.json'),
          JSON.stringify({ name: 'Nobody', emails: 'not-an-array' }),
        )
      }).toThrow()

      // Nothing was created by the errors above — count unchanged
      const afterBadWrites = ctx.runJSON<unknown[]>(
        'contact',
        'list',
        '--format',
        'json',
      )
      // 5 contacts: Jane Doe, Bob, Stale Bob, Diana, Eve Doe
      expect(afterBadWrites).toHaveLength(5)

      // 5. Valid write succeeds after prior validation errors
      writeFile(
        join(mp, 'contacts', 'good.json'),
        JSON.stringify({ name: 'Valid Contact', emails: ['valid@acme.com'] }),
      )
      // Running total: 6 contacts
      const afterValid = ctx.runJSON<Array<{ name: string }>>(
        'contact',
        'list',
        '--format',
        'json',
      )
      expect(afterValid).toHaveLength(6)
      const validInList = afterValid.find((c) => c.name === 'Valid Contact')
      expect(validInList).toBeDefined()

      // 6. Read nonexistent contact throws
      expect(() => {
        readFileSync(join(mp, 'contacts', 'nonexistent.json'), 'utf-8')
      }).toThrow()

      // 7. Read nonexistent _by-email entry throws
      expect(() => {
        readFileSync(
          join(mp, 'contacts', '_by-email', 'nobody@nowhere.com.json'),
          'utf-8',
        )
      }).toThrow()

      // Read nonexistent _by-phone entry throws
      expect(() => {
        readFileSync(
          join(mp, 'contacts', '_by-phone', '+19999999999.json'),
          'utf-8',
        )
      }).toThrow()

      // Read nonexistent company/deal files throw
      expect(() => {
        readFileSync(join(mp, 'companies', 'nonexistent.json'), 'utf-8')
      }).toThrow()
      expect(() => {
        readFileSync(join(mp, 'deals', 'nonexistent.json'), 'utf-8')
      }).toThrow()

      // 8. Read nonexistent report throws
      expect(() => {
        readFileSync(join(mp, 'reports', 'nonexistent.json'), 'utf-8')
      }).toThrow()

      // 9. List nonexistent _by-company subdir throws
      expect(() => {
        readdirSync(join(mp, 'contacts', '_by-company', 'nonexistent-corp'))
      }).toThrow()

      // List nonexistent _by-tag subdir throws
      expect(() => {
        readdirSync(join(mp, 'contacts', '_by-tag', 'nonexistent-tag'))
      }).toThrow()

      // Write to nonexistent top-level directory throws
      expect(() => {
        writeFileSync(
          join(mp, 'bogus', 'new.json'),
          JSON.stringify({ name: 'test' }),
        )
      }).toThrow()

      // Delete from _by-* index directories is not allowed
      ctx.runOK('contact', 'add', '--name', 'Idx', '--email', 'idx@acme.com')
      // Running total: 7 contacts
      expect(() => {
        unlinkSync(join(mp, 'contacts', '_by-email', 'idx@acme.com.json'))
      }).toThrow()

      // Unknown field on update also rejects
      const idxFiles = entityFiles(join(mp, 'contacts')).filter((f) =>
        f.includes('idx'),
      )
      const idxPath = join(mp, 'contacts', idxFiles[0])
      expect(() => {
        writeFileSync(
          idxPath,
          JSON.stringify({
            name: 'Idx',
            emails: ['idx@acme.com'],
            nonexistent: true,
          }),
        )
      }).toThrow()
      const afterBadUpdate = readJSON<{ name: string }>(idxPath)
      expect(afterBadUpdate.name).toBe('Idx')
      expect(afterBadUpdate).not.toHaveProperty('nonexistent')

      // 10. Phone normalization: various formats -> E.164
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'PhoneTest',
        '--phone',
        '+44 20 7946 0958',
      )
      // Running total: 8 contacts
      const byPhoneDir = readdirSync(join(mp, 'contacts', '_by-phone'))
      expect(byPhoneDir).toContain('+442079460958.json')
      expect(byPhoneDir).not.toContain('+44 20 7946 0958.json')
      expect(byPhoneDir).not.toContain('+44-20-7946-0958.json')

      // Phones in entity JSON are E.164
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'PhoneJane',
        '--email',
        'pj@acme.com',
        '--phone',
        '+1-415-555-9999',
      )
      // Running total: 9 contacts
      const phoneData = readJSON<{ phones: string[] }>(
        join(mp, 'contacts', '_by-email', 'pj@acme.com.json'),
      )
      expect(phoneData.phones[0]).toBe('+14155559999')

      // Company _by-phone also uses E.164
      ctx.runOK(
        'company',
        'add',
        '--name',
        'PhoneCo',
        '--phone',
        '+1-415-555-8888',
      )
      // Running total: 3 companies
      const companyByPhone = readdirSync(join(mp, 'companies', '_by-phone'))
      expect(companyByPhone).toContain('+14155558888.json')

      // Writing entity with non-E.164 phone normalizes on save
      writeFile(
        join(mp, 'contacts', 'new.json'),
        JSON.stringify({ name: 'PhoneWrite', phones: ['+44 20 7946 0958'] }),
      )
      // Running total: 10 contacts
      const phoneContacts = ctx.runJSON<
        Array<{ name: string; phones: string[] }>
      >('contact', 'list', '--format', 'json')
      const phoneWriteContact = phoneContacts.find(
        (c) => c.name === 'PhoneWrite',
      )
      expect(phoneWriteContact).toBeDefined()
      expect(phoneWriteContact!.phones[0]).toBe('+442079460958')

      // Writing entity with invalid phone rejects
      expect(() => {
        writeFileSync(
          join(mp, 'contacts', 'bad.json'),
          JSON.stringify({ name: 'BadPhone', phones: ['not-a-number'] }),
        )
      }).toThrow()

      // --- Live sync ---

      // CLI add contact -> immediately visible in readdir
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'LiveSync',
        '--email',
        'livesync@acme.com',
      )
      // Running total: 11 contacts
      const afterLiveAdd = entityFiles(join(mp, 'contacts'))
      const liveSyncFile = afterLiveAdd.find((f) => f.includes('livesync'))
      expect(liveSyncFile).toBeDefined()

      // CLI delete contact -> immediately gone from readdir
      const tempId = ctx
        .runOK('contact', 'add', '--name', 'Temp', '--email', 'temp@acme.com')
        .trim()
      // Running total: 12 contacts
      const beforeDelete = entityFiles(join(mp, 'contacts')).length
      ctx.runOK('contact', 'rm', tempId, '--force')
      // Running total: 11 contacts (Temp deleted)
      const afterDelete = entityFiles(join(mp, 'contacts')).length
      expect(afterDelete).toBe(beforeDelete - 1)

      // Write contact via filesystem -> immediately visible in CLI
      writeFile(
        join(mp, 'contacts', 'new.json'),
        JSON.stringify({ name: 'FS Created', emails: ['fs@test.com'] }),
      )
      // Running total: 12 contacts
      const fsShow = ctx.runOK('contact', 'show', 'fs@test.com')
      expect(fsShow).toContain('FS Created')

      // Multi-company linking works
      ctx.runOK('company', 'add', '--name', 'SyncCo Alpha')
      ctx.runOK('company', 'add', '--name', 'SyncCo Beta')
      // Running total: 5 companies
      ctx.runOK(
        'contact',
        'add',
        '--name',
        'MultiCo',
        '--email',
        'multico@acme.com',
        '--company',
        'SyncCo Alpha',
        '--company',
        'SyncCo Beta',
      )
      // Running total: 13 contacts
      expect(
        readdirSync(join(mp, 'contacts', '_by-company', 'syncco-alpha')),
      ).toHaveLength(1)
      expect(
        readdirSync(join(mp, 'contacts', '_by-company', 'syncco-beta')),
      ).toHaveLength(1)

      // Company with multiple websites has multiple symlinks
      ctx.runOK(
        'company',
        'add',
        '--name',
        'MultiWeb Inc',
        '--website',
        'multiweb.com',
        '--website',
        'multiweb.co.uk',
      )
      // Running total: 6 companies
      const byWebsite = readdirSync(join(mp, 'companies', '_by-website'))
      expect(byWebsite).toContain('multiweb.com.json')
      expect(byWebsite).toContain('multiweb.co.uk.json')
    } finally {
      unmountIfNotShared(ctx)
    }
  })
})

// ---------------------------------------------------------------------------
// Readonly and mount/unmount lifecycle (darwin-skipped)
// ---------------------------------------------------------------------------

describe('fuse: readonly mode', () => {
  test('--readonly prevents writes', () => {
    if (process.platform === 'darwin') {
      return
    }
    if (!canMount) {
      console.warn('mount not available — skipping test')
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
      console.warn('mount failed — skipping test')
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
      console.warn('mount failed — skipping test')
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
