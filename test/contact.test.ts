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
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--phone',
        '+1-212-555-1234',
        '--company',
        'Acme Corp',
        '--company',
        'Acme Ventures',
        '--tag',
        'hot-lead',
        '--tag',
        'enterprise',
        '--linkedin',
        'janedoe',
        '--x',
        'janedoe',
        '--set',
        'title=CTO',
        '--set',
        'source=conference',
      )
      .trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Jane Doe')
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('Acme Corp')
    expect(show).toContain('Acme Ventures')
    expect(show).toContain('janedoe') // linkedin + x handles
    expect(show).toContain('CTO')
    expect(show).toContain('conference')
    expect(show).toContain('hot-lead')
    expect(show).toContain('enterprise')
  })

  test('multiple companies on create', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--company',
        'Acme Corp',
        '--company',
        'Globex',
      )
      .trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Acme Corp')
    expect(show).toContain('Globex')
  })

  test('fails without --name', () => {
    const ctx = createTestContext()
    const result = ctx.runFail(
      'contact',
      'add',
      '--email',
      'nobody@example.com',
    )
    expect(result.stderr).toContain('name')
  })

  test('rejects duplicate email', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
    )
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Jane Smith',
      '--email',
      'jane@acme.com',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('multiple emails on create', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--email',
        'jane.doe@gmail.com',
      )
      .trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('jane.doe@gmail.com')
  })

  test('multiple phones on create', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--phone',
        '+1-212-555-1234',
        '--phone',
        '+44-20-7946-0958',
      )
      .trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('+44 20 7946 0958')
  })

  test('lookup by any email when contact has multiple', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--email',
      'jane.doe@gmail.com',
    )

    const show1 = ctx.runOK('contact', 'show', 'jane@acme.com')
    const show2 = ctx.runOK('contact', 'show', 'jane.doe@gmail.com')
    expect(show1).toContain('Jane Doe')
    expect(show2).toContain('Jane Doe')
  })

  test('duplicate check applies across all emails', () => {
    const ctx = createTestContext()
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
    // Adding a new contact with jane@personal.com should fail — it belongs to Jane.
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Other Jane',
      '--email',
      'jane@personal.com',
    )
    expect(result.stderr).toContain('duplicate')
  })
})

describe('contact show', () => {
  test('by email', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
    )
    const out = ctx.runOK('contact', 'show', 'jane@acme.com')
    expect(out).toContain('Jane Doe')
  })

  test('by phone', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--phone',
      '+1-212-555-1234',
    )
    const out = ctx.runOK('contact', 'show', '+12125551234')
    expect(out).toContain('Jane Doe')
  })

  test('contact with phone but no email is lookupable by phone', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Phone Only',
      '--phone',
      '+44-20-7946-0958',
    )
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
    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts).toEqual([])
  })

  test('returns all contacts', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--email',
      'alice@example.com',
    )
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@example.com')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Charlie',
      '--email',
      'charlie@example.com',
    )

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(3)
  })

  test('filter by tag', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--email',
      'alice@example.com',
      '--tag',
      'vip',
    )
    ctx.runOK('contact', 'add', '--name', 'Bob', '--email', 'bob@example.com')

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--tag',
      'vip',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
  })

  test('filter by company', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--email',
      'alice@acme.com',
      '--company',
      'Acme',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Bob',
      '--email',
      'bob@other.com',
      '--company',
      'Other',
    )

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--company',
      'Acme',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
  })

  test('sort by name', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Charlie')
    ctx.runOK('contact', 'add', '--name', 'Alice')
    ctx.runOK('contact', 'add', '--name', 'Bob')

    const contacts = ctx.runJSON<Array<{ name: string }>>(
      'contact',
      'list',
      '--sort',
      'name',
      '--format',
      'json',
    )
    expect(contacts.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  test('limit and offset', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'A')
    ctx.runOK('contact', 'add', '--name', 'B')
    ctx.runOK('contact', 'add', '--name', 'C')
    ctx.runOK('contact', 'add', '--name', 'D')

    const page1 = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--limit',
      '2',
      '--format',
      'json',
    )
    expect(page1).toHaveLength(2)

    const page2 = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--limit',
      '2',
      '--offset',
      '2',
      '--format',
      'json',
    )
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
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--email',
      'alice@example.com',
    )

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
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--set',
      'title=CTO',
      '--set',
      'source=conference',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Bob',
      '--set',
      'title=Engineer',
      '--set',
      'source=inbound',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Charlie',
      '--set',
      'title=CTO',
      '--set',
      'source=inbound',
    )

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--filter',
      'title=CTO AND source=inbound',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
  })

  test('filter with != operator', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--set', 'role=CTO')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--set', 'role=Engineer')
    ctx.runOK('contact', 'add', '--name', 'Charlie', '--set', 'role=CTO')

    const contacts = ctx.runJSON<Array<{ name: string }>>(
      'contact',
      'list',
      '--filter',
      'role!=CTO',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
    expect(contacts[0].name).toBe('Bob')
  })

  test('filter with ~= substring match (case-insensitive)', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice Smith')
    ctx.runOK('contact', 'add', '--name', 'Bob Jones')
    ctx.runOK('contact', 'add', '--name', 'Charlie Smithson')

    const contacts = ctx.runJSON<Array<{ name: string }>>(
      'contact',
      'list',
      '--filter',
      'name~=smith',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(2)
  })

  test('filter with > numeric comparison', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Small', '--set', 'score=10')
    ctx.runOK('contact', 'add', '--name', 'Medium', '--set', 'score=50')
    ctx.runOK('contact', 'add', '--name', 'Big', '--set', 'score=90')

    const contacts = ctx.runJSON<Array<{ name: string }>>(
      'contact',
      'list',
      '--filter',
      'score>40',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(2)
  })

  test('filter with < numeric comparison', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Small', '--set', 'score=10')
    ctx.runOK('contact', 'add', '--name', 'Big', '--set', 'score=90')

    const contacts = ctx.runJSON<Array<{ name: string }>>(
      'contact',
      'list',
      '--filter',
      'score<50',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
    expect(contacts[0].name).toBe('Small')
  })

  test('filter with OR logic', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice', '--set', 'role=CTO')
    ctx.runOK('contact', 'add', '--name', 'Bob', '--set', 'role=CEO')
    ctx.runOK('contact', 'add', '--name', 'Charlie', '--set', 'role=Engineer')

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--filter',
      'role=CTO OR role=CEO',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(2)
  })

  test('filter on non-existent field returns nothing', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice')

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--filter',
      'nonexistent=value',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(0)
  })

  test('!= on missing field matches (null != X is true)', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Alice')

    const contacts = ctx.runJSON<unknown[]>(
      'contact',
      'list',
      '--filter',
      'role!=CTO',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(1)
  })
})

describe('contact edit', () => {
  test('update fields by ID', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--set',
        'title=Engineer',
      )
      .trim()
    ctx.runOK(
      'contact',
      'edit',
      id,
      '--name',
      'Jane Smith',
      '--set',
      'title=CTO',
    )

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Jane Smith')
    expect(show).toContain('CTO')
    expect(show).not.toContain('Jane Doe')
  })

  test('update by email', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
    )
    ctx.runOK('contact', 'edit', 'jane@acme.com', '--set', 'title=CEO')

    const show = ctx.runOK('contact', 'show', 'jane@acme.com')
    expect(show).toContain('CEO')
  })

  test('set and unset custom fields', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--set', 'github=janedoe')
      .trim()

    ctx.runOK('contact', 'edit', id, '--set', 'github=janesmith')
    expect(ctx.runOK('contact', 'show', id)).toContain('janesmith')

    ctx.runOK('contact', 'edit', id, '--unset', 'github')
    expect(ctx.runOK('contact', 'show', id)).not.toContain('github')
  })

  test('add and remove tags', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--tag', 'lead')
      .trim()
    ctx.runOK('contact', 'edit', id, '--add-tag', 'vip', '--rm-tag', 'lead')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('vip')
    expect(show).not.toContain('lead')
  })

  test('add email to existing contact', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()
    ctx.runOK('contact', 'edit', id, '--add-email', 'jane.doe@gmail.com')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('jane@acme.com')
    expect(show).toContain('jane.doe@gmail.com')
  })

  test('remove email from contact', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--email',
        'old@acme.com',
      )
      .trim()
    ctx.runOK('contact', 'edit', id, '--rm-email', 'old@acme.com')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('jane@acme.com')
    expect(show).not.toContain('old@acme.com')
  })

  test('add phone to existing contact', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')
      .trim()
    ctx.runOK('contact', 'edit', id, '--add-phone', '+44-20-7946-0958')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('+44 20 7946 0958')
  })

  test('remove phone from contact', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--phone',
        '+1-212-555-1234',
        '--phone',
        '+1-310-555-9876',
      )
      .trim()
    ctx.runOK('contact', 'edit', id, '--rm-phone', '+1-310-555-9876')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).not.toContain('+1 310 555 9876')
  })

  test('add company to existing contact', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--company', 'Acme Corp')
      .trim()
    ctx.runOK('contact', 'edit', id, '--add-company', 'Globex')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Acme Corp')
    expect(show).toContain('Globex')
  })

  test('remove company from contact', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--company',
        'Acme Corp',
        '--company',
        'Old Corp',
      )
      .trim()
    ctx.runOK('contact', 'edit', id, '--rm-company', 'Old Corp')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('Acme Corp')
    expect(show).not.toContain('Old Corp')
  })
})

describe('contact rm', () => {
  test('delete by ID', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()
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
    const show3 = ctx.runOK('contact', 'show', '(212) 555-1234') // requires default_country=US
    expect(show1).toContain('Jane')
    expect(show2).toContain('Jane')
    expect(show3).toContain('Jane')
  })

  test('phones stored as E.164 in JSON output', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
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
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--phone',
      '(212) 555-1234',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('invalid phone number rejected', () => {
    const ctx = createTestContext()
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Jane',
      '--phone',
      'not-a-number',
    )
    expect(result.stderr).toContain('invalid')
  })

  test('too-short phone number rejected', () => {
    const ctx = createTestContext()
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Jane',
      '--phone',
      '123',
    )
    expect(result.stderr).toContain('invalid')
  })

  test('national format uses default_country from config', () => {
    const ctx = createTestContext()
    // With default_country=US in config, a national number should normalize to +1
    ctx.runWithEnv(
      { CRM_PHONE_DEFAULT_COUNTRY: 'US' },
      'contact',
      'add',
      '--name',
      'Jane',
      '--phone',
      '(212) 555-1234',
    )

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].phones[0]).toBe('+12125551234')
  })

  test('national format fails without default_country when no country code', () => {
    const ctx = createTestContext()
    // Without default_country and without +country prefix, should fail
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Jane',
      '--phone',
      '2125551234',
    )
    expect(result.stderr).toContain('country')
  })

  test('rm-phone matches across formats', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--phone',
        '+1-212-555-1234',
        '--phone',
        '+44-20-7946-0958',
      )
      .trim()

    // Remove using a different format than how it was added
    ctx.runOK('contact', 'edit', id, '--rm-phone', '(212) 555-1234')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].phones).toHaveLength(1)
    expect(contacts[0].phones[0]).toBe('+442079460958')
  })

  test('add-phone rejects duplicate in different format', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')
      .trim()

    const result = ctx.runFail(
      'contact',
      'edit',
      id,
      '--add-phone',
      '(212) 555-1234',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('UK number normalization', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+44 20 7946 0958')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].phones[0]).toBe('+442079460958')

    // Lookup with different format
    const show = ctx.runOK('contact', 'show', '+44-20-7946-0958')
    expect(show).toContain('Jane')
  })

  test('display format e164', () => {
    const ctx = createTestContext()
    ctx.runWithEnv(
      { CRM_PHONE_DISPLAY: 'e164' },
      'contact',
      'add',
      '--name',
      'Jane',
      '--phone',
      '+1-212-555-1234',
    )

    const show = ctx.runOK('contact', 'show', '+12125551234')
    expect(show).toContain('+12125551234')
  })
})

describe('contact social handles', () => {
  test('add with social handles', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--linkedin',
        'janedoe',
        '--x',
        'janedoe',
        '--bluesky',
        'janedoe.bsky.social',
        '--telegram',
        'janedoe',
      )
      .trim()

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('janedoe')
    expect(show).toContain('janedoe.bsky.social')
  })

  test('URL input extracts handle for LinkedIn', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--linkedin',
      'https://linkedin.com/in/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ linkedin: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].linkedin).toBe('janedoe')
  })

  test('URL input extracts handle for X', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--x',
      'https://x.com/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ x: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].x).toBe('janedoe')
  })

  test('URL input extracts handle for Bluesky', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--bluesky',
      'https://bsky.app/profile/janedoe.bsky.social',
    )

    const contacts = ctx.runJSON<Array<{ bluesky: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].bluesky).toBe('janedoe.bsky.social')
  })

  test('URL input extracts handle for Telegram', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--telegram',
      'https://t.me/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ telegram: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].telegram).toBe('janedoe')
  })

  test('LinkedIn URL without protocol', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--linkedin',
      'linkedin.com/in/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ linkedin: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].linkedin).toBe('janedoe')
  })

  test('LinkedIn URL with www', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--linkedin',
      'www.linkedin.com/in/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ linkedin: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].linkedin).toBe('janedoe')
  })

  test('LinkedIn URL with http instead of https', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--linkedin',
      'http://linkedin.com/in/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ linkedin: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].linkedin).toBe('janedoe')
  })

  test('LinkedIn URL with trailing slash', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--linkedin',
      'linkedin.com/in/janedoe/',
    )

    const contacts = ctx.runJSON<Array<{ linkedin: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].linkedin).toBe('janedoe')
  })

  test('X URL without protocol', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--x', 'x.com/janedoe')

    const contacts = ctx.runJSON<Array<{ x: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].x).toBe('janedoe')
  })

  test('X via twitter.com domain', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--x',
      'twitter.com/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ x: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].x).toBe('janedoe')
  })

  test('X via twitter.com with https', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--x',
      'https://twitter.com/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ x: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].x).toBe('janedoe')
  })

  test('X handle with @ prefix', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--x', '@janedoe')

    const contacts = ctx.runJSON<Array<{ x: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].x).toBe('janedoe')
  })

  test('Bluesky URL without protocol', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--bluesky',
      'bsky.app/profile/janedoe.bsky.social',
    )

    const contacts = ctx.runJSON<Array<{ bluesky: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].bluesky).toBe('janedoe.bsky.social')
  })

  test('Bluesky handle with @ prefix', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--bluesky',
      '@janedoe.bsky.social',
    )

    const contacts = ctx.runJSON<Array<{ bluesky: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].bluesky).toBe('janedoe.bsky.social')
  })

  test('Telegram URL without protocol', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--telegram',
      't.me/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ telegram: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].telegram).toBe('janedoe')
  })

  test('Telegram handle with @ prefix', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--telegram', '@janedoe')

    const contacts = ctx.runJSON<Array<{ telegram: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].telegram).toBe('janedoe')
  })

  test('duplicate detected across URL formats without protocol', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--x', 'janedoe')

    // Same handle via bare URL — should reject
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--x',
      'x.com/janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('duplicate detected via legacy twitter.com domain', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--x', 'janedoe')

    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--x',
      'twitter.com/janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('duplicate detected via @ prefix', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--telegram', 'janedoe')

    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--telegram',
      '@janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('lookup by URL without protocol', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--x', 'janedoe')

    const show = ctx.runOK('contact', 'show', 'x.com/janedoe')
    expect(show).toContain('Jane Doe')
  })

  test('lookup by @ prefix', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--telegram', 'janedoe')

    const show = ctx.runOK('contact', 'show', '@janedoe')
    expect(show).toContain('Jane Doe')
  })

  test('lookup by handle', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--linkedin', 'janedoe')

    const show = ctx.runOK('contact', 'show', 'janedoe')
    expect(show).toContain('Jane Doe')
  })

  test('lookup by URL extracts handle before matching', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane Doe', '--linkedin', 'janedoe')

    // URL input is normalized to handle before lookup
    const show = ctx.runOK('contact', 'show', 'linkedin.com/in/janedoe')
    expect(show).toContain('Jane Doe')
  })

  test('duplicate LinkedIn handle rejected', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--linkedin', 'janedoe')

    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--linkedin',
      'janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('duplicate via URL rejected when handle matches', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--linkedin', 'janedoe')

    // URL resolves to same handle — should be rejected
    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--linkedin',
      'https://linkedin.com/in/janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('duplicate X handle rejected', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--x', 'janedoe')

    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--x',
      'janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('duplicate Bluesky handle rejected', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane',
      '--bluesky',
      'janedoe.bsky.social',
    )

    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--bluesky',
      'janedoe.bsky.social',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('duplicate Telegram handle rejected', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--telegram', 'janedoe')

    const result = ctx.runFail(
      'contact',
      'add',
      '--name',
      'Bob',
      '--telegram',
      'janedoe',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('edit social handles', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--x', 'oldhandle')
      .trim()
    ctx.runOK(
      'contact',
      'edit',
      id,
      '--x',
      'newhandle',
      '--linkedin',
      'janedoe',
    )

    const show = ctx.runOK('contact', 'show', id)
    expect(show).toContain('newhandle')
    expect(show).toContain('janedoe')
    expect(show).not.toContain('oldhandle')
  })

  test('edit via URL input extracts handle', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('contact', 'add', '--name', 'Jane').trim()
    ctx.runOK(
      'contact',
      'edit',
      id,
      '--linkedin',
      'https://linkedin.com/in/janedoe',
    )

    const contacts = ctx.runJSON<Array<{ linkedin: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].linkedin).toBe('janedoe')
  })

  test('unset social handle', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--linkedin', 'janedoe')
      .trim()
    ctx.runOK('contact', 'edit', id, '--unset', 'linkedin')

    const show = ctx.runOK('contact', 'show', id)
    expect(show).not.toContain('janedoe')
  })

  test('social handles stored as handles in JSON output', () => {
    const ctx = createTestContext()
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

    const contacts = ctx.runJSON<
      Array<{ linkedin: string | null; x: string | null }>
    >('contact', 'list', '--format', 'json')
    expect(contacts[0].linkedin).toBe('janedoe')
    expect(contacts[0].x).toBe('janedoe_x')
  })
})

describe('contact merge', () => {
  test('merges two contacts keeping first', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--tag',
        'vip',
      )
      .trim()
    const id2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'J. Doe',
        '--email',
        'jane.doe@gmail.com',
        '--tag',
        'enterprise',
      )
      .trim()

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
    const id1 = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--phone', '+1-212-555-1234')
      .trim()
    const id2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'J. Doe',
        '--phone',
        '+44-20-7946-0958',
      )
      .trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const contacts = ctx.runJSON<Array<{ phones: string[] }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts[0].phones).toHaveLength(2)
  })

  test('merge relinks deals to surviving contact', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()
    const id2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'J. Doe',
        '--email',
        'jane.doe@gmail.com',
      )
      .trim()
    const deal = ctx
      .runOK('deal', 'add', '--title', 'Big Deal', '--contact', id2)
      .trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const dealShow = ctx.runOK('deal', 'show', deal)
    expect(dealShow).toContain(id1)
    expect(dealShow).not.toContain(id2)
  })

  test('merge transfers activities to surviving contact', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('contact', 'add', '--name', 'Jane', '--email', 'jane@acme.com')
      .trim()
    const id2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'J. Doe',
        '--email',
        'jane.doe@gmail.com',
      )
      .trim()
    ctx.runOK('log', 'note', 'jane.doe@gmail.com', 'Activity on the old record')

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--contact',
      'jane@acme.com',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('merge combines custom fields and social handles', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--set',
        'title=CTO',
        '--x',
        'janedoe',
      )
      .trim()
    const id2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'J. Doe',
        '--linkedin',
        'jdoe',
        '--set',
        'source=inbound',
      )
      .trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const show = ctx.runOK('contact', 'show', id1)
    expect(show).toContain('CTO')
    expect(show).toContain('janedoe')
    expect(show).toContain('jdoe')
    expect(show).toContain('inbound')
  })

  test('merge combines company links', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK('company', 'add', '--name', 'Globex', '--website', 'globex.com')
    const id1 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane Doe',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
      )
      .trim()
    const id2 = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'J. Doe',
        '--email',
        'jane.personal@gmail.com',
        '--company',
        'Globex',
      )
      .trim()

    ctx.runOK('contact', 'merge', id1, id2, '--keep-first')

    const show = ctx.runOK('contact', 'show', id1)
    expect(show).toContain('Acme Corp')
    expect(show).toContain('Globex')
  })
})
