import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers.ts'

describe('company add', () => {
  test('basic add returns prefixed ID', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('company', 'add', '--name', 'Acme Corp')
    expect(out.trim()).toStartWith('co_')
  })

  test('full add stores all fields', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--website',
        'acme.com/labs',
        '--tag',
        'enterprise',
        '--set',
        'industry=SaaS',
        '--set',
        'size=50-200',
        '--set',
        'founded=2020',
      )
      .trim()

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('Acme Corp')
    expect(show).toContain('acme.com')
    expect(show).toContain('SaaS')
    expect(show).toContain('50-200')
    expect(show).toContain('enterprise')
    expect(show).toContain('2020')
  })

  test('fails without --name', () => {
    const ctx = createTestContext()
    const result = ctx.runFail('company', 'add', '--website', 'acme.com')
    expect(result.stderr).toContain('name')
  })

  test('multiple websites on create', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--website',
        'acme.com',
        '--website',
        'acme.com/ventures',
      )
      .trim()

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('acme.com')
    expect(show).toContain('acme.com/ventures')
  })

  test('multiple phones on create', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--phone',
        '+1-212-555-1234',
        '--phone',
        '+44-20-7946-0958',
      )
      .trim()

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('+44 20 7946 0958')
  })

  test('lookup by any website when company has multiple', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--website',
      'acme.com',
      '--website',
      'acme.com/ventures',
    )

    const show1 = ctx.runOK('company', 'show', 'acme.com')
    const show2 = ctx.runOK('company', 'show', 'acme.com/ventures')
    expect(show1).toContain('Acme Corp')
    expect(show2).toContain('Acme Corp')
  })
})

describe('company show', () => {
  test('by website', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    const out = ctx.runOK('company', 'show', 'acme.com')
    expect(out).toContain('Acme Corp')
  })

  test('by phone', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--phone',
      '+1-212-555-1234',
    )
    const out = ctx.runOK('company', 'show', '+12125551234')
    expect(out).toContain('Acme Corp')
  })

  test('company with phone but no website is lookupable by phone', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Phone Only Corp',
      '--phone',
      '+44-20-7946-0958',
    )
    const out = ctx.runOK('company', 'show', '+442079460958')
    expect(out).toContain('Phone Only Corp')
  })

  test('shows linked contacts', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane Doe',
      '--email',
      'jane@acme.com',
      '--company',
      'Acme Corp',
    )
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'John Doe',
      '--email',
      'john@acme.com',
      '--company',
      'Acme Corp',
    )

    const show = ctx.runOK('company', 'show', 'acme.com')
    expect(show).toContain('Jane Doe')
    expect(show).toContain('John Doe')
  })
})

describe('company list', () => {
  test('returns all companies', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--set', 'industry=SaaS')
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Globex',
      '--set',
      'industry=Manufacturing',
    )
    ctx.runOK('company', 'add', '--name', 'Initech', '--set', 'industry=SaaS')

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(3)
  })

  test('filter by tag', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--tag', 'enterprise')
    ctx.runOK('company', 'add', '--name', 'Small Co')

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--tag',
      'enterprise',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(1)
  })
})

describe('company edit', () => {
  test('update fields', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('company', 'add', '--name', 'Acme Corp').trim()
    ctx.runOK(
      'company',
      'edit',
      id,
      '--name',
      'Acme Inc',
      '--set',
      'industry=Tech',
    )

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('Acme Inc')
    expect(show).toContain('Tech')
  })

  test('edit by website', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK('company', 'edit', 'acme.com', '--set', 'industry=Fintech')

    const show = ctx.runOK('company', 'show', 'acme.com')
    expect(show).toContain('Fintech')
  })

  test('add website to existing company', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
      .trim()
    ctx.runOK('company', 'edit', id, '--add-website', 'acme.com/ventures')

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('acme.com')
    expect(show).toContain('acme.com/ventures')
  })

  test('remove website from company', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme',
        '--website',
        'acme.com',
        '--website',
        'old-acme.com',
      )
      .trim()
    ctx.runOK('company', 'edit', id, '--rm-website', 'old-acme.com')

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('acme.com')
    expect(show).not.toContain('old-acme.com')
  })

  test('add phone to existing company', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--phone', '+1-212-555-1234')
      .trim()
    ctx.runOK('company', 'edit', id, '--add-phone', '+44-20-7946-0958')

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).toContain('+44 20 7946 0958')
  })

  test('remove phone from company', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme',
        '--phone',
        '+1-212-555-1234',
        '--phone',
        '+1-310-555-9876',
      )
      .trim()
    ctx.runOK('company', 'edit', id, '--rm-phone', '+1-310-555-9876')

    const show = ctx.runOK('company', 'show', id)
    expect(show).toContain('+1 212 555 1234')
    expect(show).not.toContain('+1 310 555 9876')
  })
})

describe('company rm', () => {
  test('delete company', () => {
    const ctx = createTestContext()
    const id = ctx.runOK('company', 'add', '--name', 'Acme Corp').trim()
    ctx.runOK('company', 'rm', id, '--force')
    ctx.runFail('company', 'show', id)
  })

  test('does not delete linked contacts but unlinks company', () => {
    const ctx = createTestContext()
    const coID = ctx.runOK('company', 'add', '--name', 'Acme Corp').trim()
    const ctID = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'Jane',
        '--email',
        'jane@acme.com',
        '--company',
        'Acme Corp',
      )
      .trim()

    ctx.runOK('company', 'rm', coID, '--force')
    const show = ctx.runOK('contact', 'show', ctID)
    expect(show).toContain('Jane')
    expect(show).not.toContain('Acme Corp')
  })
})

describe('company website normalization', () => {
  test('strips protocol and www', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme',
      '--website',
      'https://www.acme.com/labs',
    )

    const companies = ctx.runJSON<Array<{ websites: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].websites[0]).toBe('acme.com/labs')
  })

  test('lowercase normalization', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'ACME.COM')

    const companies = ctx.runJSON<Array<{ websites: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].websites[0]).toBe('acme.com')
  })

  test('duplicate website rejected', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')

    const result = ctx.runFail(
      'company',
      'add',
      '--name',
      'Acme Inc',
      '--website',
      'acme.com',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('www variant treated as duplicate', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--website',
      'acme.com/labs',
    )

    const result = ctx.runFail(
      'company',
      'add',
      '--name',
      'Acme Inc',
      '--website',
      'www.acme.com/labs',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('subwebsites are NOT duplicates', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme US',
      '--website',
      'acme.com/north-america',
    )
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme EU',
      '--website',
      'acme.com/europe',
    )

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(2)
  })

  test('different paths on same host are NOT duplicates', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme UK',
      '--website',
      'acme.com/ventures',
    )

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(2)
  })

  test('different paths are NOT duplicates', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Global',
      '--website',
      'acme.com',
    )
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Blog',
      '--website',
      'blog.acme.com',
    )

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(2)
  })

  test('lookup works with any format', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')

    const show1 = ctx.runOK('company', 'show', 'acme.com')
    const show2 = ctx.runOK('company', 'show', 'https://www.acme.com')
    const show3 = ctx.runOK('company', 'show', 'ACME.COM')
    expect(show1).toContain('Acme')
    expect(show2).toContain('Acme')
    expect(show3).toContain('Acme')
  })

  test('add-website rejects duplicate in different format', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')
      .trim()

    const result = ctx.runFail(
      'company',
      'edit',
      id,
      '--add-website',
      'https://www.acme.com',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('rm-website matches after normalization', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme',
        '--website',
        'acme.com',
        '--website',
        'acme.com/ventures',
      )
      .trim()

    ctx.runOK('company', 'edit', id, '--rm-website', 'https://www.acme.com')

    const companies = ctx.runJSON<Array<{ websites: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].websites).toHaveLength(1)
    expect(companies[0].websites[0]).toBe('acme.com/ventures')
  })

  test('query params stripped during normalization', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme',
      '--website',
      'acme.com/pricing?ref=google&utm_source=ads',
    )

    const companies = ctx.runJSON<Array<{ websites: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].websites[0]).toBe('acme.com/pricing')
  })

  test('hash fragments stripped during normalization', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme',
      '--website',
      'acme.com/docs#installation',
    )

    const companies = ctx.runJSON<Array<{ websites: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].websites[0]).toBe('acme.com/docs')
  })

  test('query params and hash treated as duplicate of clean URL', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--website',
      'acme.com/pricing',
    )

    const result = ctx.runFail(
      'company',
      'add',
      '--name',
      'Acme Inc',
      '--website',
      'acme.com/pricing?ref=google#top',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('lookup works with query params and hash in URL', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--website', 'acme.com')

    const show = ctx.runOK(
      'company',
      'show',
      'acme.com?utm_source=linkedin#about',
    )
    expect(show).toContain('Acme')
  })

  test('websites stored as normalized in JSON output', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme',
      '--website',
      'https://WWW.Acme.COM/labs',
    )

    const companies = ctx.runJSON<Array<{ websites: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].websites[0]).toBe('acme.com/labs')
  })
})

describe('company merge', () => {
  test('merges two companies keeping first', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--website',
        'acme.com',
        '--tag',
        'enterprise',
      )
      .trim()
    const id2 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Inc',
        '--website',
        'acme.com/ventures',
        '--tag',
        'uk',
      )
      .trim()

    ctx.runOK('company', 'merge', id1, id2, '--keep-first')

    const show = ctx.runOK('company', 'show', id1)
    expect(show).toContain('acme.com')
    expect(show).toContain('acme.com/ventures')
    expect(show).toContain('enterprise')
    expect(show).toContain('uk')

    ctx.runFail('company', 'show', id2)
  })

  test('merge combines phones', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Corp',
        '--phone',
        '+1-212-555-1234',
      )
      .trim()
    const id2 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Inc',
        '--phone',
        '+44-20-7946-0958',
      )
      .trim()

    ctx.runOK('company', 'merge', id1, id2, '--keep-first')

    const companies = ctx.runJSON<Array<{ phones: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].phones).toHaveLength(2)
  })

  test('merge relinks contacts to surviving company', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
      .trim()
    const id2 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Inc',
        '--website',
        'acme.com/ventures',
      )
      .trim()
    const contact = ctx
      .runOK(
        'contact',
        'add',
        '--name',
        'John',
        '--email',
        'john@acme.co.uk',
        '--company',
        'Acme Inc',
      )
      .trim()

    ctx.runOK('company', 'merge', id1, id2, '--keep-first')

    const contactShow = ctx.runOK('contact', 'show', contact)
    expect(contactShow).toContain('Acme Corp')
    expect(contactShow).not.toContain('Acme Inc')
  })

  test('merge relinks deals to surviving company', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
      .trim()
    const id2 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Inc',
        '--website',
        'acme.com/ventures',
      )
      .trim()
    const deal = ctx
      .runOK('deal', 'add', '--title', 'Deal B', '--company', id2)
      .trim()

    ctx.runOK('company', 'merge', id1, id2, '--keep-first')

    const dealShow = ctx.runOK('deal', 'show', deal)
    expect(dealShow).toContain(id1)
    expect(dealShow).not.toContain(id2)
  })

  test('merge transfers activities to surviving company', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('company', 'add', '--name', 'Acme Corp', '--website', 'acme.com')
      .trim()
    const id2 = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme Inc',
        '--website',
        'acme.com/ventures',
      )
      .trim()
    ctx.runOK('log', 'note', 'acme.com/ventures', 'Activity on the old company')

    ctx.runOK('company', 'merge', id1, id2, '--keep-first')

    const activities = ctx.runJSON<unknown[]>(
      'activity',
      'list',
      '--company',
      'acme.com',
      '--format',
      'json',
    )
    expect(activities).toHaveLength(1)
  })

  test('merge combines custom fields', () => {
    const ctx = createTestContext()
    const id1 = ctx
      .runOK('company', 'add', '--name', 'Acme Corp', '--set', 'industry=SaaS')
      .trim()
    const id2 = ctx
      .runOK('company', 'add', '--name', 'Acme Inc', '--set', 'size=50-200')
      .trim()

    ctx.runOK('company', 'merge', id1, id2, '--keep-first')

    const show = ctx.runOK('company', 'show', id1)
    expect(show).toContain('SaaS')
    expect(show).toContain('50-200')
  })
})

describe('company phone normalization', () => {
  test('various formats normalize to same E.164', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--phone',
      '+1-212-555-1234',
    )

    const show1 = ctx.runOK('company', 'show', '+12125551234')
    const show2 = ctx.runOK('company', 'show', '+1-212-555-1234')
    expect(show1).toContain('Acme Corp')
    expect(show2).toContain('Acme Corp')
  })

  test('phones stored as E.164 in JSON output', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--phone',
      '+44 20 7946 0958',
    )

    const companies = ctx.runJSON<Array<{ phones: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].phones[0]).toBe('+442079460958')
  })

  test('duplicate detection across formats', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Acme Corp',
      '--phone',
      '+1-212-555-1234',
    )

    const result = ctx.runFail(
      'company',
      'add',
      '--name',
      'Other Corp',
      '--phone',
      '(212) 555-1234',
    )
    expect(result.stderr).toContain('duplicate')
  })

  test('invalid phone rejected', () => {
    const ctx = createTestContext()
    const result = ctx.runFail(
      'company',
      'add',
      '--name',
      'Acme',
      '--phone',
      'not-a-number',
    )
    expect(result.stderr).toContain('invalid')
  })

  test('rm-phone matches across formats', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK(
        'company',
        'add',
        '--name',
        'Acme',
        '--phone',
        '+1-212-555-1234',
        '--phone',
        '+44-20-7946-0958',
      )
      .trim()

    ctx.runOK('company', 'edit', id, '--rm-phone', '+12125551234')

    const companies = ctx.runJSON<Array<{ phones: string[] }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies[0].phones).toHaveLength(1)
    expect(companies[0].phones[0]).toBe('+442079460958')
  })

  test('add-phone rejects duplicate in different format', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--phone', '+1-212-555-1234')
      .trim()

    const result = ctx.runFail(
      'company',
      'edit',
      id,
      '--add-phone',
      '(212) 555-1234',
    )
    expect(result.stderr).toContain('duplicate')
  })
})

describe('company auto-creation', () => {
  test('contact add with --company auto-creates company stub', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--company', 'NewCo')

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(1)
  })

  test('deal add with --company auto-creates company stub', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'Big Deal', '--company', 'NewCo')

    const companies = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(1)
  })
})

describe('company list --filter', () => {
  test('filter by exact name', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp')
    ctx.runOK('company', 'add', '--name', 'Beta Inc')

    const data = ctx.runJSON<Array<{ name: string }>>(
      'company',
      'list',
      '--filter',
      'name=Acme Corp',
      '--format',
      'json',
    )
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('Acme Corp')
  })

  test('filter by custom field', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'SaaSCo', '--set', 'industry=SaaS')
    ctx.runOK('company', 'add', '--name', 'FinCo', '--set', 'industry=Finance')

    const data = ctx.runJSON<Array<{ name: string }>>(
      'company',
      'list',
      '--filter',
      'industry=SaaS',
      '--format',
      'json',
    )
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('SaaSCo')
  })

  test('filter with != operator', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--set', 'industry=SaaS')
    ctx.runOK('company', 'add', '--name', 'Beta', '--set', 'industry=Finance')
    ctx.runOK('company', 'add', '--name', 'Gamma', '--set', 'industry=SaaS')

    const data = ctx.runJSON<Array<{ name: string }>>(
      'company',
      'list',
      '--filter',
      'industry!=SaaS',
      '--format',
      'json',
    )
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('Beta')
  })

  test('filter with ~= substring match', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme Corp')
    ctx.runOK('company', 'add', '--name', 'Beta Inc')
    ctx.runOK('company', 'add', '--name', 'Acme Labs')

    const data = ctx.runJSON<Array<{ name: string }>>(
      'company',
      'list',
      '--filter',
      'name~=Acme',
      '--format',
      'json',
    )
    expect(data).toHaveLength(2)
  })

  test('filter with OR logic', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'A', '--set', 'tier=gold')
    ctx.runOK('company', 'add', '--name', 'B', '--set', 'tier=silver')
    ctx.runOK('company', 'add', '--name', 'C', '--set', 'tier=bronze')

    const data = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--filter',
      'tier=gold OR tier=silver',
      '--format',
      'json',
    )
    expect(data).toHaveLength(2)
  })

  test('filter returns empty when no match', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'Acme', '--set', 'industry=SaaS')

    const data = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--filter',
      'industry=Healthcare',
      '--format',
      'json',
    )
    expect(data).toHaveLength(0)
  })

  test('filter combined with --tag', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'company',
      'add',
      '--name',
      'A',
      '--set',
      'industry=SaaS',
      '--tag',
      'vip',
    )
    ctx.runOK(
      'company',
      'add',
      '--name',
      'B',
      '--set',
      'industry=SaaS',
      '--tag',
      'cold',
    )
    ctx.runOK(
      'company',
      'add',
      '--name',
      'C',
      '--set',
      'industry=Finance',
      '--tag',
      'vip',
    )

    const data = ctx.runJSON<unknown[]>(
      'company',
      'list',
      '--filter',
      'industry=SaaS',
      '--tag',
      'vip',
      '--format',
      'json',
    )
    expect(data).toHaveLength(1)
  })
})
