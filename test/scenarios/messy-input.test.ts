/*
 * ============================================================================
 * PERSONA: David — Busy Founder Adding Contacts From His Phone
 * ============================================================================
 *
 * David is setting up his CRM for the first time. He's adding contacts
 * from memory, business cards, and his phone — so inputs are messy:
 * national phone numbers without country codes, duplicate emails he
 * already added, re-adding the same phone in a different format, etc.
 *
 * Why this scenario matters:
 * - Tests that the CLI handles imperfect, real-world inputs gracefully
 * - Validates idempotent --add-* operations (no errors on self-dupes)
 * - Covers phone numbers without international prefix (default_country)
 * - Exercises company edit with duplicate websites and phones
 * - Cross-record duplicate detection should still fire
 * - A user should never see an error when merging data onto a record
 *   that already has that data
 *
 * Typical usage: rapid-fire `crm contact add` and `crm contact edit`
 * commands from a terminal, often re-running the same command twice
 * when unsure if it worked the first time.
 * ============================================================================
 */

import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from '../helpers'

describe('idempotent add — contact', () => {
  test('add-phone with value already on contact succeeds silently', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')
      .trim()

    ctx.runOK('contact', 'edit', id, '--add-phone', '+12125551234')

    const data = ctx.runJSON<{ phones: string[] }>(
      'contact',
      'show',
      id,
      '--format',
      'json',
    )
    expect(data.phones).toHaveLength(1)
  })

  test('add-phone with same number in national format succeeds silently', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, `[phone]\ndefault_country = "US"\n`)
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'contact',
        'add',
        '--name',
        'Jane',
        '--phone',
        '+1-212-555-1234',
      )
      .trim()

    ctx.runOK(
      '--config',
      configPath,
      'contact',
      'edit',
      id,
      '--add-phone',
      '(212) 555-1234',
    )

    const data = ctx.runJSON<{ phones: string[] }>(
      '--config',
      configPath,
      'contact',
      'show',
      id,
      '--format',
      'json',
    )
    expect(data.phones).toHaveLength(1)
  })

  test('add-email with value already on contact succeeds silently', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()

    ctx.runOK('contact', 'edit', id, '--add-email', 'jane@acme.com')

    const data = ctx.runJSON<{ emails: string[] }>(
      'contact',
      'show',
      id,
      '--format',
      'json',
    )
    expect(data.emails).toHaveLength(1)
  })

  test('add-phone still rejects duplicate owned by another contact', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')
    const id2 = ctx.runOK('contact', 'add', '--name', 'Bob').trim()

    const result = ctx.runFail(
      'contact',
      'edit',
      id2,
      '--add-phone',
      '+12125551234',
    )
    expect(result.stderr).toContain('duplicate')
  })
})

describe('idempotent add — company', () => {
  test('add-phone with value already on company succeeds silently', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--phone', '+1-212-555-1234')
      .trim()

    ctx.runOK('company', 'edit', id, '--add-phone', '(212) 555-1234')

    const data = ctx.runJSON<{ phones: string[] }>(
      'company',
      'show',
      id,
      '--format',
      'json',
    )
    expect(data.phones).toHaveLength(1)
  })

  test('add-website with value already on company succeeds silently', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
      .trim()

    ctx.runOK('company', 'edit', id, '--add-website', 'https://www.acme.com')

    const data = ctx.runJSON<{ websites: string[] }>(
      'company',
      'show',
      id,
      '--format',
      'json',
    )
    expect(data.websites).toHaveLength(1)
  })

  test('add-phone still rejects duplicate owned by another company', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--phone', '+1-212-555-1234')
    const id2 = ctx.runOK('company', 'add', '--name', 'Globex').trim()

    const result = ctx.runFail(
      'company',
      'edit',
      id2,
      '--add-phone',
      '+12125551234',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('add-website still rejects duplicate owned by another company', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
    const id2 = ctx.runOK('company', 'add', '--name', 'Globex').trim()

    const result = ctx.runFail(
      'company',
      'edit',
      id2,
      '--add-website',
      'https://www.acme.com',
    )
    expect(result.stderr).toContain('duplicate')
  })
})

describe('scenario: messy real-world CRM setup', () => {
  test('first-time setup with imperfect inputs and re-runs', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, `[phone]\ndefault_country = "US"\n`)
    const cfg = ['--config', configPath]

    // ── Day 1: David sets up from memory, no international codes ──

    // First contact — phone without country code
    const david = ctx
      .runOK(
        ...cfg,
        'contact',
        'add',
        '--name',
        'David Zhang',
        '--email',
        'david@aomni.com',
        '--phone',
        '3024828022',
      )
      .trim()

    // Verify it stored as E.164
    const davidData = ctx.runJSON<{ phones: string[]; emails: string[] }>(
      ...cfg,
      'contact',
      'show',
      david,
      '--format',
      'json',
    )
    expect(davidData.phones[0]).toBe('+13024828022')
    expect(davidData.emails[0]).toBe('david@aomni.com')

    // Add a company
    const aomni = ctx
      .runOK(
        ...cfg,
        'company',
        'add',
        '--name',
        'Aomni',
        '--website',
        'aomni.com',
        '--phone',
        '6505551000',
      )
      .trim()

    // Link David to company
    ctx.runOK(...cfg, 'contact', 'edit', david, '--add-company', 'Aomni')

    // Add a second contact from a business card
    const sarah = ctx
      .runOK(
        ...cfg,
        'contact',
        'add',
        '--name',
        'Sarah Chen',
        '--email',
        'sarah@dataflow.io',
        '--phone',
        '4155559876',
        '--tag',
        'investor',
      )
      .trim()

    ctx.runOK(
      ...cfg,
      'company',
      'add',
      '--name',
      'DataFlow',
      '--website',
      'dataflow.io',
    )
    ctx.runOK(...cfg, 'contact', 'edit', sarah, '--add-company', 'DataFlow')

    // ── Day 2: David adds more info, forgets what he already entered ──

    // Re-add same email — should not fail
    ctx.runOK(
      ...cfg,
      'contact',
      'edit',
      'david@aomni.com',
      '--add-email',
      'david@aomni.com',
    )
    const afterEmailReAdd = ctx.runJSON<{ emails: string[] }>(
      ...cfg,
      'contact',
      'show',
      david,
      '--format',
      'json',
    )
    expect(afterEmailReAdd.emails).toHaveLength(1)

    // Add a personal email — should succeed
    ctx.runOK(
      ...cfg,
      'contact',
      'edit',
      'david@aomni.com',
      '--add-email',
      'dzz0615@gmail.com',
    )
    const afterNewEmail = ctx.runJSON<{ emails: string[] }>(
      ...cfg,
      'contact',
      'show',
      david,
      '--format',
      'json',
    )
    expect(afterNewEmail.emails).toHaveLength(2)
    expect(afterNewEmail.emails).toContain('dzz0615@gmail.com')

    // Re-add same phone — should not fail
    ctx.runOK(
      ...cfg,
      'contact',
      'edit',
      'david@aomni.com',
      '--add-phone',
      '3024828022',
    )
    const afterPhoneReAdd = ctx.runJSON<{ phones: string[] }>(
      ...cfg,
      'contact',
      'show',
      david,
      '--format',
      'json',
    )
    expect(afterPhoneReAdd.phones).toHaveLength(1)

    // Re-add phone in different format — should also not fail
    ctx.runOK(
      ...cfg,
      'contact',
      'edit',
      'david@aomni.com',
      '--add-phone',
      '+1-302-482-8022',
    )
    const afterPhoneFmtReAdd = ctx.runJSON<{ phones: string[] }>(
      ...cfg,
      'contact',
      'show',
      david,
      '--format',
      'json',
    )
    expect(afterPhoneFmtReAdd.phones).toHaveLength(1)

    // Combined: re-add existing phone AND add new email in one command
    ctx.runOK(
      ...cfg,
      'contact',
      'edit',
      'david@aomni.com',
      '--add-phone',
      '3024828022',
      '--add-email',
      'dz@startup.com',
    )
    const afterCombo = ctx.runJSON<{ emails: string[]; phones: string[] }>(
      ...cfg,
      'contact',
      'show',
      david,
      '--format',
      'json',
    )
    expect(afterCombo.phones).toHaveLength(1)
    expect(afterCombo.emails).toHaveLength(3)
    expect(afterCombo.emails).toContain('dz@startup.com')

    // ── Day 3: David edits company info with duplicate values ──

    // Re-add company website in different format
    ctx.runOK(
      ...cfg,
      'company',
      'edit',
      aomni,
      '--add-website',
      'https://www.aomni.com',
    )
    const aomniData = ctx.runJSON<{ websites: string[] }>(
      ...cfg,
      'company',
      'show',
      aomni,
      '--format',
      'json',
    )
    expect(aomniData.websites).toHaveLength(1)

    // Re-add company phone in different format
    ctx.runOK(...cfg, 'company', 'edit', aomni, '--add-phone', '(650) 555-1000')
    const aomniPhones = ctx.runJSON<{ phones: string[] }>(
      ...cfg,
      'company',
      'show',
      aomni,
      '--format',
      'json',
    )
    expect(aomniPhones.phones).toHaveLength(1)

    // Add a genuinely new phone to the company
    ctx.runOK(...cfg, 'company', 'edit', aomni, '--add-phone', '6505552000')
    const aomniPhones2 = ctx.runJSON<{ phones: string[] }>(
      ...cfg,
      'company',
      'show',
      aomni,
      '--format',
      'json',
    )
    expect(aomniPhones2.phones).toHaveLength(2)

    // ── Cross-record dupes still enforced ──

    // Sarah's phone should not be assignable to David
    const result = ctx.runFail(
      ...cfg,
      'contact',
      'edit',
      david,
      '--add-phone',
      '4155559876',
    )
    expect(result.stderr).toContain('duplicate')
    expect(result.stderr).toContain('Sarah Chen')

    // ── Verify final state ──

    const contacts = ctx.runJSON<
      Array<{ name: string; emails: string[]; phones: string[] }>
    >(...cfg, 'contact', 'list', '--format', 'json')
    expect(contacts).toHaveLength(2)

    const davidFinal = contacts.find((c) => c.name === 'David Zhang')!
    expect(davidFinal.emails).toHaveLength(3)
    expect(davidFinal.phones).toHaveLength(1)
    expect(davidFinal.phones[0]).toBe('+13024828022')

    const sarahFinal = contacts.find((c) => c.name === 'Sarah Chen')!
    expect(sarahFinal.emails).toHaveLength(1)
    expect(sarahFinal.phones).toHaveLength(1)

    const companies = ctx.runJSON<
      Array<{ name: string; websites: string[]; phones: string[] }>
    >(...cfg, 'company', 'list', '--format', 'json')
    expect(companies).toHaveLength(2)

    const aomniFinal = companies.find((c) => c.name === 'Aomni')!
    expect(aomniFinal.websites).toHaveLength(1)
    expect(aomniFinal.phones).toHaveLength(2)
  })
})
