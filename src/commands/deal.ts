import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import { removeSearchIndex, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { applyFilter, parseFilter } from '../filter'
import { dealToRow, formatOutput, safeJSON } from '../format'
import { runHook } from '../hooks'
import {
  buildDealSearch,
  collect,
  confirmOrForce,
  dealDetail,
  die,
  getCtx,
  getOrCreateCompanyId,
  getOrCreateContactId,
  makeId,
  now,
  parseKV,
  showEntity,
} from '../lib/helpers'
import {
  resolveCompany,
  resolveCompanyForLink,
  resolveContact,
  resolveDeal,
} from '../resolve'

export function registerDealCommands(program: Command) {
  const cmd = program.command('deal').description('Manage deals')

  cmd
    .command('add')
    .requiredOption('--title <title>', 'Deal title')
    .option('--value <n>', 'Deal value')
    .option('--stage <stage>', 'Pipeline stage')
    .option('--contact <ref>', 'Contact', collect, [])
    .option('--company <ref>', 'Company')
    .option('--expected-close <date>', 'Expected close date')
    .option('--probability <n>', 'Win probability 0-100')
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (opts) => {
      const { db, config } = await getCtx()
      opts.title = opts.title.trim()
      opts.contact = opts.contact.map((c: string) => c.trim())
      opts.tag = opts.tag.map((t: string) => t.trim())
      if (opts.company) {
        opts.company = opts.company.trim()
      }
      if (opts.stage) {
        opts.stage = opts.stage.trim()
      }
      const id = makeId('dl')
      const n = now()
      if (opts.value !== undefined && Number(opts.value) < 0) {
        die('Error: value must be non-negative')
      }
      if (opts.probability !== undefined) {
        const prob = Number(opts.probability)
        if (prob < 0 || prob > 100) {
          die('Error: probability must be between 0 and 100')
        }
      }
      if (opts.expectedClose) {
        const d = new Date(opts.expectedClose)
        if (Number.isNaN(d.getTime())) {
          die('Error: invalid expected-close date')
        }
      }
      const stage = opts.stage || config.pipeline.stages[0]
      if (!config.pipeline.stages.includes(stage)) {
        die(`Error: invalid stage "${stage}"`)
      }
      const contactIds: string[] = []
      for (const ref of opts.contact) {
        const ctId = await getOrCreateContactId(db, ref, config)
        if (!contactIds.includes(ctId)) {
          contactIds.push(ctId)
        }
      }
      let companyId: string | null = null
      if (opts.company) {
        const co = await resolveCompanyForLink(db, opts.company, config)
        if (co) {
          companyId = co.id
        } else {
          // Auto-create only for plain names (no dots suggesting domain)
          if (opts.company.includes('.')) {
            die(`Error: company not found: ${opts.company}`)
          }
          companyId = await getOrCreateCompanyId(db, opts.company, config)
        }
      }
      const custom = parseKV(opts.set)
      const value = opts.value === undefined ? null : Number(opts.value)
      const probability =
        opts.probability === undefined ? null : Number(opts.probability)
      if (
        !runHook(config, 'pre-deal-add', {
          title: opts.title,
          value,
          stage,
          contacts: contactIds,
          company: companyId,
          expected_close: opts.expectedClose || null,
          probability,
          tags: opts.tag,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-deal-add hook rejected creation')
      }
      await db.insert(schema.deals).values({
        id,
        title: opts.title,
        value,
        stage,
        contacts: JSON.stringify(contactIds),
        company: companyId,
        expected_close: opts.expectedClose || null,
        probability,
        tags: JSON.stringify(opts.tag),
        custom_fields: JSON.stringify(custom),
        created_at: n,
        updated_at: n,
      })
      const results = await db
        .select()
        .from(schema.deals)
        .where(eq(schema.deals.id, id))
      const row = results[0]
      await upsertSearchIndex(db, 'deal', id, buildDealSearch(row))
      runHook(config, 'post-deal-add', {
        id,
        title: opts.title,
        value,
        stage,
        contacts: contactIds,
        company: companyId,
        expected_close: opts.expectedClose || null,
        probability,
        tags: opts.tag,
        custom_fields: custom,
      })
      console.log(id)
    })

  cmd
    .command('list')
    .option('--stage <stage>')
    .option('--min-value <n>')
    .option('--max-value <n>')
    .option('--contact <ref>')
    .option('--company <ref>')
    .option('--tag <tag>')
    .option('--filter <expr>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let rows = (await db.select().from(schema.deals)).map((d) =>
        dealToRow(d, config),
      )
      if (opts.stage) {
        rows = rows.filter((d) => d.stage === opts.stage)
      }
      if (opts.minValue) {
        rows = rows.filter(
          (d) => ((d.value as number) ?? 0) >= Number(opts.minValue),
        )
      }
      if (opts.maxValue) {
        rows = rows.filter(
          (d) => ((d.value as number) ?? 0) <= Number(opts.maxValue),
        )
      }
      if (opts.contact) {
        const ct = await resolveContact(db, opts.contact, config)
        if (ct) {
          rows = rows.filter((d) =>
            (d.contacts as string[] | undefined)?.includes(ct.id),
          )
        } else {
          rows = []
        }
      }
      if (opts.company) {
        const co = await resolveCompany(db, opts.company, config)
        if (co) {
          rows = rows.filter((d) => d.company === co.id)
        } else {
          rows = []
        }
      }
      if (opts.tag) {
        rows = rows.filter((d) =>
          (d.tags as string[] | undefined)?.includes(opts.tag),
        )
      }
      if (opts.filter) {
        const f = parseFilter(opts.filter)
        rows = rows.filter((d) => applyFilter(d, f))
      }
      if (opts.sort) {
        rows.sort((a, b) => {
          const av = a[opts.sort],
            bv = b[opts.sort]
          if (typeof av === 'number' && typeof bv === 'number') {
            return av - bv
          }
          return String(av ?? '').localeCompare(String(bv ?? ''))
        })
      }
      if (opts.reverse) {
        rows.reverse()
      }
      if (opts.offset) {
        rows = rows.slice(Number(opts.offset))
      }
      if (opts.limit) {
        rows = rows.slice(0, Number(opts.limit))
      }
      console.log(formatOutput(rows, fmt, config))
    })

  cmd
    .command('show')
    .argument('<ref>')
    .action(async (ref) => {
      const { db, config, fmt } = await getCtx()
      const d = await resolveDeal(db, ref)
      if (!d) {
        die(`Error: deal not found: ${ref}`)
      }
      showEntity(await dealDetail(db, d, config), fmt)
    })

  cmd
    .command('edit')
    .argument('<ref>')
    .option('--title <title>')
    .option('--value <n>')
    .option('--company <ref>', 'Change linked company')
    .option('--expected-close <date>', 'Expected close date (YYYY-MM-DD)')
    .option('--probability <n>', 'Win probability 0-100')
    .option('--add-contact <ref>', '', collect, [])
    .option('--rm-contact <ref>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action(async (ref, opts) => {
      const { db, config } = await getCtx()
      if (opts.title) {
        opts.title = opts.title.trim()
      }
      if (opts.company) {
        opts.company = opts.company.trim()
      }
      opts.addContact = opts.addContact.map((c: string) => c.trim())
      opts.rmContact = opts.rmContact.map((c: string) => c.trim())
      opts.addTag = opts.addTag.map((t: string) => t.trim())
      opts.rmTag = opts.rmTag.map((t: string) => t.trim())
      const d = await resolveDeal(db, ref.trim())
      if (!d) {
        die(`Error: deal not found: ${ref}`)
      }
      const title = opts.title ?? d.title
      const value = opts.value === undefined ? d.value : Number(opts.value)
      const expectedClose = opts.expectedClose ?? d.expected_close
      const probability =
        opts.probability === undefined
          ? d.probability
          : Number(opts.probability)
      let companyId = d.company
      if (opts.company) {
        companyId = await getOrCreateCompanyId(db, opts.company, config)
      }
      let contacts: string[] = safeJSON(d.contacts)
      let tags: string[] = safeJSON(d.tags)
      const custom: Record<string, unknown> = safeJSON(d.custom_fields)
      for (const r of opts.addContact) {
        const ctId = await getOrCreateContactId(db, r, config)
        if (!contacts.includes(ctId)) {
          contacts.push(ctId)
        }
      }
      for (const r of opts.rmContact) {
        const ct = await resolveContact(db, r, config)
        if (ct) {
          contacts = contacts.filter((id) => id !== ct.id)
        }
      }
      for (const t of opts.addTag) {
        if (!tags.includes(t)) {
          tags.push(t)
        }
      }
      for (const t of opts.rmTag) {
        tags = tags.filter((v) => v !== t)
      }
      const kvs = parseKV(opts.set)
      for (const [k, v] of Object.entries(kvs)) {
        custom[k] = v
      }
      for (const k of opts.unset) {
        delete custom[k]
      }
      if (
        !runHook(config, 'pre-deal-edit', {
          id: d.id,
          title,
          value,
          contacts,
          tags,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-deal-edit hook rejected edit')
      }
      await db
        .update(schema.deals)
        .set({
          title,
          value,
          company: companyId,
          expected_close: expectedClose,
          probability,
          contacts: JSON.stringify(contacts),
          tags: JSON.stringify(tags),
          custom_fields: JSON.stringify(custom),
          updated_at: now(),
        })
        .where(eq(schema.deals.id, d.id))
      const results = await db
        .select()
        .from(schema.deals)
        .where(eq(schema.deals.id, d.id))
      const row = results[0]
      await upsertSearchIndex(db, 'deal', d.id, buildDealSearch(row))
      console.log(d.id)
      runHook(config, 'post-deal-edit', {
        id: d.id,
        title,
        value,
        contacts,
        tags,
        custom_fields: custom,
      })
    })

  cmd
    .command('move')
    .argument('<ref>')
    .requiredOption('--stage <stage>', 'Target stage')
    .option('--note <text>', 'Note')
    .action(async (ref, opts) => {
      const { db, config } = await getCtx()
      const d = await resolveDeal(db, ref)
      if (!d) {
        die(`Error: deal not found: ${ref}`)
      }
      if (!config.pipeline.stages.includes(opts.stage)) {
        die(`Error: invalid stage "${opts.stage}"`)
      }
      if (d.stage === opts.stage) {
        die(`Error: deal is already in stage "${opts.stage}"`)
      }
      const oldStage = d.stage
      if (
        !runHook(config, 'pre-deal-stage-change', {
          deal: d.id,
          from: oldStage,
          to: opts.stage,
          note: opts.note,
        })
      ) {
        die('Error: pre-deal-stage-change hook rejected stage move')
      }
      const n = now()
      await db
        .update(schema.deals)
        .set({ stage: opts.stage, updated_at: n })
        .where(eq(schema.deals.id, d.id))
      let body = `from ${oldStage} to ${opts.stage}`
      if (opts.note) {
        body += ` | ${opts.note}`
      }
      const aid = makeId('ac')
      await db.insert(schema.activities).values({
        id: aid,
        type: 'stage-change',
        body,
        deal: d.id,
        created_at: n,
      })
      await upsertSearchIndex(db, 'activity', aid, `stage-change ${body}`)
      console.log(d.id)
      runHook(config, 'post-deal-stage-change', {
        deal: d.id,
        from: oldStage,
        to: opts.stage,
        note: opts.note,
      })
    })

  cmd
    .command('rm')
    .argument('<ref>')
    .option('--force', 'Skip confirmation')
    .action(async (ref, opts) => {
      const { db, config } = await getCtx()
      const d = await resolveDeal(db, ref)
      if (!d) {
        die(`Error: deal not found: ${ref}`)
      }
      confirmOrForce(opts.force, `deal "${d.title}" (${d.id})`)
      if (
        !runHook(config, 'pre-deal-rm', {
          id: d.id,
          title: d.title,
        })
      ) {
        die('Error: pre-deal-rm hook rejected deletion')
      }
      await db.delete(schema.activities).where(eq(schema.activities.deal, d.id))
      await db.delete(schema.deals).where(eq(schema.deals.id, d.id))
      await removeSearchIndex(db, d.id)
      runHook(config, 'post-deal-rm', {
        id: d.id,
        title: d.title,
      })
    })
}

export function registerPipelineCommand(program: Command) {
  program
    .command('pipeline')
    .description('Pipeline summary')
    .action(async () => {
      const { db, config, fmt } = await getCtx()
      const deals = await db.select().from(schema.deals)
      const summary = config.pipeline.stages.map((stage) => ({
        stage,
        count: deals.filter((d) => d.stage === stage).length,
        value: deals
          .filter((d) => d.stage === stage)
          .reduce((s, d) => s + (d.value || 0), 0),
      }))
      const total = {
        stage: 'Total',
        count: deals.length,
        value: deals.reduce((s, d) => s + (d.value || 0), 0),
      }
      const data = [...summary, total]
      if (fmt === 'json') {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.log(formatOutput(data, fmt, config))
      }
    })
}
