import type { Command } from 'commander'
import { getCtx } from '../lib/helpers'
import { formatOutput, safeJSON, activityToRow, dealToRow } from '../format'

export function registerReportCommands(program: Command) {
  const cmd = program.command('report').description('Reports')

  cmd.command('pipeline').action(() => {
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

  cmd.command('activity')
    .option('--by <field>', 'Group by (type or contact)')
    .option('--period <period>', 'Time period (e.g. 7d, 30d)')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let activities = db.query('SELECT * FROM activities').all() as any[]
      if (opts.period) {
        const cutoff = periodToDate(opts.period)
        if (cutoff) activities = activities.filter(a => a.created_at >= cutoff)
      }
      const groupBy = opts.by || 'type'
      const groups: Record<string, number> = {}
      for (const a of activities) {
        const key = groupBy === 'contact' ? (a.contact || 'none') : a.type
        groups[key] = (groups[key] || 0) + 1
      }
      let data: any[]
      if (groupBy === 'contact') {
        data = Object.entries(groups).map(([contact, count]) => {
          if (contact === 'none') return { contact: '(none)', count }
          const ct = db.query('SELECT name FROM contacts WHERE id = ?').get(contact) as any
          return { contact: ct?.name || contact, count }
        })
      } else {
        data = Object.entries(groups).map(([type, count]) => ({ type, count }))
      }
      if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
      else console.log(formatOutput(data, fmt, config))
    })

  cmd.command('stale')
    .option('--days <n>', 'Days threshold', '30')
    .option('--type <type>', 'Entity type (contact or deal)')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      const days = Number(opts.days)
      const cutoff = new Date(Date.now() - days * 86400000).toISOString()
      const results: any[] = []
      if (!opts.type || opts.type === 'contact') {
        const contacts = db.query('SELECT * FROM contacts').all() as any[]
        for (const c of contacts) {
          const lastActivity = db.query('SELECT MAX(created_at) as last FROM activities WHERE contact = ?').get(c.id) as any
          if (!lastActivity?.last || lastActivity.last < cutoff) {
            results.push({ type: 'contact', id: c.id, name: c.name, last_activity: lastActivity?.last || null })
          }
        }
      }
      if (!opts.type || opts.type === 'deal') {
        const deals = db.query('SELECT * FROM deals').all() as any[]
        for (const d of deals) {
          if (d.stage === 'closed-won' || d.stage === 'closed-lost') continue
          const lastActivity = db.query('SELECT MAX(created_at) as last FROM activities WHERE deal = ?').get(d.id) as any
          const lastTouch = lastActivity?.last || d.created_at
          if (lastTouch < cutoff) {
            results.push({ type: 'deal', id: d.id, title: d.title, last_activity: lastActivity?.last || null })
          }
        }
      }
      if (fmt === 'json') console.log(JSON.stringify(results, null, 2))
      else {
        if (results.length === 0) { console.log('No stale entities found.'); return }
        const lines = results.map(r => `[${r.type}] ${r.name || r.title} (${r.id}) — last: ${r.last_activity || 'never'}`)
        console.log(lines.join('\n'))
      }
    })

  cmd.command('conversion').action(() => {
    const { db, config, fmt } = getCtx()
    const stages = config.pipeline.stages
    const activities = db.query("SELECT * FROM activities WHERE type = 'stage-change'").all() as any[]
    const stageEntries: Record<string, Set<string>> = {}
    const stageExits: Record<string, Set<string>> = {}
    for (const s of stages) { stageEntries[s] = new Set(); stageExits[s] = new Set() }
    const deals = db.query('SELECT * FROM deals').all() as any[]
    for (const d of deals) {
      const dealActivities = activities.filter(a => a.deal === d.id)
      if (dealActivities.length === 0) {
        stageEntries[d.stage]?.add(d.id)
      } else {
        const first = dealActivities[0]
        const m = first.body.match(/from (\S+) to/)
        const initialStage = m ? m[1] : d.stage
        if (stageEntries[initialStage]) stageEntries[initialStage].add(d.id)
        for (const a of dealActivities) {
          const from = a.body.match(/from (\S+) to/)?.[1]
          const to = a.body.match(/to (\S+)/)?.[1]
          if (from && stageExits[from]) stageExits[from].add(d.id)
          if (to && stageEntries[to]) stageEntries[to].add(d.id)
        }
      }
    }
    const data = stages.map(stage => ({
      stage,
      entered: stageEntries[stage].size,
      advanced: stageExits[stage].size,
      rate: stageEntries[stage].size > 0 ? Math.round(stageExits[stage].size / stageEntries[stage].size * 100) + '%' : '0%',
    }))
    if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
    else console.log(formatOutput(data, fmt, config))
  })

  cmd.command('velocity').action(() => {
    const { db, config, fmt } = getCtx()
    const stages = config.pipeline.stages
    const activities = db.query("SELECT * FROM activities WHERE type = 'stage-change' ORDER BY created_at ASC").all() as any[]
    const stageTimes: Record<string, number[]> = {}
    for (const s of stages) stageTimes[s] = []
    const dealIds = [...new Set(activities.map(a => a.deal))]
    for (const did of dealIds) {
      const dealActs = activities.filter(a => a.deal === did)
      const deal = db.query('SELECT * FROM deals WHERE id = ?').get(did) as any
      if (!deal) continue
      let prevTime = new Date(deal.created_at).getTime()
      const first = dealActs[0]
      const initialStage = first.body.match(/from (\S+) to/)?.[1]
      if (initialStage && stageTimes[initialStage]) {
        const duration = new Date(first.created_at).getTime() - prevTime
        stageTimes[initialStage].push(duration)
        prevTime = new Date(first.created_at).getTime()
      }
      for (let i = 1; i < dealActs.length; i++) {
        const from = dealActs[i].body.match(/from (\S+) to/)?.[1]
        if (from && stageTimes[from]) {
          const duration = new Date(dealActs[i].created_at).getTime() - new Date(dealActs[i - 1].created_at).getTime()
          stageTimes[from].push(duration)
        }
      }
    }
    const data = stages.map(stage => {
      const times = stageTimes[stage]
      const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0
      return { stage, avg_ms: Math.round(avg), deals: times.length, avg_display: formatDuration(avg) }
    })
    if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
    else console.log(formatOutput(data.map(d => ({ stage: d.stage, avg_time: d.avg_display, deals: d.deals })), fmt, config))
  })

  cmd.command('forecast')
    .option('--period <period>', 'Filter by expected close month (YYYY-MM) or days (30d)')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let deals = db.query('SELECT * FROM deals').all() as any[]
      deals = deals.filter(d => d.stage !== 'closed-won' && d.stage !== 'closed-lost')
      if (opts.period) {
        if (opts.period.match(/^\d{4}-\d{2}$/)) {
          deals = deals.filter(d => d.expected_close && d.expected_close.startsWith(opts.period))
        } else {
          const cutoff = periodToDate(opts.period)
          if (cutoff) deals = deals.filter(d => d.expected_close && d.expected_close >= cutoff)
        }
      }
      const data = deals.map(d => ({
        id: d.id,
        title: d.title,
        value: d.value || 0,
        probability: d.probability ?? 100,
        weighted: Math.round((d.value || 0) * (d.probability ?? 100) / 100),
        expected_close: d.expected_close,
        stage: d.stage,
      }))
      if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
      else console.log(formatOutput(data, fmt, config))
    })

  cmd.command('won')
    .option('--period <period>', 'Time period (e.g. 30d)')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let deals = (db.query("SELECT * FROM deals WHERE stage = 'closed-won'").all() as any[])
      if (opts.period) {
        const cutoff = periodToDate(opts.period)
        if (cutoff) deals = deals.filter(d => d.updated_at >= cutoff)
      }
      const data = deals.map(d => dealToRow(d, config))
      if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
      else console.log(formatOutput(data, fmt, config))
    })

  cmd.command('lost')
    .option('--reasons', 'Show loss reasons')
    .option('--period <period>', 'Time period')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      let deals = (db.query("SELECT * FROM deals WHERE stage = 'closed-lost'").all() as any[])
      if (opts.period) {
        const cutoff = periodToDate(opts.period)
        if (cutoff) deals = deals.filter(d => d.updated_at >= cutoff)
      }
      const data = deals.map(d => {
        const row = dealToRow(d, config) as any
        if (opts.reasons) {
          const act = db.query("SELECT body FROM activities WHERE deal = ? AND type = 'stage-change' AND body LIKE '%closed-lost%'").get(d.id) as any
          const reason = act?.body?.split('|').slice(1).map((s: string) => s.trim()).join(', ') || ''
          row.reason = reason
        }
        return row
      })
      if (fmt === 'json') console.log(JSON.stringify(data, null, 2))
      else console.log(formatOutput(data, fmt, config))
    })
}

function periodToDate(period: string): string | null {
  const m = period.match(/^(\d+)d$/)
  if (m) return new Date(Date.now() - Number(m[1]) * 86400000).toISOString()
  return null
}

function formatDuration(ms: number): string {
  if (ms === 0) return '0s'
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  if (mins > 0) return `${mins}m ${secs % 60}s`
  return `${secs}s`
}
