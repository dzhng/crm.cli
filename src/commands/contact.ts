import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import { removeSearchIndex, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { applyFilter, parseFilter } from '../filter'
import { contactToRow, formatOutput, safeJSON } from '../format'
import { runHook } from '../hooks'
import {
  buildContactSearch,
  checkDupeEmail,
  checkDupePhone,
  checkDupeSocial,
  collect,
  confirmOrForce,
  contactDetail,
  die,
  getCtx,
  getOrCreateCompanyId,
  makeId,
  now,
  parseKV,
  showEntity,
  validateEmail,
} from '../lib/helpers'
import {
  normalizePhone,
  normalizeSocialHandle,
  tryNormalizePhone,
} from '../normalize'
import { resolveCompany, resolveContact } from '../resolve'

export function registerContactCommands(program: Command) {
  const cmd = program.command('contact').description('Manage contacts')

  cmd
    .command('add')
    .requiredOption('--name <name>', 'Contact name')
    .option('--email <email>', 'Email', collect, [])
    .option('--phone <phone>', 'Phone', collect, [])
    .option('--company <company>', 'Company', collect, [])
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--linkedin <h>', 'LinkedIn')
    .option('--x <h>', 'X/Twitter')
    .option('--bluesky <h>', 'Bluesky')
    .option('--telegram <h>', 'Telegram')
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (opts) => {
      const { db, config } = await getCtx()
      opts.name = opts.name.trim()
      opts.email = opts.email.map((e: string) => e.trim())
      opts.phone = opts.phone.map((p: string) => p.trim())
      opts.company = opts.company.map((c: string) => c.trim())
      opts.tag = opts.tag.map((t: string) => t.trim())
      const cid = makeId('ct')
      const n = now()
      for (const e of opts.email) {
        validateEmail(e)
        await checkDupeEmail(db, e)
      }
      const phones: string[] = []
      for (const p of opts.phone) {
        try {
          const norm = normalizePhone(p, config.phone.default_country)
          await checkDupePhone(db, norm, 'contacts')
          phones.push(norm)
        } catch (e: unknown) {
          die(`Error: invalid phone — ${(e as Error).message}`)
        }
      }
      const linkedin = opts.linkedin
        ? normalizeSocialHandle('linkedin', opts.linkedin.trim())
        : null
      const x = opts.x ? normalizeSocialHandle('x', opts.x.trim()) : null
      const bluesky = opts.bluesky
        ? normalizeSocialHandle('bluesky', opts.bluesky.trim())
        : null
      const telegram = opts.telegram
        ? normalizeSocialHandle('telegram', opts.telegram.trim())
        : null
      if (linkedin) {
        await checkDupeSocial(db, 'linkedin', linkedin)
      }
      if (x) {
        await checkDupeSocial(db, 'x', x)
      }
      if (bluesky) {
        await checkDupeSocial(db, 'bluesky', bluesky)
      }
      if (telegram) {
        await checkDupeSocial(db, 'telegram', telegram)
      }
      const companies: string[] = []
      for (const c of opts.company) {
        companies.push(await getOrCreateCompanyId(db, c))
      }
      const custom = parseKV(opts.set)
      if (
        !runHook(config, 'pre-contact-add', {
          name: opts.name,
          emails: opts.email,
          phones,
          companies,
          linkedin,
          x,
          bluesky,
          telegram,
          tags: opts.tag,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-contact-add hook rejected creation')
      }
      await db.insert(schema.contacts).values({
        id: cid,
        name: opts.name,
        emails: JSON.stringify(opts.email),
        phones: JSON.stringify(phones),
        companies: JSON.stringify(companies),
        linkedin,
        x,
        bluesky,
        telegram,
        tags: JSON.stringify(opts.tag),
        custom_fields: JSON.stringify(custom),
        created_at: n,
        updated_at: n,
      })
      const results = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, cid))
      const row = results[0]
      await upsertSearchIndex(
        db,
        'contact',
        cid,
        await buildContactSearch(db, row),
      )
      runHook(config, 'post-contact-add', {
        id: cid,
        name: opts.name,
        emails: opts.email,
        phones,
        companies,
        linkedin,
        x,
        bluesky,
        telegram,
        tags: opts.tag,
        custom_fields: custom,
      })
      console.log(cid)
    })

  cmd
    .command('list')
    .option('--tag <tag>')
    .option('--company <company>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .option('--filter <expr>')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let rows = (await db.select().from(schema.contacts)).map((c) =>
        contactToRow(c),
      )
      if (opts.tag) {
        rows = rows.filter((c) =>
          (c.tags as string[] | undefined)?.includes(opts.tag),
        )
      }
      if (opts.company) {
        const co = await resolveCompany(db, opts.company, config)
        if (co) {
          rows = rows.filter((c) =>
            (c.companies as string[] | undefined)?.includes(co.id),
          )
        } else {
          rows = []
        }
      }
      if (opts.filter) {
        const f = parseFilter(opts.filter)
        rows = rows.filter((c) => applyFilter(c, f))
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
      const c = await resolveContact(db, ref, config)
      if (!c) {
        die(`Error: contact not found: ${ref}`)
      }
      showEntity(await contactDetail(db, c, config), fmt)
    })

  cmd
    .command('edit')
    .argument('<ref>')
    .option('--name <name>')
    .option('--add-email <e>', '', collect, [])
    .option('--rm-email <e>', '', collect, [])
    .option('--add-phone <p>', '', collect, [])
    .option('--rm-phone <p>', '', collect, [])
    .option('--add-company <c>', '', collect, [])
    .option('--rm-company <c>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--linkedin <h>')
    .option('--x <h>')
    .option('--bluesky <h>')
    .option('--telegram <h>')
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action(async (ref, opts) => {
      const { db, config } = await getCtx()
      if (opts.name) {
        opts.name = opts.name.trim()
      }
      opts.addEmail = opts.addEmail.map((e: string) => e.trim())
      opts.rmEmail = opts.rmEmail.map((e: string) => e.trim())
      opts.addPhone = opts.addPhone.map((p: string) => p.trim())
      opts.rmPhone = opts.rmPhone.map((p: string) => p.trim())
      opts.addCompany = opts.addCompany.map((c: string) => c.trim())
      opts.rmCompany = opts.rmCompany.map((c: string) => c.trim())
      opts.addTag = opts.addTag.map((t: string) => t.trim())
      opts.rmTag = opts.rmTag.map((t: string) => t.trim())
      const c = await resolveContact(db, ref.trim(), config)
      if (!c) {
        die(`Error: contact not found: ${ref}`)
      }
      let emails: string[] = safeJSON(c.emails)
      let phones: string[] = safeJSON(c.phones)
      let companies: string[] = safeJSON(c.companies)
      let tags: string[] = safeJSON(c.tags)
      const custom: Record<string, unknown> = safeJSON(c.custom_fields)
      let name = c.name,
        linkedin = c.linkedin,
        x = c.x,
        bluesky = c.bluesky,
        telegram = c.telegram
      if (opts.name) {
        name = opts.name
      }
      for (const e of opts.addEmail) {
        validateEmail(e)
        await checkDupeEmail(db, e, c.id)
        if (!emails.includes(e)) {
          emails.push(e)
        }
      }
      for (const e of opts.rmEmail) {
        emails = emails.filter((v) => v !== e)
      }
      for (const p of opts.addPhone) {
        const norm = normalizePhone(p, config.phone.default_country)
        if (!phones.includes(norm)) {
          await checkDupePhone(db, norm, 'contacts', c.id)
          phones.push(norm)
        }
      }
      for (const p of opts.rmPhone) {
        const norm = tryNormalizePhone(p, config.phone.default_country)
        phones = norm
          ? phones.filter((v) => v !== norm)
          : phones.filter((v) => v !== p)
      }
      for (const co of opts.addCompany) {
        const coId = await getOrCreateCompanyId(db, co)
        if (!companies.includes(coId)) {
          companies.push(coId)
        }
      }
      for (const co of opts.rmCompany) {
        const resolved = await resolveCompany(db, co, config)
        if (resolved) {
          companies = companies.filter((v) => v !== resolved.id)
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
      if (opts.linkedin) {
        linkedin = normalizeSocialHandle('linkedin', opts.linkedin.trim())
        await checkDupeSocial(db, 'linkedin', linkedin, c.id)
      }
      if (opts.x) {
        x = normalizeSocialHandle('x', opts.x.trim())
        await checkDupeSocial(db, 'x', x, c.id)
      }
      if (opts.bluesky) {
        bluesky = normalizeSocialHandle('bluesky', opts.bluesky.trim())
        await checkDupeSocial(db, 'bluesky', bluesky, c.id)
      }
      if (opts.telegram) {
        telegram = normalizeSocialHandle('telegram', opts.telegram.trim())
        await checkDupeSocial(db, 'telegram', telegram, c.id)
      }
      const kvs = parseKV(opts.set)
      for (const [k, v] of Object.entries(kvs)) {
        custom[k] = v
      }
      for (const k of opts.unset) {
        delete custom[k]
        if (k === 'linkedin') {
          linkedin = null
        }
        if (k === 'x') {
          x = null
        }
        if (k === 'bluesky') {
          bluesky = null
        }
        if (k === 'telegram') {
          telegram = null
        }
      }
      if (
        !runHook(config, 'pre-contact-edit', {
          id: c.id,
          name,
          emails,
          phones,
          companies,
          linkedin,
          x,
          bluesky,
          telegram,
          tags,
          custom_fields: custom,
        })
      ) {
        die('Error: pre-contact-edit hook rejected edit')
      }
      await db
        .update(schema.contacts)
        .set({
          name,
          emails: JSON.stringify(emails),
          phones: JSON.stringify(phones),
          companies: JSON.stringify(companies),
          linkedin,
          x,
          bluesky,
          telegram,
          tags: JSON.stringify(tags),
          custom_fields: JSON.stringify(custom),
          updated_at: now(),
        })
        .where(eq(schema.contacts.id, c.id))
      const results = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, c.id))
      const row = results[0]
      await upsertSearchIndex(
        db,
        'contact',
        c.id,
        await buildContactSearch(db, row),
      )
      console.log(c.id)
      runHook(config, 'post-contact-edit', {
        id: c.id,
        name,
        emails,
        phones,
        companies,
        linkedin,
        x,
        bluesky,
        telegram,
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
      const c = await resolveContact(db, ref, config)
      if (!c) {
        die(`Error: contact not found: ${ref}`)
      }
      confirmOrForce(opts.force, `contact "${c.name}" (${c.id})`)
      if (!runHook(config, 'pre-contact-rm', { id: c.id, name: c.name })) {
        die('Error: pre-contact-rm hook rejected deletion')
      }
      const allDeals = await db.select().from(schema.deals)
      for (const d of allDeals) {
        const contacts: string[] = safeJSON(d.contacts)
        if (contacts.includes(c.id)) {
          await db
            .update(schema.deals)
            .set({
              contacts: JSON.stringify(contacts.filter((id) => id !== c.id)),
            })
            .where(eq(schema.deals.id, d.id))
        }
      }
      await db.delete(schema.contacts).where(eq(schema.contacts.id, c.id))
      await removeSearchIndex(db, c.id)
      runHook(config, 'post-contact-rm', { id: c.id, name: c.name })
    })

  cmd
    .command('merge')
    .argument('<id1>')
    .argument('<id2>')
    .action(async (id1, id2) => {
      const { db, config } = await getCtx()
      const c1 = await resolveContact(db, id1, config),
        c2 = await resolveContact(db, id2, config)
      if (!(c1 && c2)) {
        die('Error: one or both contacts not found')
      }
      const mergedEmails = [
        ...new Set([...safeJSON(c1.emails), ...safeJSON(c2.emails)]),
      ]
      const mergedPhones = [
        ...new Set([...safeJSON(c1.phones), ...safeJSON(c2.phones)]),
      ]
      const mergedCompanies = [
        ...new Set([...safeJSON(c1.companies), ...safeJSON(c2.companies)]),
      ]
      const mergedTags = [
        ...new Set([...safeJSON(c1.tags), ...safeJSON(c2.tags)]),
      ]
      const mergedCustom = {
        ...safeJSON(c2.custom_fields),
        ...safeJSON(c1.custom_fields),
      }
      const linkedin = c1.linkedin || c2.linkedin
      const x = c1.x || c2.x
      const bluesky = c1.bluesky || c2.bluesky
      const telegram = c1.telegram || c2.telegram
      // Clear loser's social handles to avoid UNIQUE constraint conflicts, then delete loser first
      await db
        .update(schema.contacts)
        .set({ linkedin: null, x: null, bluesky: null, telegram: null })
        .where(eq(schema.contacts.id, c2.id))
      await db
        .update(schema.contacts)
        .set({
          emails: JSON.stringify(mergedEmails),
          phones: JSON.stringify(mergedPhones),
          companies: JSON.stringify(mergedCompanies),
          tags: JSON.stringify(mergedTags),
          custom_fields: JSON.stringify(mergedCustom),
          linkedin,
          x,
          bluesky,
          telegram,
          updated_at: now(),
        })
        .where(eq(schema.contacts.id, c1.id))
      const allDeals = await db.select().from(schema.deals)
      for (const d of allDeals) {
        const contacts: string[] = safeJSON(d.contacts)
        if (contacts.includes(c2.id)) {
          const updated = [
            ...new Set(contacts.map((id) => (id === c2.id ? c1.id : id))),
          ]
          await db
            .update(schema.deals)
            .set({ contacts: JSON.stringify(updated) })
            .where(eq(schema.deals.id, d.id))
        }
      }
      const allActivities = await db.select().from(schema.activities)
      for (const a of allActivities) {
        const contacts: string[] = safeJSON(a.contacts)
        if (contacts.includes(c2.id)) {
          const updated = [
            ...new Set(contacts.map((id) => (id === c2.id ? c1.id : id))),
          ]
          await db
            .update(schema.activities)
            .set({ contacts: JSON.stringify(updated) })
            .where(eq(schema.activities.id, a.id))
        }
      }
      await db.delete(schema.contacts).where(eq(schema.contacts.id, c2.id))
      await removeSearchIndex(db, c2.id)
      const results = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, c1.id))
      const row = results[0]
      await upsertSearchIndex(
        db,
        'contact',
        c1.id,
        await buildContactSearch(db, row),
      )
      console.log(c1.id)
    })
}
