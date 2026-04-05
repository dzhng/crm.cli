import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import * as schema from '../drizzle-schema'
import { formatOutput } from '../format'
import { getCtx } from '../lib/helpers'
import {
  computeConversion,
  computeForecast,
  computeLost,
  computePipeline,
  computeStale,
  computeVelocity,
  computeWon,
} from '../reports'

export function registerReportCommands(program: Command) {
  const cmd = program.command('report').description('Reports')

  cmd.command('pipeline').action(async () => {
    const { db, config, fmt } = await getCtx()
    const deals = await db.select().from(schema.deals)
    const summary = computePipeline(deals, config.pipeline.stages)
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

  cmd
    .command('activity')
    .option('--by <field>', 'Group by (type or contact)')
    .option('--period <period>', 'Time period (e.g. 7d, 30d)')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let activities = await db.select().from(schema.activities)
      if (opts.period) {
        const cutoff = periodToDate(opts.period)
        if (cutoff) {
          activities = activities.filter((a) => a.created_at >= cutoff)
        }
      }
      const groupBy = opts.by || 'type'
      const groups: Record<string, number> = {}
      for (const a of activities) {
        const key = groupBy === 'contact' ? a.contact || 'none' : a.type
        groups[key] = (groups[key] || 0) + 1
      }
      let data: Record<string, unknown>[]
      if (groupBy === 'contact') {
        const dataPromises = Object.entries(groups).map(
          async ([contact, count]) => {
            if (contact === 'none') {
              return { contact: '(none)', count }
            }
            const results = await db
              .select({ name: schema.contacts.name })
              .from(schema.contacts)
              .where(eq(schema.contacts.id, contact))
            const ct = results[0]
            return { contact: ct?.name || contact, count }
          },
        )
        data = await Promise.all(dataPromises)
      } else {
        data = Object.entries(groups).map(([type, count]) => ({ type, count }))
      }
      if (fmt === 'json') {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.log(formatOutput(data, fmt, config))
      }
    })

  cmd
    .command('stale')
    .option('--days <n>', 'Days threshold', '30')
    .option('--type <type>', 'Entity type (contact or deal)')
    .action(async (opts) => {
      const { db, fmt } = await getCtx()
      const days = Number(opts.days)
      let results = await computeStale(db, days)
      if (opts.type) {
        results = results.filter((r) => r.type === opts.type)
      }
      if (fmt === 'json') {
        console.log(JSON.stringify(results, null, 2))
      } else {
        if (results.length === 0) {
          console.log('No stale entities found.')
          return
        }
        const lines = results.map(
          (r) =>
            `[${r.type}] ${r.name || r.title} (${r.id}) — last: ${r.last_activity || 'never'}`,
        )
        console.log(lines.join('\n'))
      }
    })

  cmd.command('conversion').action(async () => {
    const { db, config, fmt } = await getCtx()
    const data = await computeConversion(db, config.pipeline.stages)
    if (fmt === 'json') {
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log(formatOutput(data, fmt, config))
    }
  })

  cmd.command('velocity').action(async () => {
    const { db, config, fmt } = await getCtx()
    const data = await computeVelocity(db, config.pipeline.stages)
    if (fmt === 'json') {
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log(
        formatOutput(
          data.map((d) => ({
            stage: d.stage,
            avg_time: d.avg_display,
            deals: d.deals,
          })),
          fmt,
          config,
        ),
      )
    }
  })

  cmd
    .command('forecast')
    .option(
      '--period <period>',
      'Filter by expected close month (YYYY-MM) or days (30d)',
    )
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let data = await computeForecast(db)
      if (opts.period) {
        if (opts.period.match(/^\d{4}-\d{2}$/)) {
          data = data.filter((d) => d.expected_close?.startsWith(opts.period))
        } else {
          const cutoff = periodToDate(opts.period)
          if (cutoff) {
            data = data.filter(
              (d) => d.expected_close && d.expected_close >= cutoff,
            )
          }
        }
      }
      if (fmt === 'json') {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.log(formatOutput(data, fmt, config))
      }
    })

  cmd
    .command('won')
    .option('--period <period>', 'Time period (e.g. 30d)')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let data = await computeWon(db, config)
      if (opts.period) {
        const cutoff = periodToDate(opts.period)
        if (cutoff) {
          data = data.filter((d) => (d.updated_at as string) >= cutoff)
        }
      }
      if (fmt === 'json') {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.log(formatOutput(data, fmt, config))
      }
    })

  cmd
    .command('lost')
    .option('--reasons', 'Show loss reasons')
    .option('--period <period>', 'Time period')
    .action(async (opts) => {
      const { db, config, fmt } = await getCtx()
      let data = await computeLost(db, config)
      if (opts.period) {
        const cutoff = periodToDate(opts.period)
        if (cutoff) {
          data = data.filter((d) => (d.updated_at as string) >= cutoff)
        }
      }
      if (!opts.reasons) {
        data = data.map((d) => {
          const { reason: _, ...rest } = d
          return rest
        })
      }
      if (fmt === 'json') {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.log(formatOutput(data, fmt, config))
      }
    })
}

function periodToDate(period: string): string | null {
  const m = period.match(/^(\d+)d$/)
  if (m) {
    return new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString()
  }
  return null
}
