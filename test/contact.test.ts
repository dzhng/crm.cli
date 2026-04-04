import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('contact add', () => {
  test('basic add returns prefixed ID', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('contact', 'add', '--name', 'Jane Doe')
    expect(out.trim()).toStartWith('ct_')
  })

  test('full add stores all fields', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact', 'add',
        '--name', 'Jane Doe',
        '--email', 'jane@acme.com',
        '--phone', '+1-212-555-1234',
        '--company', 'Acme Corp',
        '--tag', 'hot-lead',
        '--tag', 'enterprise',
        '--set', 'title=CTO',
        '--set', 'source=conference',
        '--set', 'linkedin=linkedin.com/in/janedoe',
      )
      .trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Jane Doe')
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('CTO')
    expect(show).toContain('conference')
    expect(show).toContain('hot-lead')
    expect(show).toContain('enterprise')
    expect(show).toContain('linkedin.com/in/janedoe')
  })

  test('fails without --name', () => {
    const ctx = createTestContext()
    const result = ctx.runFail('contact', 'add', '--email', 'nobody@example.com')
    expect(result.stderr).toContain('name')
  })

  test('rejects duplicate email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com')
    const result = ctx.runFail('contact', 'add', '--name', 'Jane Smith', '--email', 'jane@acme.com')
    expect(result.stderr).toContain('duplicate')
  })

  test('multiple emails on create', () => {
    const ctx = createTestContext()
    const id = ctx.runOK(
      'contact', 'add', '--name', 'Jane Doe',
      '--email', 'jane@acme.com', '--email', 'jane.doe@gmail.com',
    ).trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('jane.doe@gmail.com')
  })

  test('multiple phones on create', () => {
    const ctx = createTestContext()
    const id = ctx.runOK(
      'contact', 'add', '--name', 'Jane Doe',
      '--phone', '+1-212-555-1234', '--phone', '+44-20-7946-0958',
    ).trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('+44 20 7946 0958')
  })

  test('lookup by any email when contact has multiple', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact', 'add', '--name', 'Jane Doe',
      '--email', 'jane@acme.com', '--email', 'jane.doe@gmail.com',
    )

    const show1 = ctx.runOK('contact', 'show', 'jane@acme.com')
    const show2 = ctx.runOK('contact', 'show', 'jane.doe@gmail.com')
    expect(show1).toContain('Jane Doe')
    expect(show2).toContain('Jane Doe')
  })

  test('duplicate check applies across all emails', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com', '--email', 'jane@personal.com')
    // Adding a new contact with jane@personal.com should fail — it belongs to Jane.
    const result = ctx.runFail('contact', 'add', '--name', 'Other Jane', '--email', 'jane@personal.com')
    expect(result.stderr).toContain('duplicate')
  })
})

describe('contact show', () => {
  test('by email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com')
    const out = ctx.runOK('contact', 'show', 'jane@acme.com')
    expect(out).toContain('Jane Doe')
  })

  test('by phone', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--phone', '+1-212-555-1234')
    const out = ctx.runOK('contact', 'show', '+12125551234')
    expect(out).toContain('Jane Doe')
  })

  test('contact with phone but no email is lookupable by phone', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Phone Only', '--phone', '+44-20-7946-0958')
    const out = ctx.runOK('contact', 'show', '+442079460958')
    expect(out).toContain('Phone Only')
  })

  test('not found returns error', () => {
    const ctx = createTestContext()
    ctx.runFail('contact', 'show', 'nonexistent@example.com')
  })
})

describe('contact list', () => {
  test('empty database returns empty array', () => {
    const ctx = createTestContext()
    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(contacts).toEqual([])
  })

  test('returns all contacts', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--email', 'alice@example.com')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@example.com')
    ctx.runOK('contact', 'add', '--name', 'Charlie', '--email', 'charlie@example.com')

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--format', 'json')
    expect(contacts).toHaveLength(3)
  })

  test('filter by tag', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--email', 'alice@example.com', '--tag', 'vip')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@example.com')

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--tag', 'vip', '--format', 'json')
    expect(contacts).toHaveLength(1)
  })

  test('filter by company', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--email', 'alice@acme.com', '--company', 'Acme')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@other.com', '--company', 'Other')

    const contacts = ctx.runJSON<unknown[]>('contact', 'list', '--company', 'Acme', '--format', 'json')
    expect(contacts).toHaveLength(1)
  })

  test('sort by name', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Charlie')
    ctx.runOK('contact', 'add', '--name', 'Alice')
    ctx.runOK('contact', 'add', '--name', 'Bob')

    const contacts = ctx.runJSON<Array<{ name: string }>>('contact', 'list', '--sort', 'name', '--format', 'json')
    expect(contacts.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  test('limit and offset', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'A')
    ctx.runOK('contact', 'add', '--name', 'B')
    ctx.runOK('contact', 'add', '--name', 'C')
    ctx.runOK('contact', 'add', '--name', 'D')

    const page1 = ctx.runJSON<unknown[]>('contact', 'list', '--limit', '2', '--format', 'json')
    expect(page1).toHaveLength(2)

    const page2 = ctx.runJSON<unknown[]>('contact', 'list', '--limit', '2', '--offset', '2', '--format', 'json')
    expect(page2).toHaveLength(2)
  })

  test('format ids outputs one ID per line', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice')
    ctx.runOK('contact', 'add', '--name', 'Bob')

    const out = ctx.runOK('contact', 'list', '--format', 'ids')
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).toStartWith('ct_')
    }
  })

  test('format csv has header and data rows', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--email', 'alice@example.com')

    const out = ctx.runOK('contact', 'list', '--format', 'csv')
    const lines = out.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toContain('name')
    expect(lines[0]).toContain('email')
    expect(lines[1]).toContain('Alice')
    expect(lines[1]).toContain('alice@example.com')
  })

  test('filter expression on custom fields', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--set', 'title=CTO', '--set', 'source=conference')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--set', 'title=Engineer', '--set', 'source=inbound')
    ctx.runOK('contact', 'add', '--name', 'Charlie', '--set', 'title=CTO', '--set', 'source=inbound')

    const contacts = ctx.runJSON<unknown[]>(
      'contact', 'list', '--filter', 'title=CTO AND source=inbound', '--format', 'json',
    )
    expect(contacts).toHaveLength(1)
  })
})

describe('contact edit', () => {
  test('update fields by ID', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--set', 'title=Engineer').trim()
    ctx.runOK('contact', 'edit', id, '--name', 'Jane Smith', '--set', 'title=CTO')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Jane Smith')
    expect(show).toContain('CTO')
    expect(show).not.toContain('Jane Doe')
  })

  test('update by email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com')
    ctx.runOK('contact', 'edit', 'jane@acme.com', '--set', 'title=CEO')

    const show = ctx.runOK('contact', 'show', 'jane@acme.com')
    expect(show).toContain('CEO')
  })

  test('set and unset custom fields', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--set', 'github=janedoe').trim()

    ctx.runOK('contact', 'edit', id, '--set', 'github=janesmith')
    expect(ctx.runOK('contact', 'show', id)).toContain('janesmith')

    ctx.runOK('contact', 'edit', id, '--unset', 'github')
    expect(ctx.runOK('contact', 'show', id)).not.toContain('github')
  })

  test('add and remove tags', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--tag', 'lead').trim()
    ctx.runOK('contact', 'edit', id, '--add-tag', 'vip', '--rm-tag', 'lead')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('vip')
    expect(show).not.toContain('lead')
  })

  test('add email to existing contact', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com').trim()
    ctx.runOK('contact', 'edit', id, '--add-email', 'jane.doe@gmail.com')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('jane.doe@gmail.com')
  })

  test('remove email from contact', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com', '--email', 'old@acme.com').trim()
    ctx.runOK('contact', 'edit', id, '--rm-email', 'old@acme.com')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('jane@acme.com')
    expect(show).not.toContain('old@acme.com')
  })

  test('add phone to existing contact', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234').trim()
    ctx.runOK('contact', 'edit', id, '--add-phone', '+44-20-7946-0958')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('+44 20 7946 0958')
  })

  test('remove phone from contact', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234', '--phone', '+1-310-555-9876').trim()
    ctx.runOK('contact', 'edit', id, '--rm-phone', '+1-310-555-9876')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).not.toContain('+1 310 555 9876')
  })
})

describe('contact rm', () => {
  test('delete by ID', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com').trim()
    ctx.runOK('contact', 'rm', id, '--force')
    ctx.runFail('contact', 'show', id)
  })

  test('delete by email', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
    ctx.runOK('contact', 'rm', 'jane@acme.com', '--force')
    ctx.runFail('contact', 'show', 'jane@acme.com')
  })
})

describe('contact phone normalization', () => {
  test('various formats normalize to same E.164', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')

    // All these formats should find the same contact
    const show1 = ctx.runOK('contact', 'show', '+12125551234')
    const show2 = ctx.runOK('contact', 'show', '+1-212-555-1234')
    const show3 = ctx.runOK('contact', 'show', '(212) 555-1234')  // requires default_country=US
    expect(show1).toContain('Jane')
    expect(show2).toContain('Jane')
    expect(show3).toContain('Jane')
  })

  test('phones stored as E.164 in JSON output', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>('contact', 'list', '--format', 'json')
    expect(contacts[0].phones[0]).toBe('+12125551234')
  })

  test('display format is international by default', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+12125551234')

    const show = ctx.runOK('contact', 'show', '+12125551234')
    expect(show).toContain('+1 212 555 1234')
  })

  test('duplicate detection across formats', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')

    // Same number in different format — should fail as duplicate
    const result = ctx.runFail('contact', 'add', '--name', 'Bob', '--phone', '(212) 555-1234')
    expect(result.stderr).toContain('duplicate')
  })

  test('invalid phone number rejected', () => {
    const ctx = createTestContext()
    const result = ctx.runFail('contact', 'add', '--name', 'Jane', '--phone', 'not-a-number')
    expect(result.stderr).toContain('invalid')
  })

  test('too-short phone number rejected', () => {
    const ctx = createTestContext()
    const result = ctx.runFail('contact', 'add', '--name', 'Jane', '--phone', '123')
    expect(result.stderr).toContain('invalid')
  })

  test('national format uses default_country from config', () => {
    const ctx = createTestContext()
    // With default_country=US in config, a national number should normalize to +1
    ctx.runWithEnv({ CRM_PHONE_DEFAULT_COUNTRY: 'US' },
      'contact', 'add', '--name', 'Jane', '--phone', '(212) 555-1234',
    )

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>('contact', 'list', '--format', 'json')
    expect(contacts[0].phones[0]).toBe('+12125551234')
  })

  test('national format fails without default_country when no country code', () => {
    const ctx = createTestContext()
    // Without default_country and without +country prefix, should fail
    const result = ctx.runFail('contact', 'add', '--name', 'Jane', '--phone', '2125551234')
    expect(result.stderr).toContain('country')
  })

  test('rm-phone matches across formats', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234', '--phone', '+44-20-7946-0958').trim()

    // Remove using a different format than how it was added
    ctx.runOK('contact', 'edit', id, '--rm-phone', '(212) 555-1234')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>('contact', 'list', '--format', 'json')
    expect(contacts[0].phones).toHaveLength(1)
    expect(contacts[0].phones[0]).toBe('+442079460958')
  })

  test('add-phone rejects duplicate in different format', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234').trim()

    const result = ctx.runFail('contact', 'edit', id, '--add-phone', '(212) 555-1234')
    expect(result.stderr).toContain('duplicate')
  })

  test('UK number normalization', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+44 20 7946 0958')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>('contact', 'list', '--format', 'json')
    expect(contacts[0].phones[0]).toBe('+442079460958')

    // Lookup with different format
    const show = ctx.runOK('contact', 'show', '+44-20-7946-0958')
    expect(show).toContain('Jane')
  })

  test('display format e164', () => {
    const ctx = createTestContext()
    ctx.runWithEnv({ CRM_PHONE_DISPLAY: 'e164' },
      'contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234',
    )

    const show = ctx.runOK('contact', 'show', '+12125551234')
    expect(show).toContain('+12125551234')
  })
})

describe('contact merge', () => {
  test('merges two contacts keeping first', () => {
    const ctx = createTestContext()
    const id1 = ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--tag', 'vip').trim()
    const id2 = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.doe@gmail.com', '--tag', 'enterprise').trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const show = ctx.runOK('contact', 'show', id1)
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('jane.doe@gmail.com')
    expect(show).toContain('vip')
    expect(show).toContain('enterprise')

    ctx.runFail('contact', 'show', id2)
  })

  test('merge combines phones', () => {
    const ctx = createTestContext()
    const id1 = ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234').trim()
    const id2 = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--phone', '+44-20-7946-0958').trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>('contact', 'list', '--format', 'json')
    expect(contacts[0].phones).toHaveLength(2)
  })

  test('merge transfers deals to surviving contact', () => {
    const ctx = createTestContext()
    const id1 = ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com').trim()
    const id2 = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.doe@gmail.com').trim()
    ctx.runOK('deal', 'add', '--title', 'Big Deal', '--contact', 'jane.doe@gmail.com')

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    // Deal should now be linked to surviving contact
    const deals = ctx.runJSON<unknown[]>('deal', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(deals).toHaveLength(1)
  })

  test('merge transfers activities to surviving contact', () => {
    const ctx = createTestContext()
    const id1 = ctx.runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com').trim()
    const id2 = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.doe@gmail.com').trim()
    ctx.runOK('log', 'note', 'jane.doe@gmail.com', 'Activity on the old record')

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    // Activity should be linked to surviving contact
    const activities = ctx.runJSON<unknown[]>('activity', 'list', '--contact', 'jane@acme.com', '--format', 'json')
    expect(activities).toHaveLength(1)
  })

  test('merge combines custom fields', () => {
    const ctx = createTestContext()
    const id1 = ctx.runOK('contact', 'add', '--name', 'Jane', '--set', 'title=CTO').trim()
    const id2 = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--set', 'linkedin=linkedin.com/in/jdoe').trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const show = ctx.runOK('contact', 'show', id1)
    expect(show).toContain('CTO')
    expect(show).toContain('linkedin.com/in/jdoe')
  })
})

describe('contact merge', () => {
  test('relinks deals from second contact to first', () => {
    const ctx = createTestContext()
    const first = ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com').trim()
    const second = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.personal@gmail.com').trim()
    const deal = ctx.runOK('deal', 'add', '--title', 'Big Deal', '--contact', second).trim()

    ctx.runOK('contact', 'merge', first, second, '--keep-first')

    const show = ctx.runOK('deal', 'show', deal)
    expect(show).toContain(first)
    expect(show).not.toContain(second)
  })

  test('preserves company link when merging duplicate contacts', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--domain', 'acme.com')
    const first = ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--email', 'jane@acme.com', '--company', 'Acme Corp').trim()
    const second = ctx.runOK('contact', 'add', '--name', 'J. Doe', '--email', 'jane.personal@gmail.com').trim()

    ctx.runOK('contact', 'merge', first, second, '--keep-first')

    const show = ctx.runOK('contact', 'show', first)
    expect(show).toContain('Acme Corp')
  })
})
