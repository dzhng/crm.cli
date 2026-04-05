import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import type { CRMConfig } from './config'
import type { DB } from './db'
import * as schema from './drizzle-schema'
import { safeJSON } from './format'
import {
  activityFilename,
  buildActivityJSON,
  buildCompanyJSON,
  buildContactJSON,
  buildDealJSON,
  companyFilename,
  contactFilename,
  dealFilename,
  slugify,
} from './fuse-json'
import {
  computeConversion,
  computeForecast,
  computeLost,
  computeStale,
  computeVelocity,
  computeWon,
} from './reports'

function writeJSON(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export async function generateFS(
  db: DB,
  config: CRMConfig,
  outDir: string,
): Promise<void> {
  ensureDir(outDir)
  ensureDir(join(outDir, 'contacts'))
  ensureDir(join(outDir, 'contacts', '_by-email'))
  ensureDir(join(outDir, 'contacts', '_by-phone'))
  ensureDir(join(outDir, 'contacts', '_by-linkedin'))
  ensureDir(join(outDir, 'contacts', '_by-x'))
  ensureDir(join(outDir, 'contacts', '_by-bluesky'))
  ensureDir(join(outDir, 'contacts', '_by-telegram'))
  ensureDir(join(outDir, 'contacts', '_by-company'))
  ensureDir(join(outDir, 'contacts', '_by-tag'))

  ensureDir(join(outDir, 'companies'))
  ensureDir(join(outDir, 'companies', '_by-website'))
  ensureDir(join(outDir, 'companies', '_by-phone'))
  ensureDir(join(outDir, 'companies', '_by-tag'))

  ensureDir(join(outDir, 'deals'))
  ensureDir(join(outDir, 'deals', '_by-stage'))
  for (const stage of config.pipeline.stages) {
    ensureDir(join(outDir, 'deals', '_by-stage', stage))
  }
  ensureDir(join(outDir, 'deals', '_by-company'))
  ensureDir(join(outDir, 'deals', '_by-tag'))

  ensureDir(join(outDir, 'activities'))
  ensureDir(join(outDir, 'activities', '_by-contact'))
  ensureDir(join(outDir, 'activities', '_by-company'))
  ensureDir(join(outDir, 'activities', '_by-deal'))
  ensureDir(join(outDir, 'activities', '_by-type'))

  ensureDir(join(outDir, 'reports'))
  ensureDir(join(outDir, 'search'))

  // Write contacts
  const contacts = await db.select().from(schema.contacts)
  for (const c of contacts) {
    const data = await buildContactJSON(db, c, config)
    const filename = contactFilename(c)
    const filePath = join(outDir, 'contacts', filename)
    writeJSON(filePath, data)

    const emails: string[] = safeJSON(c.emails)
    for (const email of emails) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-email', `${email}.json`),
      )
    }

    const phones: string[] = safeJSON(c.phones)
    for (const phone of phones) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-phone', `${phone}.json`),
      )
    }

    if (c.linkedin) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-linkedin', `${c.linkedin}.json`),
      )
    }
    if (c.x) {
      copyFileSync(filePath, join(outDir, 'contacts', '_by-x', `${c.x}.json`))
    }
    if (c.bluesky) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-bluesky', `${c.bluesky}.json`),
      )
    }
    if (c.telegram) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-telegram', `${c.telegram}.json`),
      )
    }

    const companies: string[] = safeJSON(c.companies)
    for (const compName of companies) {
      const compSlug = slugify(compName)
      ensureDir(join(outDir, 'contacts', '_by-company', compSlug))
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-company', compSlug, filename),
      )
    }

    const tags: string[] = safeJSON(c.tags)
    for (const tag of tags) {
      ensureDir(join(outDir, 'contacts', '_by-tag', tag))
      copyFileSync(filePath, join(outDir, 'contacts', '_by-tag', tag, filename))
    }
  }

  // Write companies
  const companies = await db.select().from(schema.companies)
  for (const co of companies) {
    const data = await buildCompanyJSON(db, co)
    const filename = companyFilename(co)
    const filePath = join(outDir, 'companies', filename)
    writeJSON(filePath, data)

    const websites: string[] = safeJSON(co.websites)
    for (const website of websites) {
      copyFileSync(
        filePath,
        join(outDir, 'companies', '_by-website', `${website}.json`),
      )
    }

    const phones: string[] = safeJSON(co.phones)
    for (const phone of phones) {
      copyFileSync(
        filePath,
        join(outDir, 'companies', '_by-phone', `${phone}.json`),
      )
    }

    const tags: string[] = safeJSON(co.tags)
    for (const tag of tags) {
      ensureDir(join(outDir, 'companies', '_by-tag', tag))
      copyFileSync(
        filePath,
        join(outDir, 'companies', '_by-tag', tag, filename),
      )
    }
  }

  // Write deals
  const deals = await db.select().from(schema.deals)
  for (const d of deals) {
    const data = await buildDealJSON(db, d)
    const filename = dealFilename(d)
    const filePath = join(outDir, 'deals', filename)
    writeJSON(filePath, data)

    if (d.stage) {
      const stageDir = join(outDir, 'deals', '_by-stage', d.stage)
      ensureDir(stageDir)
      copyFileSync(filePath, join(stageDir, filename))
    }

    if (d.company) {
      const companyResults = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, d.company))
      if (companyResults[0]) {
        const compSlug = slugify(companyResults[0].name || '')
        ensureDir(join(outDir, 'deals', '_by-company', compSlug))
        copyFileSync(
          filePath,
          join(outDir, 'deals', '_by-company', compSlug, filename),
        )
      }
    }

    const tags: string[] = safeJSON(d.tags)
    for (const tag of tags) {
      ensureDir(join(outDir, 'deals', '_by-tag', tag))
      copyFileSync(filePath, join(outDir, 'deals', '_by-tag', tag, filename))
    }
  }

  // Write activities
  const activities = await db.select().from(schema.activities)
  for (const a of activities) {
    const data = buildActivityJSON(a)
    const filename = activityFilename(a)
    const filePath = join(outDir, 'activities', filename)
    writeJSON(filePath, data)

    if (a.contact) {
      const contactResults = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, a.contact))
      if (contactResults[0]) {
        const contactSlug = `${a.contact}...${slugify(contactResults[0].name || '')}`
        ensureDir(join(outDir, 'activities', '_by-contact', contactSlug))
        copyFileSync(
          filePath,
          join(outDir, 'activities', '_by-contact', contactSlug, filename),
        )
      }
    }

    if (a.company) {
      const companyResults = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, a.company))
      if (companyResults[0]) {
        const compSlug = slugify(companyResults[0].name || '')
        ensureDir(join(outDir, 'activities', '_by-company', compSlug))
        copyFileSync(
          filePath,
          join(outDir, 'activities', '_by-company', compSlug, filename),
        )
      }
    }

    if (a.deal) {
      ensureDir(join(outDir, 'activities', '_by-deal', a.deal))
      copyFileSync(
        filePath,
        join(outDir, 'activities', '_by-deal', a.deal, filename),
      )
    }

    if (a.type) {
      ensureDir(join(outDir, 'activities', '_by-type', a.type))
      copyFileSync(
        filePath,
        join(outDir, 'activities', '_by-type', a.type, filename),
      )
    }
  }

  // Write pipeline.json
  const pipelineData = config.pipeline.stages.map((stage) => ({
    stage,
    count: deals.filter((d) => d.stage === stage).length,
    value: deals
      .filter((d) => d.stage === stage)
      .reduce((s, d) => s + (d.value || 0), 0),
  }))
  writeJSON(join(outDir, 'pipeline.json'), pipelineData)

  // Write tags.json
  const tagCounts: Record<string, number> = {}
  for (const c of contacts) {
    for (const t of safeJSON(c.tags) as string[]) {
      tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }
  for (const co of companies) {
    for (const t of safeJSON(co.tags) as string[]) {
      tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }
  for (const d of deals) {
    for (const t of safeJSON(d.tags) as string[]) {
      tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }
  const tagsData = Object.entries(tagCounts).map(([tag, count]) => ({
    tag,
    count,
  }))
  writeJSON(join(outDir, 'tags.json'), tagsData)

  // Write reports
  writeJSON(join(outDir, 'reports', 'pipeline.json'), pipelineData)
  writeJSON(join(outDir, 'reports', 'stale.json'), await computeStale(db))
  writeJSON(join(outDir, 'reports', 'forecast.json'), await computeForecast(db))
  writeJSON(
    join(outDir, 'reports', 'conversion.json'),
    await computeConversion(db, config.pipeline.stages),
  )
  writeJSON(
    join(outDir, 'reports', 'velocity.json'),
    await computeVelocity(db, config.pipeline.stages),
  )
  writeJSON(join(outDir, 'reports', 'won.json'), await computeWon(db, config))
  writeJSON(join(outDir, 'reports', 'lost.json'), await computeLost(db, config))
}
