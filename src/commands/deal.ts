import type { Command } from 'commander'
import { getCtx, makeId, now, die, collect, parseKV, buildDealSearch, dealDetail, showEntity, getOrCreateCompanyId } from '../lib/helpers'
import { resolveContact, resolveCompanyForLink, resolveDeal } from '../resolve'
import { formatOutput, dealToRow, safeJSON } from '../format'
import { upsertSearchIndex, removeSearchIndex } from '../db'
import { runHook } from '../hooks'

export function registerDealCommands(program: Command) {
  const cmd = program.command('deal').description('Manage deals')

  cmd.command('add')
    .requiredOption('--title <title>', 'Deal title')
    .option('--value <n>', 'Deal value')
    .option('--stage <stage>', 'Pipeline stage')
    .option('--contact <ref>', 'Contact', collect, [])
    .option('--company <ref>', 'Company')
    .option('--expected-close <date>', 'Expected close date')
    .option('--probability <n>', 'Win probability 0-100')
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--set <kv>', 'Custom field', collect, [])
    .action((opts) => {
      const { db, config } = getCtx()
      const id = makeId('dl')
      const n = now()
      if (opts.value !== undefined && Number(opts.value) < 0) die('Error: value must be non-negative')
      if (opts.probability !== undefined) {
        const prob = Number(opts.probability)
        if (prob < 0 || prob > 100) die('Error: probability must be between 0 and 100')
      }
      if (opts.expectedClose) {
        const d = new Date(opts.expectedClose)
        if (isNaN(d.getTime())) die('Error: invalid expected-close date')
      }
      const stage = opts.stage || config.pipeline.stages[0]
      if (!config.pipeline.stages.includes(stage)) die(`Error: invalid stage "${stage}"`)
      const contactIds: string[] = []
      for (const ref of opts.contact) {
        const ct = resolveContact(db, ref, config)
        if (!ct) die(`Error: contact not found: ${ref}`)
        contactIds.push(ct.id)
      }
      let companyId: string | null = null
      if (opts.company) {
        const co = resolveCompanyForLink(db, opts.company, config)
        if (co) {
          companyId = co.id
        } else {
          // Auto-create only for plain names (no dots suggesting domain)
          if (opts.company.includes('.')) die(`Error: company not found: ${opts.company}`)
          companyId = getOrCreateCompanyId(db, opts.company, config)
        }
      }
      const custom = parseKV(opts.set)
      const value = opts.value !== undefined ? Number(opts.value) : null
      const probability = opts.probability !== undefined ? Number(opts.probability) : null
      db.run('INSERT INTO deals (id,title,value,stage,contacts,company,expected_close,probability,tags,custom_fields,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, opts.title, value, stage, JSON.stringify(contactIds), companyId, opts.expectedClose || null, probability, JSON.stringify(opts.tag), JSON.stringify(custom), n, n])
      const row = db.query('SELECT * FROM deals WHERE id = ?').get(id)
      upsertSearchIndex(db, 'deal', id, buildDealSearch(row))
      console.log(id)
    })

  cmd.command('list')
    .option('--stage <stage>')
    .option('--min-value <n>')
    .option('--max-value <n>')
    .option('--contact <ref>')
    .option('--sort <field>')
    .option('--limit <n>')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let rows = (db.query('SELECT * FROM deals').all() as any[]).map(d => dealToRow(d, config))
      if (opts.stage) rows = rows.filter(d => d.stage === opts.stage)
      if (opts.minValue) rows = rows.filter(d => (d.value ?? 0) >= Number(opts.minValue))
      if (opts.maxValue) rows = rows.filter(d => (d.value ?? 0) <= Number(opts.maxValue))
      if (opts.contact) {
        const ct = resolveContact(db, opts.contact, config)
        if (ct) rows = rows.filter(d => d.contacts.includes(ct.id))
        else rows = []
      }
      if (opts.sort) {
        rows.sort((a, b) => {
          const av = a[opts.sort], bv = b[opts.sort]
          if (typeof av === 'number' && typeof bv === 'number') return av - bv
          return String(av ?? '').localeCompare(String(bv ?? ''))
        })
      }
      if (opts.limit) rows = rows.slice(0, Number(opts.limit))
      console.log(formatOutput(rows, fmt, config))
    })

  cmd.command('show').argument('<ref>').action((ref) => {
    const { db, config, fmt } = getCtx()
    const d = resolveDeal(db, ref)
    if (!d) die(`Error: deal not found: ${ref}`)
    showEntity(dealDetail(db, d, config), fmt)
  })

  cmd.command('edit').argument('<ref>')
    .option('--title <title>')
    .option('--value <n>')
    .option('--add-contact <ref>', '', collect, [])
    .option('--rm-contact <ref>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action((ref, opts) => {
      const { db, config } = getCtx()
      const d = resolveDeal(db, ref)
      if (!d) die(`Error: deal not found: ${ref}`)
      const title = opts.title ?? d.title
      const value = opts.value !== undefined ? Number(opts.value) : d.value
      let contacts: string[] = safeJSON(d.contacts)
      let tags: string[] = safeJSON(d.tags)
      let custom: Record<string, any> = safeJSON(d.custom_fields)
      for (const r of opts.addContact) {
        const ct = resolveContact(db, r, config)
        if (!ct) die(`Error: contact not found: ${r}`)
        if (!contacts.includes(ct.id)) contacts.push(ct.id)
      }
      for (const r of opts.rmContact) {
        const ct = resolveContact(db, r, config)
        if (ct) contacts = contacts.filter(id => id !== ct.id)
      }
      for (const t of opts.addTag) { if (!tags.includes(t)) tags.push(t) }
      for (const t of opts.rmTag) tags = tags.filter(v => v !== t)
      const kvs = parseKV(opts.set)
      for (const [k, v] of Object.entries(kvs)) custom[k] = v
      for (const k of opts.unset) delete custom[k]
      db.run('UPDATE deals SET title=?,value=?,contacts=?,tags=?,custom_fields=?,updated_at=? WHERE id=?',
        [title, value, JSON.stringify(contacts), JSON.stringify(tags), JSON.stringify(custom), now(), d.id])
      const row = db.query('SELECT * FROM deals WHERE id = ?').get(d.id)
      upsertSearchIndex(db, 'deal', d.id, buildDealSearch(row))
    })

  cmd.command('move').argument('<ref>')
    .requiredOption('--stage <stage>', 'Target stage')
    .option('--note <text>', 'Note')
    .option('--reason <text>', 'Reason')
    .action((ref, opts) => {
      const { db, config } = getCtx()
      const d = resolveDeal(db, ref)
      if (!d) die(`Error: deal not found: ${ref}`)
      if (!config.pipeline.stages.includes(opts.stage)) die(`Error: invalid stage "${opts.stage}"`)
      if (d.stage === opts.stage) die(`Error: deal is already in stage "${opts.stage}"`)
      const oldStage = d.stage
      const n = now()
      db.run('UPDATE deals SET stage=?,updated_at=? WHERE id=?', [opts.stage, n, d.id])
      let body = `from ${oldStage} to ${opts.stage}`
      if (opts.note) body += ` | ${opts.note}`
      if (opts.reason) body += ` | ${opts.reason}`
      const aid = makeId('ac')
      db.run('INSERT INTO activities (id,type,body,deal,created_at) VALUES (?,?,?,?,?)',
        [aid, 'stage-change', body, d.id, n])
      upsertSearchIndex(db, 'activity', aid, `stage-change ${body}`)
      runHook(config, 'post-deal-stage-change', { deal: d.id, from: oldStage, to: opts.stage, note: opts.note, reason: opts.reason })
    })

  cmd.command('rm').argument('<ref>').option('--force').action((ref) => {
    const { db } = getCtx()
    const d = resolveDeal(db, ref)
    if (!d) die(`Error: deal not found: ${ref}`)
    db.run('DELETE FROM activities WHERE deal = ?', [d.id])
    db.run('DELETE FROM deals WHERE id = ?', [d.id])
    removeSearchIndex(db, d.id)
  })
}

export function registerPipelineCommand(program: Command) {
  program.command('pipeline').description('Pipeline summary').action(() => {
    const { db, config, fmt } = getCtx()
    const deals = db.query('SELECT * FROM deals').all() as any[]
    const summary = config.pipeline.stages.map(stage => ({
      stage,
      count: deals.filter(d => d.stage === stage).length,
      value: deals.filter(d => d.stage === stage).reduce((s, d) => s + (d.value || 0), 0),
    }))
    const total = { stage: 'Total', count: deals.length, value: deals.reduce((s, d) => s + (d.value || 0), 0) }
    const data = [...summary, total]
    if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
    else console.log(formatOutput(data, fmt, config))
  })
}
