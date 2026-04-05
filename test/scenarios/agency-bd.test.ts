/*
 * ============================================================================
 * PERSONA: Jordan — BD Lead at a Dev Agency
 * ============================================================================
 *
 * Jordan runs business development for a 15-person dev agency. They juggle
 * 30-50 prospects at any given time across different verticals — fintech,
 * healthcare, e-commerce. The agency sells project-based work ($20k-$200k)
 * with long sales cycles (2-4 months). Jordan cares about:
 *
 * - Tracking multiple contacts per deal (CTO + procurement + champion)
 * - Tagging deals by vertical for portfolio analysis
 * - Custom fields for deal metadata (tech stack, timeline, referral source)
 * - Filtering and reporting across verticals
 * - CSV import from their old spreadsheet
 * - Bulk operations (tagging, stage moves)
 *
 * Why this scenario matters:
 * - Tests multi-contact deals and company-deal-contact triangulation
 * - Exercises CSV import with custom fields
 * - Validates filtering, tagging, and bulk ops at moderate scale
 * - Tests the agency use case where deals have multiple stakeholders
 * - Covers custom fields heavily — agencies track different metadata
 *   than product companies
 * ============================================================================
 */

import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from '../helpers'

describe('scenario: agency BD with multi-stakeholder deals', () => {
  test('import leads, manage multi-contact deals, filter by vertical', () => {
    const ctx = createTestContext()

    // ── Import companies from CSV (migrating from a spreadsheet) ──
    const companyCsv = `name,website,tags,industry,vertical
MedVault,medvault.io,healthcare,Healthcare Tech,healthcare
FinLedger,finledger.com,"fintech,enterprise",Financial Services,fintech
ShopStream,shopstream.co,e-commerce,E-Commerce,ecommerce
PayCircle,paycircle.io,fintech,Payments,fintech
HealthBridge,healthbridge.org,healthcare,Digital Health,healthcare`

    const csvPath = join(ctx.dir, 'companies.csv')
    writeFileSync(csvPath, companyCsv)
    ctx.runOK('import', 'companies', csvPath)

    // Verify import
    const companies = ctx.runJSON<Array<{ name: string }>>(
      'company',
      'list',
      '--format',
      'json',
    )
    expect(companies).toHaveLength(5)

    // ── Import contacts from CSV ──
    const contactCsv = `name,email,company,tags,title,source
Dr. Lisa Chen,lisa@medvault.io,MedVault,decision-maker,CTO,conference
Raj Gupta,raj@finledger.com,FinLedger,decision-maker,VP Engineering,cold-outreach
Amy Torres,amy@shopstream.co,ShopStream,champion,Product Lead,referral
Jake Morrison,jake@paycircle.io,PayCircle,decision-maker,CTO,inbound
Nina Patel,nina@healthbridge.org,HealthBridge,"champion,technical",Lead Architect,referral`

    const contactCsvPath = join(ctx.dir, 'contacts.csv')
    writeFileSync(contactCsvPath, contactCsv)
    ctx.runOK('import', 'contacts', contactCsvPath)

    const contacts = ctx.runJSON<Array<{ name: string }>>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(contacts).toHaveLength(5)

    // ── Create deals with multiple contacts per deal ──
    // MedVault: needs a second contact (procurement)
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'David Park',
      '--email',
      'david@medvault.io',
      '--company',
      'MedVault',
      '--set',
      'title=Head of Procurement',
    )

    const dealMed = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'MedVault Patient Portal',
        '--value',
        '120000',
        '--contact',
        'lisa@medvault.io',
        '--contact',
        'david@medvault.io',
        '--company',
        'medvault.io',
        '--tag',
        'healthcare',
        '--tag',
        'q2',
        '--expected-close',
        '2026-07-01',
        '--probability',
        '25',
        '--set',
        'tech_stack=React/Node',
        '--set',
        'timeline=6 months',
      )
      .trim()

    const dealFin = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'FinLedger Trading Dashboard',
        '--value',
        '85000',
        '--contact',
        'raj@finledger.com',
        '--company',
        'finledger.com',
        '--tag',
        'fintech',
        '--tag',
        'q2',
        '--expected-close',
        '2026-06-15',
        '--probability',
        '40',
        '--set',
        'tech_stack=React/Python',
        '--set',
        'timeline=4 months',
      )
      .trim()

    const dealShop = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'ShopStream Mobile App',
        '--value',
        '45000',
        '--contact',
        'amy@shopstream.co',
        '--company',
        'shopstream.co',
        '--tag',
        'ecommerce',
        '--expected-close',
        '2026-05-20',
        '--probability',
        '60',
        '--set',
        'tech_stack=React Native',
        '--set',
        'timeline=3 months',
      )
      .trim()

    ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'PayCircle API Rebuild',
        '--value',
        '200000',
        '--contact',
        'jake@paycircle.io',
        '--company',
        'paycircle.io',
        '--tag',
        'fintech',
        '--tag',
        'enterprise',
        '--expected-close',
        '2026-09-01',
        '--probability',
        '15',
        '--set',
        'tech_stack=Go/gRPC',
        '--set',
        'timeline=8 months',
      )
      .trim()

    // ── Move deals through stages with activities ──
    ctx.runOK(
      'deal',
      'move',
      dealShop,
      '--stage',
      'qualified',
      '--note',
      'Amy confirmed budget',
    )
    ctx.runOK(
      'deal',
      'move',
      dealShop,
      '--stage',
      'proposal',
      '--note',
      'Sent SOW',
    )
    ctx.runOK(
      'deal',
      'move',
      dealShop,
      '--stage',
      'negotiation',
      '--note',
      'Negotiating timeline',
    )
    ctx.runOK(
      'deal',
      'move',
      dealShop,
      '--stage',
      'closed-won',
      '--note',
      'Signed! Starting May 1',
    )

    ctx.runOK('deal', 'move', dealFin, '--stage', 'qualified')
    ctx.runOK('deal', 'move', dealFin, '--stage', 'proposal')

    ctx.runOK(
      'deal',
      'move',
      dealMed,
      '--stage',
      'qualified',
      '--note',
      'Lisa got internal approval',
    )

    // Log multi-contact activity
    ctx.runOK(
      'log',
      'meeting',
      'Stakeholder alignment call',
      '--contact',
      'lisa@medvault.io',
      '--contact',
      'david@medvault.io',
      '--deal',
      dealMed,
      '--set',
      'duration=60m',
      '--set',
      'outcome=positive',
    )

    // ── Filtering by vertical (tag) ──
    const fintechDeals = ctx.runJSON<Array<{ title: string }>>(
      'deal',
      'list',
      '--tag',
      'fintech',
      '--format',
      'json',
    )
    expect(fintechDeals).toHaveLength(2) // FinLedger + PayCircle

    const healthcareDeals = ctx.runJSON<Array<{ title: string }>>(
      'deal',
      'list',
      '--tag',
      'healthcare',
      '--format',
      'json',
    )
    expect(healthcareDeals).toHaveLength(1) // MedVault

    // ── Filter by company ──
    const medvaultDeals = ctx.runJSON<Array<{ title: string }>>(
      'deal',
      'list',
      '--company',
      'medvault.io',
      '--format',
      'json',
    )
    expect(medvaultDeals).toHaveLength(1)

    // ── Filter by custom field ──
    const reactDeals = ctx.runJSON<Array<{ title: string }>>(
      'deal',
      'list',
      '--filter',
      'tech_stack~=React',
      '--format',
      'json',
    )
    expect(reactDeals).toHaveLength(3) // MedVault, FinLedger, ShopStream

    // ── Pipeline value by stage ──
    const pipeline = ctx.runJSON<
      Array<{ stage: string; count: number; value: number }>
    >('pipeline', '--format', 'json')
    const proposalStage = pipeline.find((s) => s.stage === 'proposal')
    expect(proposalStage?.count).toBe(1) // FinLedger
    expect(proposalStage?.value).toBe(85_000)

    const wonStage = pipeline.find((s) => s.stage === 'closed-won')
    expect(wonStage?.count).toBe(1)
    expect(wonStage?.value).toBe(45_000) // ShopStream

    // ── Big deals filter ──
    const bigDeals = ctx.runJSON<Array<{ title: string }>>(
      'deal',
      'list',
      '--min-value',
      '100000',
      '--format',
      'json',
    )
    expect(bigDeals).toHaveLength(2) // MedVault 120k, PayCircle 200k

    // ── Verify deal show includes multiple contacts ──
    const dealDetail = ctx.runJSON<{ contacts: Array<{ name: string }> }>(
      'deal',
      'show',
      dealMed,
      '--format',
      'json',
    )
    expect(dealDetail.contacts).toHaveLength(2)
    const contactNames = dealDetail.contacts.map((c) => c.name).sort()
    expect(contactNames).toEqual(['David Park', 'Dr. Lisa Chen'])

    // ── Tag list shows vertical distribution ──
    const tags = ctx.runJSON<Array<{ tag: string; count: number }>>(
      'tag',
      'list',
      '--format',
      'json',
    )
    const fintechTag = tags.find((t) => t.tag === 'fintech')
    expect(fintechTag!.count).toBeGreaterThanOrEqual(3) // 2 companies + 2 deals
  })
})
