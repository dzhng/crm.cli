import type { Command } from 'commander'
import { getCtx, makeId, now, die, collect, parseKV, checkDupeEmail, checkDupePhone, checkDupeSocial,
  getOrCreateCompany, buildContactSearch, contactDetail, showEntity } from '../lib/helpers'
import { normalizePhone, tryNormalizePhone, normalizeSocialHandle, formatPhone } from '../normalize'
import { formatOutput, contactToRow, safeJSON } from '../format'
import { resolveContact } from '../resolve'
import { upsertSearchIndex, removeSearchIndex } from '../db'
import { parseFilter, applyFilter } from '../filter'
import { runHook } from '../hooks'

export function registerContactCommands(program: Command) {
  const cmd = program.command('contact').description('Manage contacts')

  cmd.command('add')
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
    .action((opts) => {
      const { db, config } = getCtx()
      const cid = makeId('ct')
      const n = now()
      for (const e of opts.email) checkDupeEmail(db, e)
      const phones: string[] = []
      for (const p of opts.phone) {
        try {
          const norm = normalizePhone(p, config.phone.default_country)
          checkDupePhone(db, norm, 'contacts')
          phones.push(norm)
        } catch (e: any) { die(`Error: invalid phone — ${e.message}`) }
      }
      const linkedin = opts.linkedin ? normalizeSocialHandle('linkedin', opts.linkedin) : null
      const x = opts.x ? normalizeSocialHandle('x', opts.x) : null
      const bluesky = opts.bluesky ? normalizeSocialHandle('bluesky', opts.bluesky) : null
      const telegram = opts.telegram ? normalizeSocialHandle('telegram', opts.telegram) : null
      if (linkedin) checkDupeSocial(db, 'linkedin', linkedin)
      if (x) checkDupeSocial(db, 'x', x)
      if (bluesky) checkDupeSocial(db, 'bluesky', bluesky)
      if (telegram) checkDupeSocial(db, 'telegram', telegram)
      const companies: string[] = []
      for (const c of opts.company) companies.push(getOrCreateCompany(db, c, config))
      const custom = parseKV(opts.set)
      db.run('INSERT INTO contacts (id,name,emails,phones,companies,linkedin,x,bluesky,telegram,tags,custom_fields,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [cid, opts.name, JSON.stringify(opts.email), JSON.stringify(phones), JSON.stringify(companies),
         linkedin, x, bluesky, telegram, JSON.stringify(opts.tag), JSON.stringify(custom), n, n])
      const row = db.query('SELECT * FROM contacts WHERE id = ?').get(cid)
      upsertSearchIndex(db, 'contact', cid, buildContactSearch(row))
      runHook(config, 'post-contact-add', { id: cid, name: opts.name, emails: opts.email, phones, companies, linkedin, x, bluesky, telegram, tags: opts.tag, custom_fields: custom })
      console.log(cid)
    })

  cmd.command('list')
    .option('--tag <tag>')
    .option('--company <company>')
    .option('--sort <field>')
    .option('--limit <n>')
    .option('--offset <n>')
    .option('--filter <expr>')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let rows = (db.query('SELECT * FROM contacts').all() as any[]).map(c => contactToRow(c, config))
      if (opts.tag) rows = rows.filter(c => c.tags.includes(opts.tag))
      if (opts.company) rows = rows.filter(c => c.companies.includes(opts.company))
      if (opts.filter) { const f = parseFilter(opts.filter); rows = rows.filter(c => applyFilter(c, f)) }
      if (opts.sort) rows.sort((a, b) => String(a[opts.sort] ?? '').localeCompare(String(b[opts.sort] ?? '')))
      if (opts.offset) rows = rows.slice(Number(opts.offset))
      if (opts.limit) rows = rows.slice(0, Number(opts.limit))
      console.log(formatOutput(rows, fmt, config))
    })

  cmd.command('show').argument('<ref>').action((ref) => {
    const { db, config, fmt } = getCtx()
    const c = resolveContact(db, ref, config)
    if (!c) die(`Error: contact not found: ${ref}`)
    showEntity(contactDetail(db, c, config), fmt)
  })

  cmd.command('edit').argument('<ref>')
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
    .action((ref, opts) => {
      const { db, config } = getCtx()
      const c = resolveContact(db, ref, config)
      if (!c) die(`Error: contact not found: ${ref}`)
      let emails: string[] = safeJSON(c.emails)
      let phones: string[] = safeJSON(c.phones)
      let companies: string[] = safeJSON(c.companies)
      let tags: string[] = safeJSON(c.tags)
      let custom: Record<string, any> = safeJSON(c.custom_fields)
      let name = c.name, linkedin = c.linkedin, x = c.x, bluesky = c.bluesky, telegram = c.telegram
      if (opts.name) name = opts.name
      for (const e of opts.addEmail) { checkDupeEmail(db, e, c.id); if (!emails.includes(e)) emails.push(e) }
      for (const e of opts.rmEmail) emails = emails.filter(v => v !== e)
      for (const p of opts.addPhone) {
        const norm = normalizePhone(p, config.phone.default_country)
        if (phones.includes(norm)) die(`Error: duplicate phone "${p}" — already on this contact`)
        checkDupePhone(db, norm, 'contacts', c.id)
        phones.push(norm)
      }
      for (const p of opts.rmPhone) {
        const norm = tryNormalizePhone(p, config.phone.default_country)
        phones = norm ? phones.filter(v => v !== norm) : phones.filter(v => v !== p)
      }
      for (const co of opts.addCompany) { const n = getOrCreateCompany(db, co, config); if (!companies.includes(n)) companies.push(n) }
      for (const co of opts.rmCompany) companies = companies.filter(v => v !== co)
      for (const t of opts.addTag) { if (!tags.includes(t)) tags.push(t) }
      for (const t of opts.rmTag) tags = tags.filter(v => v !== t)
      if (opts.linkedin) linkedin = normalizeSocialHandle('linkedin', opts.linkedin)
      if (opts.x) x = normalizeSocialHandle('x', opts.x)
      if (opts.bluesky) bluesky = normalizeSocialHandle('bluesky', opts.bluesky)
      if (opts.telegram) telegram = normalizeSocialHandle('telegram', opts.telegram)
      const kvs = parseKV(opts.set)
      for (const [k, v] of Object.entries(kvs)) custom[k] = v
      for (const k of opts.unset) {
        delete custom[k]
        if (k === 'linkedin') linkedin = null
        if (k === 'x') x = null
        if (k === 'bluesky') bluesky = null
        if (k === 'telegram') telegram = null
      }
      db.run('UPDATE contacts SET name=?,emails=?,phones=?,companies=?,linkedin=?,x=?,bluesky=?,telegram=?,tags=?,custom_fields=?,updated_at=? WHERE id=?',
        [name, JSON.stringify(emails), JSON.stringify(phones), JSON.stringify(companies), linkedin, x, bluesky, telegram, JSON.stringify(tags), JSON.stringify(custom), now(), c.id])
      const row = db.query('SELECT * FROM contacts WHERE id = ?').get(c.id)
      upsertSearchIndex(db, 'contact', c.id, buildContactSearch(row))
    })

  cmd.command('rm').argument('<ref>').option('--force').action((ref) => {
    const { db, config } = getCtx()
    const c = resolveContact(db, ref, config)
    if (!c) die(`Error: contact not found: ${ref}`)
    if (!runHook(config, 'pre-contact-rm', { id: c.id, name: c.name }))
      die('Error: pre-contact-rm hook rejected deletion')
    const deals = db.query('SELECT * FROM deals').all() as any[]
    for (const d of deals) {
      const contacts: string[] = safeJSON(d.contacts)
      if (contacts.includes(c.id))
        db.run('UPDATE deals SET contacts=? WHERE id=?', [JSON.stringify(contacts.filter(id => id !== c.id)), d.id])
    }
    db.run('DELETE FROM contacts WHERE id=?', [c.id])
    removeSearchIndex(db, c.id)
    runHook(config, 'post-contact-rm', { id: c.id, name: c.name })
  })

  cmd.command('merge').argument('<id1>').argument('<id2>').option('--keep-first').action((id1, id2) => {
    const { db, config } = getCtx()
    const c1 = resolveContact(db, id1, config), c2 = resolveContact(db, id2, config)
    if (!c1 || !c2) die('Error: one or both contacts not found')
    const mergedEmails = [...new Set([...safeJSON(c1.emails), ...safeJSON(c2.emails)])]
    const mergedPhones = [...new Set([...safeJSON(c1.phones), ...safeJSON(c2.phones)])]
    const mergedCompanies = [...new Set([...safeJSON(c1.companies), ...safeJSON(c2.companies)])]
    const mergedTags = [...new Set([...safeJSON(c1.tags), ...safeJSON(c2.tags)])]
    const mergedCustom = { ...safeJSON(c2.custom_fields), ...safeJSON(c1.custom_fields) }
    const linkedin = c1.linkedin || c2.linkedin
    const x = c1.x || c2.x
    const bluesky = c1.bluesky || c2.bluesky
    const telegram = c1.telegram || c2.telegram
    // Clear loser's social handles to avoid UNIQUE constraint conflicts, then delete loser first
    db.run('UPDATE contacts SET linkedin=NULL,x=NULL,bluesky=NULL,telegram=NULL WHERE id=?', [c2.id])
    db.run('UPDATE contacts SET emails=?,phones=?,companies=?,tags=?,custom_fields=?,linkedin=?,x=?,bluesky=?,telegram=?,updated_at=? WHERE id=?',
      [JSON.stringify(mergedEmails), JSON.stringify(mergedPhones), JSON.stringify(mergedCompanies),
       JSON.stringify(mergedTags), JSON.stringify(mergedCustom), linkedin, x, bluesky, telegram, now(), c1.id])
    const deals = db.query('SELECT * FROM deals').all() as any[]
    for (const d of deals) {
      const contacts: string[] = safeJSON(d.contacts)
      if (contacts.includes(c2.id)) {
        const updated = [...new Set(contacts.map(id => id === c2.id ? c1.id : id))]
        db.run('UPDATE deals SET contacts=? WHERE id=?', [JSON.stringify(updated), d.id])
      }
    }
    db.run('UPDATE activities SET contact=? WHERE contact=?', [c1.id, c2.id])
    db.run('DELETE FROM contacts WHERE id=?', [c2.id])
    removeSearchIndex(db, c2.id)
    const row = db.query('SELECT * FROM contacts WHERE id = ?').get(c1.id)
    upsertSearchIndex(db, 'contact', c1.id, buildContactSearch(row))
  })
}
