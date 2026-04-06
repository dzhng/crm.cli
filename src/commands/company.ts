import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import { removeSearchIndex, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { applyFilter, parseFilter } from '../filter'
import { companyToRow, formatOutput, safeJSON } from '../format'
import { runHook } from '../hooks'
import {
  buildCompanySearch,
  checkDupePhone,
  checkDupeWebsite,
  collect,
  companyDetail,
  confirmOrForce,
  die,
  getCtx,
  makeId,
  now,
  parseKV,
  showEntity,
} from '../lib/helpers'
import {
  normalizePhone,
  normalizeWebsite,
  tryNormalizePhone,
} from '../normalize'
import { resolveCompany } from '../resolve'

export function registerCompanyCommands(program: Command) {
  const cmd = program.command('company').description('Manage companies')

  cmd
    .command('add')
    .requiredOption('--name <name>', 'Company name')
    .option('--website <url>', 'Website', collect, [])
    .option('--phone <phone>', 'Phone', collect, [])
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (opts) => {
      const { db, config } = await getCtx()
      opts.name = opts.name.trim()
      opts.website = opts.website.map((w: string) => w.trim())
      opts.phone = opts.phone.map((p: string) => p.trim())
      opts.tag = opts.tag.map((t: string) => t.trim())
      const cid = makeId('co')
      const n = now()
      const websites: string[] = []
      for (const w of opts.website) {
        const norm = normalizeWebsite(w)
        await checkDupeWebsite(db, norm)
        websites.push(norm)
      }
      const phones: string[] = []
      for (const p of opts.phone) {
        try {
          const norm = normalizePhone(p, config.phone.default_country)
          await checkDupePhone(db, norm, 'companies')
          phones.push(norm)
        } catch (e: unknown) {
          die(`Error: invalid phone — ${(e as Error).message}`)
        }
      }
      const custom = parseKV(opts.set)
      if (
        !runHook(config, 'pre-company-add', {
          name: opts.name,
          websites,
          phones,
          tags: opts.tag,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-company-add hook rejected creation')
      }
      await db.insert(schema.companies).values({
        id: cid,
        name: opts.name,
        websites: JSON.stringify(websites),
        phones: JSON.stringify(phones),
        tags: JSON.stringify(opts.tag),
        custom_fields: JSON.stringify(custom),
        created_at: n,
        updated_at: n,
      })
      const results = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, cid))
      const row = results[0]
      await upsertSearchIndex(db, 'company', cid, buildCompanySearch(row))
      runHook(config, 'post-company-add', {
        id: cid,
        name: opts.name,
        websites,
        phones,
        tags: opts.tag,
        custom_fields: custom,
      })
      console.log(cid)
    })

  cmd
    .command('list')
    .option('--tag <tag>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .option('--filter <expr>')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let rows = (await db.select().from(schema.companies)).map((c) =>
        companyToRow(c),
      )
      if (opts.filter) {
        const f = parseFilter(opts.filter)
        rows = rows.filter((c) => applyFilter(c, f))
      }
      if (opts.tag) {
        rows = rows.filter((c) =>
          (c.tags as string[] | undefined)?.includes(opts.tag),
        )
      }
      if (opts.sort) {
        rows.sort((a, b) =>
          String(a[opts.sort] ?? '').localeCompare(String(b[opts.sort] ?? '')),
        )
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
      const co = await resolveCompany(db, ref, config)
      if (!co) {
        die(`Error: company not found: ${ref}`)
      }
      showEntity(await companyDetail(db, co, config), fmt)
    })

  cmd
    .command('edit')
    .argument('<ref>')
    .option('--name <name>')
    .option('--add-website <url>', '', collect, [])
    .option('--rm-website <url>', '', collect, [])
    .option('--add-phone <p>', '', collect, [])
    .option('--rm-phone <p>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action(async (ref, opts) => {
      const { db, config } = await getCtx()
      if (opts.name) {
        opts.name = opts.name.trim()
      }
      opts.addWebsite = opts.addWebsite.map((w: string) => w.trim())
      opts.rmWebsite = opts.rmWebsite.map((w: string) => w.trim())
      opts.addPhone = opts.addPhone.map((p: string) => p.trim())
      opts.rmPhone = opts.rmPhone.map((p: string) => p.trim())
      opts.addTag = opts.addTag.map((t: string) => t.trim())
      opts.rmTag = opts.rmTag.map((t: string) => t.trim())
      const co = await resolveCompany(db, ref.trim(), config)
      if (!co) {
        die(`Error: company not found: ${ref}`)
      }
      let websites: string[] = safeJSON(co.websites)
      let phones: string[] = safeJSON(co.phones)
      let tags: string[] = safeJSON(co.tags)
      const custom: Record<string, unknown> = safeJSON(co.custom_fields)
      let name = co.name
      if (opts.name) {
        name = opts.name
      }
      for (const w of opts.addWebsite) {
        const norm = normalizeWebsite(w)
        if (!websites.includes(norm)) {
          await checkDupeWebsite(db, norm, co.id)
          websites.push(norm)
        }
      }
      for (const w of opts.rmWebsite) {
        const norm = normalizeWebsite(w)
        websites = websites.filter((v) => v !== norm)
      }
      for (const p of opts.addPhone) {
        const norm = normalizePhone(p, config.phone.default_country)
        if (!phones.includes(norm)) {
          await checkDupePhone(db, norm, 'companies', co.id)
          phones.push(norm)
        }
      }
      for (const p of opts.rmPhone) {
        const norm = tryNormalizePhone(p, config.phone.default_country)
        phones = norm
          ? phones.filter((v) => v !== norm)
          : phones.filter((v) => v !== p)
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
        !runHook(config, 'pre-company-edit', {
          id: co.id,
          name,
          websites,
          phones,
          tags,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-company-edit hook rejected edit')
      }
      await db
        .update(schema.companies)
        .set({
          name,
          websites: JSON.stringify(websites),
          phones: JSON.stringify(phones),
          tags: JSON.stringify(tags),
          custom_fields: JSON.stringify(custom),
          updated_at: now(),
        })
        .where(eq(schema.companies.id, co.id))
      const results = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, co.id))
      const row = results[0]
      await upsertSearchIndex(db, 'company', co.id, buildCompanySearch(row))
      console.log(co.id)
      runHook(config, 'post-company-edit', {
        id: co.id,
        name,
        websites,
        phones,
        tags,
        custom_fields: custom,
      })
    })

  cmd
    .command('rm')
    .argument('<ref>')
    .option('--force', 'Skip confirmation')
    .action(async (ref, opts) => {
      const { db, config } = await getCtx()
      const co = await resolveCompany(db, ref, config)
      if (!co) {
        die(`Error: company not found: ${ref}`)
      }
      confirmOrForce(opts.force, `company "${co.name}" (${co.id})`)
      if (!runHook(config, 'pre-company-rm', { id: co.id, name: co.name })) {
        die('Error: pre-company-rm hook rejected deletion')
      }
      // Unlink from contacts
      const allContacts = await db.select().from(schema.contacts)
      for (const ct of allContacts) {
        const companies: string[] = safeJSON(ct.companies)
        if (companies.includes(co.id)) {
          await db
            .update(schema.contacts)
            .set({
              companies: JSON.stringify(companies.filter((n) => n !== co.id)),
            })
            .where(eq(schema.contacts.id, ct.id))
        }
      }
      // Set deals company to null
      await db
        .update(schema.deals)
        .set({ company: null })
        .where(eq(schema.deals.company, co.id))
      await db.delete(schema.companies).where(eq(schema.companies.id, co.id))
      await removeSearchIndex(db, co.id)
      runHook(config, 'post-company-rm', { id: co.id, name: co.name })
    })

  cmd
    .command('merge')
    .argument('<id1>')
    .argument('<id2>')
    .action(async (id1, id2) => {
      const { db, config } = await getCtx()
      const c1 = await resolveCompany(db, id1, config),
        c2 = await resolveCompany(db, id2, config)
      if (!(c1 && c2)) {
        die('Error: one or both companies not found')
      }
      const mergedWebsites = [
        ...new Set([...safeJSON(c1.websites), ...safeJSON(c2.websites)]),
      ]
      const mergedPhones = [
        ...new Set([...safeJSON(c1.phones), ...safeJSON(c2.phones)]),
      ]
      const mergedTags = [
        ...new Set([...safeJSON(c1.tags), ...safeJSON(c2.tags)]),
      ]
      const mergedCustom = {
        ...safeJSON(c2.custom_fields),
        ...safeJSON(c1.custom_fields),
      }
      await db
        .update(schema.companies)
        .set({
          websites: JSON.stringify(mergedWebsites),
          phones: JSON.stringify(mergedPhones),
          tags: JSON.stringify(mergedTags),
          custom_fields: JSON.stringify(mergedCustom),
          updated_at: now(),
        })
        .where(eq(schema.companies.id, c1.id))
      // Relink contacts
      const allContacts = await db.select().from(schema.contacts)
      for (const ct of allContacts) {
        const companies: string[] = safeJSON(ct.companies)
        if (companies.includes(c2.id)) {
          const updated = [
            ...new Set(companies.map((n) => (n === c2.id ? c1.id : n))),
          ]
          await db
            .update(schema.contacts)
            .set({ companies: JSON.stringify(updated) })
            .where(eq(schema.contacts.id, ct.id))
        }
      }
      // Relink deals
      await db
        .update(schema.deals)
        .set({ company: c1.id })
        .where(eq(schema.deals.company, c2.id))
      // Transfer activities
      await db
        .update(schema.activities)
        .set({ company: c1.id })
        .where(eq(schema.activities.company, c2.id))
      await db.delete(schema.companies).where(eq(schema.companies.id, c2.id))
      await removeSearchIndex(db, c2.id)
      const results = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, c1.id))
      const row = results[0]
      await upsertSearchIndex(db, 'company', c1.id, buildCompanySearch(row))
      console.log(c1.id)
    })
}
