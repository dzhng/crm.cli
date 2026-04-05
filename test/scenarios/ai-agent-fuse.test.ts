/*
 * ============================================================================
 * PERSONA: Aria — An AI Agent Using the CRM via FUSE / Filesystem
 * ============================================================================
 *
 * Aria is an AI agent (similar to Claude Code or a custom LLM pipeline) that
 * interacts with crm.cli primarily through the filesystem interface rather
 * than CLI commands. Aria's workflow:
 *
 * - Reads CRM data by traversing the exported filesystem tree (ls + cat)
 * - Uses _by-email, _by-tag, _by-stage lookups as a structured index
 * - Writes new data via CLI (the filesystem is read-only), then re-exports
 *   to see the updated state
 * - Generates reports by reading JSON files from the reports/ directory
 * - Uses the filesystem as a RAG-friendly data layer — each entity is a
 *   self-contained JSON file that can be fed directly into an LLM context
 *
 * Why this scenario matters:
 * - Tests export-fs as the primary data access method for AI agents
 * - Validates that the filesystem tree is a complete, consistent view of
 *   the CRM state — an agent should never need to fall back to the CLI for
 *   reads once the FS is exported
 * - Tests the _by-* symlink/copy indexes for efficient lookup
 * - Validates JSON files are self-contained and parseable (no dangling refs)
 * - Tests the round-trip: CLI write → export-fs → filesystem read
 * - Exercises the reports/ directory as a pre-computed analytics layer
 * - This is crm.cli's killer feature for AI integration — the CRM becomes
 *   just a directory tree that any tool (cat, jq, find, grep) can query
 * ============================================================================
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from '../helpers'

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('scenario: AI agent using CRM via export-fs filesystem', () => {
  test('agent populates CRM via CLI, then reads everything through the filesystem', () => {
    const ctx = createTestContext()
    const fsDir = join(ctx.dir, 'crm-fs')

    // ── Step 1: Agent creates data via CLI (the write path) ──
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--website',
      'acme.com',
      '--tag',
      'enterprise',
      '--set',
      'industry=SaaS',
    )
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Widgets Inc',
      '--website',
      'widgets.io',
      '--tag',
      'smb',
      '--set',
      'industry=Manufacturing',
    )

    const ct1 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
        '--linkedin',
        'janedoe',
        '--x',
        'janedoe',
        '--tag',
        'decision-maker',
        '--tag',
        'enterprise',
        '--set',
        'title=CTO',
      )
      .trim()
    const ct2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Bob Smith',
        '--email',
        'bob@widgets.io',
        '--company',
        'Widgets Inc',
        '--bluesky',
        'bob.bsky.social',
        '--tag',
        'champion',
        '--set',
        'title=VP Engineering',
      )
      .trim()

    const dl1 = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Acme Enterprise License',
        '--value',
        '120000',
        '--contact',
        'jane@acme.com',
        '--company',
        'acme.com',
        '--tag',
        'enterprise',
        '--tag',
        'q2',
        '--probability',
        '60',
        '--expected-close',
        '2026-07-01',
      )
      .trim()
    const dl2 = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'Widgets Starter',
        '--value',
        '5000',
        '--contact',
        'bob@widgets.io',
        '--company',
        'widgets.io',
        '--tag',
        'smb',
        '--probability',
        '80',
        '--expected-close',
        '2026-05-15',
      )
      .trim()

    // Move deals through pipeline
    ctx.runOK(
      'deal',
      'move',
      dl1,
      '--stage',
      'qualified',
      '--note',
      'Jane confirmed budget',
    )
    ctx.runOK(
      'deal',
      'move',
      dl2,
      '--stage',
      'qualified',
      '--note',
      'Bob wants a trial',
    )
    ctx.runOK('deal', 'move', dl2, '--stage', 'proposal', '--note', 'Sent SOW')
    ctx.runOK('deal', 'move', dl2, '--stage', 'closed-won', '--note', 'Signed!')

    // Log activities
    ctx.runOK(
      'log',
      'meeting',
      'Discovery call with Jane — discussed requirements',
      '--contact',
      ct1,
      '--deal',
      dl1,
      '--set',
      'duration=45m',
    )
    ctx.runOK(
      'log',
      'email',
      'Sent proposal to Bob',
      '--contact',
      ct2,
      '--deal',
      dl2,
    )
    ctx.runOK(
      'log',
      'note',
      'Bob mentioned they need SSO — add to requirements',
      '--contact',
      ct2,
    )

    // ── Step 2: Export as filesystem ──
    ctx.runOK('export-fs', fsDir)

    // ── Step 3: Agent reads the filesystem (the read path) ──

    // Top-level structure
    const topLevel = readdirSync(fsDir)
    expect(topLevel).toContain('contacts')
    expect(topLevel).toContain('companies')
    expect(topLevel).toContain('deals')
    expect(topLevel).toContain('activities')
    expect(topLevel).toContain('pipeline.json')
    expect(topLevel).toContain('tags.json')
    expect(topLevel).toContain('reports')

    // ── Step 4: Contact lookup by email (agent's primary lookup method) ──
    const byEmail = readdirSync(join(fsDir, 'contacts', '_by-email'))
    expect(byEmail).toContain('jane@acme.com.json')
    expect(byEmail).toContain('bob@widgets.io.json')

    const janeByEmail = readJSON<{
      id: string
      name: string
      emails: string[]
      linkedin: string
      x: string
      custom_fields: Record<string, string>
    }>(join(fsDir, 'contacts', '_by-email', 'jane@acme.com.json'))
    expect(janeByEmail.name).toBe('Jane Doe')
    expect(janeByEmail.emails).toContain('jane@acme.com')
    expect(janeByEmail.linkedin).toBe('janedoe')
    expect(janeByEmail.x).toBe('janedoe')
    expect(janeByEmail.custom_fields.title).toBe('CTO')

    // ── Step 5: Contact lookup by social handle ──
    const byLinkedin = readdirSync(join(fsDir, 'contacts', '_by-linkedin'))
    expect(byLinkedin).toContain('janedoe.json')

    const byX = readdirSync(join(fsDir, 'contacts', '_by-x'))
    expect(byX).toContain('janedoe.json')

    const byBluesky = readdirSync(join(fsDir, 'contacts', '_by-bluesky'))
    expect(byBluesky).toContain('bob.bsky.social.json')

    // ── Step 6: Contact lookup by tag ──
    const byTag = readdirSync(join(fsDir, 'contacts', '_by-tag'))
    expect(byTag).toContain('decision-maker')
    expect(byTag).toContain('champion')

    const decisionMakers = readdirSync(
      join(fsDir, 'contacts', '_by-tag', 'decision-maker'),
    )
    expect(decisionMakers.length).toBe(1)

    // ── Step 7: Company lookup by website ──
    const byWebsite = readdirSync(join(fsDir, 'companies', '_by-website'))
    expect(byWebsite).toContain('acme.com.json')
    expect(byWebsite).toContain('widgets.io.json')

    const acme = readJSON<{
      name: string
      custom_fields: Record<string, string>
    }>(join(fsDir, 'companies', '_by-website', 'acme.com.json'))
    expect(acme.name).toBe('Acme Corp')
    expect(acme.custom_fields.industry).toBe('SaaS')

    // ── Step 8: Company lookup by tag ──
    const companyByTag = readdirSync(join(fsDir, 'companies', '_by-tag'))
    expect(companyByTag).toContain('enterprise')
    expect(companyByTag).toContain('smb')

    // ── Step 9: Deal lookup by stage ──
    const byStage = readdirSync(join(fsDir, 'deals', '_by-stage'))
    expect(byStage).toContain('qualified')
    expect(byStage).toContain('closed-won')

    const qualifiedDeals = readdirSync(
      join(fsDir, 'deals', '_by-stage', 'qualified'),
    )
    expect(qualifiedDeals.length).toBe(1) // Only Acme deal in qualified

    const wonDeals = readdirSync(
      join(fsDir, 'deals', '_by-stage', 'closed-won'),
    )
    expect(wonDeals.length).toBe(1) // Widgets deal won

    // Read the won deal JSON
    const wonDeal = readJSON<{
      title: string
      value: number
      stage: string
      contacts: Array<{ name: string }>
    }>(join(fsDir, 'deals', '_by-stage', 'closed-won', wonDeals[0]))
    expect(wonDeal.title).toBe('Widgets Starter')
    expect(wonDeal.value).toBe(5000)
    expect(wonDeal.stage).toBe('closed-won')

    // ── Step 10: Deal lookup by tag ──
    const dealByTag = readdirSync(join(fsDir, 'deals', '_by-tag'))
    expect(dealByTag).toContain('enterprise')
    expect(dealByTag).toContain('smb')

    // ── Step 11: Deal lookup by company ──
    const dealByCompany = readdirSync(join(fsDir, 'deals', '_by-company'))
    expect(dealByCompany.length).toBeGreaterThanOrEqual(2)

    // ── Step 12: Activity lookup by type ──
    const actByType = readdirSync(join(fsDir, 'activities', '_by-type'))
    expect(actByType).toContain('meeting')
    expect(actByType).toContain('email')
    expect(actByType).toContain('note')
    expect(actByType).toContain('stage-change') // Auto-generated from moves

    const meetings = readdirSync(
      join(fsDir, 'activities', '_by-type', 'meeting'),
    )
    expect(meetings.length).toBeGreaterThanOrEqual(1)

    // Read a meeting activity
    const meetingFile = readJSON<{
      type: string
      body: string
      custom_fields: Record<string, string>
    }>(join(fsDir, 'activities', '_by-type', 'meeting', meetings[0]))
    expect(meetingFile.type).toBe('meeting')
    expect(meetingFile.body).toContain('Discovery call')
    expect(meetingFile.custom_fields.duration).toBe('45m')

    // ── Step 13: Activity lookup by deal ──
    const actByDeal = readdirSync(join(fsDir, 'activities', '_by-deal'))
    expect(actByDeal.length).toBeGreaterThanOrEqual(2) // dl1 and dl2 dirs

    // ── Step 14: Pipeline report from filesystem ──
    const pipeline = readJSON<
      Array<{ stage: string; count: number; value: number }>
    >(join(fsDir, 'pipeline.json'))
    expect(pipeline.length).toBeGreaterThan(0)
    const qualifiedStage = pipeline.find((s) => s.stage === 'qualified')
    expect(qualifiedStage?.count).toBe(1)
    expect(qualifiedStage?.value).toBe(120_000)

    const wonStage = pipeline.find((s) => s.stage === 'closed-won')
    expect(wonStage?.count).toBe(1)
    expect(wonStage?.value).toBe(5000)

    // ── Step 15: Tags report from filesystem ──
    const tags = readJSON<Array<{ tag: string; count: number }>>(
      join(fsDir, 'tags.json'),
    )
    expect(tags.length).toBeGreaterThan(0)
    const enterpriseTag = tags.find((t) => t.tag === 'enterprise')
    expect(enterpriseTag!.count).toBeGreaterThanOrEqual(2) // company + contact + deal

    // ── Step 16: Reports directory ──
    const reports = readdirSync(join(fsDir, 'reports'))
    expect(reports).toContain('pipeline.json')
    expect(reports).toContain('stale.json')
    expect(reports).toContain('forecast.json')
    expect(reports).toContain('conversion.json')
    expect(reports).toContain('velocity.json')
    expect(reports).toContain('won.json')
    expect(reports).toContain('lost.json')

    // Read the won report
    const wonReport = readJSON<Array<{ title: string; value: number }>>(
      join(fsDir, 'reports', 'won.json'),
    )
    expect(wonReport).toHaveLength(1)
    expect(wonReport[0].title).toBe('Widgets Starter')

    // Read the forecast report
    const forecast = readJSON<
      Array<{ title: string; value: number; probability: number }>
    >(join(fsDir, 'reports', 'forecast.json'))
    expect(forecast).toHaveLength(1) // Only the qualified deal (won is excluded)
    expect(forecast[0].title).toBe('Acme Enterprise License')

    // Read the conversion report
    const conversion = readJSON<
      Array<{ stage: string; entered: number; advanced: number }>
    >(join(fsDir, 'reports', 'conversion.json'))
    expect(conversion.length).toBeGreaterThan(0)

    // ── Step 17: Agent modifies data via CLI, re-exports, and verifies ──
    // (Round-trip: mutate via CLI → re-export → read from FS)
    ctx.runOK('deal', 'edit', dl1, '--probability', '90')
    ctx.runOK(
      'log',
      'call',
      'Follow-up call — Jane is ready to sign',
      '--contact',
      ct1,
      '--deal',
      dl1,
    )

    // Re-export
    const fsDir2 = join(ctx.dir, 'crm-fs-v2')
    ctx.runOK('export-fs', fsDir2)

    // Verify the update is reflected
    const acmeDeal = readJSON<{ probability: number }>(
      join(fsDir2, 'deals', '_by-stage', 'qualified', qualifiedDeals[0]),
    )
    expect(acmeDeal.probability).toBe(90)

    // Verify new activity appears
    const callActivities = readdirSync(
      join(fsDir2, 'activities', '_by-type', 'call'),
    )
    expect(callActivities.length).toBeGreaterThanOrEqual(1)

    // ── Step 18: Agent uses the filesystem for bulk analysis ──
    // Count all contact files (simulating: agent does `ls contacts/*.json | wc -l`)
    const contactFiles = readdirSync(join(fsDir2, 'contacts')).filter((f) =>
      f.endsWith('.json'),
    )
    expect(contactFiles).toHaveLength(2)

    // Count all deal files
    const dealFiles = readdirSync(join(fsDir2, 'deals')).filter((f) =>
      f.endsWith('.json'),
    )
    expect(dealFiles).toHaveLength(2)

    // ── Step 19: Verify every entity JSON is self-contained ──
    // (No dangling IDs — agent can understand each file in isolation)
    for (const file of contactFiles) {
      const data = readJSON<{ id: string; name: string; emails: string[] }>(
        join(fsDir2, 'contacts', file),
      )
      expect(data.id).toMatch(/^ct_/)
      expect(data.name).toBeTruthy()
    }

    for (const file of dealFiles) {
      const data = readJSON<{
        id: string
        title: string
        stage: string
        contacts: unknown[]
      }>(join(fsDir2, 'deals', file))
      expect(data.id).toMatch(/^dl_/)
      expect(data.title).toBeTruthy()
      expect(data.stage).toBeTruthy()
    }

    // ── Step 20: Verify search/ directory exists ──
    expect(existsSync(join(fsDir2, 'search'))).toBe(true)
  })
})
