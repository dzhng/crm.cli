import type { Command } from 'commander'
import { getCtx, makeId, now, die, collect, parseKV, checkDupePhone, checkDupeWebsite,
  buildCompanySearch, companyDetail, showEntity } from '../lib/helpers'
import { normalizePhone, tryNormalizePhone, normalizeWebsite, formatPhone } from '../normalize'
import { formatOutput, companyToRow, safeJSON } from '../format'
import { resolveCompany } from '../resolve'
import { upsertSearchIndex, removeSearchIndex } from '../db'
import { runHook } from '../hooks'
import { companyAddSchema, companyEditSchema, formatZodError } from '../schema'

export function registerCompanyCommands(program: Command) {
  const cmd = program.command('company').description('Manage companies')

  cmd.command('add')
    .requiredOption('--name <name>', 'Company name')
    .option('--website <url>', 'Website', collect, [])
    .option('--phone <phone>', 'Phone', collect, [])
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--set <kv>', 'Custom field', collect, [])
    .action((opts) => {
      const { db, config } = getCtx()

      // Validate and transform inputs via Zod
      const parsed = companyAddSchema(config.phone.default_country).safeParse(opts)
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]
        if (firstIssue.path[0] === 'phone') {
          die(`Error: invalid phone — ${firstIssue.message}`)
        }
        die(`Error: ${formatZodError(parsed.error)}`)
      }
      const data = parsed.data

      const cid = makeId('co')
      const n = now()
      const websites = data.website
      for (const norm of websites) {
        checkDupeWebsite(db, norm)
      }
      const phones = data.phone
      for (const norm of phones) {
        checkDupePhone(db, norm, 'companies')
      }
      const custom = parseKV(data.set)
      db.run('INSERT INTO companies (id,name,websites,phones,tags,custom_fields,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [cid, data.name, JSON.stringify(websites), JSON.stringify(phones), JSON.stringify(data.tag), JSON.stringify(custom), n, n])
      const row = db.query('SELECT * FROM companies WHERE id = ?').get(cid)
      upsertSearchIndex(db, 'company', cid, buildCompanySearch(row))
      console.log(cid)
    })

  cmd.command('list')
    .option('--tag <tag>')
    .option('--sort <field>')
    .option('--limit <n>')
    .option('--filter <expr>')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let rows = (db.query('SELECT * FROM companies').all() as any[]).map(c => companyToRow(c, config))
      if (opts.tag) rows = rows.filter(c => c.tags.includes(opts.tag))
      if (opts.sort) rows.sort((a, b) => String(a[opts.sort] ?? '').localeCompare(String(b[opts.sort] ?? '')))
      if (opts.limit) rows = rows.slice(0, Number(opts.limit))
      console.log(formatOutput(rows, fmt, config))
    })

  cmd.command('show').argument('<ref>').action((ref) => {
    const { db, config, fmt } = getCtx()
    const co = resolveCompany(db, ref, config)
    if (!co) die(`Error: company not found: ${ref}`)
    showEntity(companyDetail(db, co, config), fmt)
  })

  cmd.command('edit').argument('<ref>')
    .option('--name <name>')
    .option('--add-website <url>', '', collect, [])
    .option('--rm-website <url>', '', collect, [])
    .option('--add-phone <p>', '', collect, [])
    .option('--rm-phone <p>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action((ref, opts) => {
      const { db, config } = getCtx()
      const co = resolveCompany(db, ref, config)
      if (!co) die(`Error: company not found: ${ref}`)

      // Validate and transform edit inputs via Zod
      const parsed = companyEditSchema(config.phone.default_country).safeParse(opts)
      if (!parsed.success) die(`Error: ${formatZodError(parsed.error)}`)
      const data = parsed.data

      let websites: string[] = safeJSON(co.websites)
      let phones: string[] = safeJSON(co.phones)
      let tags: string[] = safeJSON(co.tags)
      let custom: Record<string, any> = safeJSON(co.custom_fields)
      let name = co.name
      if (data.name) name = data.name
      for (const norm of data.addWebsite) {
        if (websites.includes(norm)) die(`Error: duplicate website "${norm}" — already on this company`)
        checkDupeWebsite(db, norm, co.id)
        websites.push(norm)
      }
      for (const w of opts.rmWebsite) { const norm = normalizeWebsite(w); websites = websites.filter(v => v !== norm) }
      for (const norm of data.addPhone) {
        if (phones.includes(norm)) die(`Error: duplicate phone "${norm}" — already on this company`)
        checkDupePhone(db, norm, 'companies', co.id)
        phones.push(norm)
      }
      for (const p of opts.rmPhone) {
        const norm = tryNormalizePhone(p, config.phone.default_country)
        phones = norm ? phones.filter(v => v !== norm) : phones.filter(v => v !== p)
      }
      for (const t of data.addTag) { if (!tags.includes(t)) tags.push(t) }
      for (const t of data.rmTag) tags = tags.filter(v => v !== t)
      const kvs = parseKV(data.set)
      for (const [k, v] of Object.entries(kvs)) custom[k] = v
      for (const k of data.unset) delete custom[k]
      db.run('UPDATE companies SET name=?,websites=?,phones=?,tags=?,custom_fields=?,updated_at=? WHERE id=?',
        [name, JSON.stringify(websites), JSON.stringify(phones), JSON.stringify(tags), JSON.stringify(custom), now(), co.id])
      const row = db.query('SELECT * FROM companies WHERE id = ?').get(co.id)
      upsertSearchIndex(db, 'company', co.id, buildCompanySearch(row))
    })

  cmd.command('rm').argument('<ref>').option('--force').action((ref) => {
    const { db, config } = getCtx()
    const co = resolveCompany(db, ref, config)
    if (!co) die(`Error: company not found: ${ref}`)
    if (!runHook(config, 'pre-company-rm', { id: co.id, name: co.name }))
      die('Error: pre-company-rm hook rejected deletion')
    // Unlink from contacts
    const contacts = db.query('SELECT * FROM contacts').all() as any[]
    for (const ct of contacts) {
      const companies: string[] = safeJSON(ct.companies)
      if (companies.includes(co.name))
        db.run('UPDATE contacts SET companies=? WHERE id=?', [JSON.stringify(companies.filter(n => n !== co.name)), ct.id])
    }
    // Set deals company to null
    db.run('UPDATE deals SET company=NULL WHERE company=?', [co.id])
    db.run('DELETE FROM companies WHERE id=?', [co.id])
    removeSearchIndex(db, co.id)
    runHook(config, 'post-company-rm', { id: co.id, name: co.name })
  })

  cmd.command('merge').argument('<id1>').argument('<id2>').option('--keep-first').action((id1, id2) => {
    const { db, config } = getCtx()
    const c1 = resolveCompany(db, id1, config), c2 = resolveCompany(db, id2, config)
    if (!c1 || !c2) die('Error: one or both companies not found')
    const mergedWebsites = [...new Set([...safeJSON(c1.websites), ...safeJSON(c2.websites)])]
    const mergedPhones = [...new Set([...safeJSON(c1.phones), ...safeJSON(c2.phones)])]
    const mergedTags = [...new Set([...safeJSON(c1.tags), ...safeJSON(c2.tags)])]
    const mergedCustom = { ...safeJSON(c2.custom_fields), ...safeJSON(c1.custom_fields) }
    db.run('UPDATE companies SET websites=?,phones=?,tags=?,custom_fields=?,updated_at=? WHERE id=?',
      [JSON.stringify(mergedWebsites), JSON.stringify(mergedPhones), JSON.stringify(mergedTags), JSON.stringify(mergedCustom), now(), c1.id])
    // Relink contacts
    const contacts = db.query('SELECT * FROM contacts').all() as any[]
    for (const ct of contacts) {
      const companies: string[] = safeJSON(ct.companies)
      if (companies.includes(c2.name)) {
        const updated = [...new Set(companies.map(n => n === c2.name ? c1.name : n))]
        db.run('UPDATE contacts SET companies=? WHERE id=?', [JSON.stringify(updated), ct.id])
      }
    }
    // Relink deals
    db.run('UPDATE deals SET company=? WHERE company=?', [c1.id, c2.id])
    // Transfer activities
    db.run('UPDATE activities SET company=? WHERE company=?', [c1.id, c2.id])
    db.run('DELETE FROM companies WHERE id=?', [c2.id])
    removeSearchIndex(db, c2.id)
    const row = db.query('SELECT * FROM companies WHERE id = ?').get(c1.id)
    upsertSearchIndex(db, 'company', c1.id, buildCompanySearch(row))
  })
}
