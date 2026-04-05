import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Command } from 'commander'
import { eq } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import type { Activity, Company, Contact, Deal } from '../drizzle-schema'
import * as schema from '../drizzle-schema'
import { safeJSON } from '../format'
import { die, getCtx } from '../lib/helpers'

function slugify(name: string): string {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function contactFilename(c: Contact): string {
  return `${c.id}...${slugify(c.name || '')}.json`
}

function companyFilename(co: Company): string {
  return `${co.id}...${slugify(co.name || '')}.json`
}

function dealFilename(d: Deal): string {
  return `${d.id}...${slugify(d.title || '')}.json`
}

function activityFilename(a: Activity): string {
  const dateStr = (a.created_at || '').slice(0, 10)
  return `${a.id}...${a.type || 'unknown'}-${dateStr}.json`
}

async function buildContactJSON(
  db: DB,
  c: Contact,
  config: CRMConfig,
): Promise<Record<string, unknown>> {
  const emails: string[] = safeJSON(c.emails)
  const phones: string[] = safeJSON(c.phones)
  const companyNames: string[] = safeJSON(c.companies)
  const tags: string[] = safeJSON(c.tags)
  const customFields = safeJSON(c.custom_fields) || {}

  // Resolve linked companies
  const allCompanies = await db.select().from(schema.companies)
  const linkedCompanies = companyNames
    .map((name) => {
      const co = allCompanies.find((x) => x.name === name)
      return co ? { id: co.id, name: co.name } : { name }
    })
    .filter(Boolean)

  // Linked deals
  const allDeals = await db.select().from(schema.deals)
  const linkedDeals = allDeals
    .filter((d) => {
      const contacts: string[] = safeJSON(d.contacts)
      return contacts.includes(c.id)
    })
    .map((d) => ({
      id: d.id,
      title: d.title,
      stage: d.stage,
      value: d.value,
    }))

  // Recent activity
  const activities = await db.select().from(schema.activities)
  const contactActivities = activities
    .filter((a) => a.contact === c.id)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, config.mount.max_recent_activity)
    .map((a) => ({
      id: a.id,
      type: a.type,
      note: a.body,
      created_at: a.created_at,
    }))

  return {
    id: c.id,
    name: c.name,
    emails,
    phones,
    companies: linkedCompanies,
    linkedin: c.linkedin,
    x: c.x,
    bluesky: c.bluesky,
    telegram: c.telegram,
    tags,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    deals: linkedDeals,
    recent_activity: contactActivities,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }
}

async function buildCompanyJSON(
  db: DB,
  co: Company,
  _config: CRMConfig,
): Promise<Record<string, unknown>> {
  const websites: string[] = safeJSON(co.websites)
  const phones: string[] = safeJSON(co.phones)
  const tags: string[] = safeJSON(co.tags)
  const customFields = safeJSON(co.custom_fields) || {}

  // Linked contacts
  const allContacts = await db.select().from(schema.contacts)
  const linkedContacts = allContacts
    .filter((c) => {
      const companies: string[] = safeJSON(c.companies)
      return companies.includes(co.name)
    })
    .map((c) => ({ id: c.id, name: c.name }))

  // Linked deals
  const allDeals = await db.select().from(schema.deals)
  const linkedDeals = allDeals
    .filter((d) => d.company === co.id)
    .map((d) => ({
      id: d.id,
      title: d.title,
      stage: d.stage,
      value: d.value,
    }))

  return {
    id: co.id,
    name: co.name,
    websites,
    phones,
    tags,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    contacts: linkedContacts,
    deals: linkedDeals,
    created_at: co.created_at,
    updated_at: co.updated_at,
  }
}

async function buildDealJSON(
  db: DB,
  d: Deal,
  _config: CRMConfig,
): Promise<Record<string, unknown>> {
  const contactIds: string[] = safeJSON(d.contacts)
  const tags: string[] = safeJSON(d.tags)
  const customFields = safeJSON(d.custom_fields) || {}

  // Resolve contacts
  const allContacts = await db.select().from(schema.contacts)
  const linkedContacts = contactIds
    .map((id) => {
      const c = allContacts.find((x) => x.id === id)
      return c ? { id: c.id, name: c.name } : { id }
    })
    .filter(Boolean)

  // Resolve company
  let companyObj: { id: string; name: string | null } | undefined
  if (d.company) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, d.company))
    if (results[0]) {
      companyObj = { id: results[0].id, name: results[0].name }
    }
  }

  // Stage history from activities
  const activities = await db.select().from(schema.activities)
  const stageHistory = activities
    .filter((a) => a.deal === d.id && a.type === 'stage-change')
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map((a) => ({
      body: a.body,
      created_at: a.created_at,
    }))

  return {
    id: d.id,
    title: d.title,
    value: d.value,
    stage: d.stage,
    contacts: linkedContacts,
    company: companyObj,
    expected_close: d.expected_close,
    probability: d.probability,
    tags,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    stage_history: stageHistory,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }
}

function buildActivityJSON(a: Activity): Record<string, unknown> {
  const customFields = safeJSON(a.custom_fields) || {}
  return {
    id: a.id,
    type: a.type,
    body: a.body,
    contact: a.contact,
    company: a.company,
    deal: a.deal,
    custom_fields:
      Object.keys(customFields).length > 0 ? customFields : undefined,
    created_at: a.created_at,
  }
}

function writeJSON(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

async function generateFS(
  db: DB,
  config: CRMConfig,
  outDir: string,
): Promise<void> {
  // Create top-level structure
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

    // _by-email
    const emails: string[] = safeJSON(c.emails)
    for (const email of emails) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-email', `${email}.json`),
      )
    }

    // _by-phone
    const phones: string[] = safeJSON(c.phones)
    for (const phone of phones) {
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-phone', `${phone}.json`),
      )
    }

    // _by-linkedin, _by-x, _by-bluesky, _by-telegram
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

    // _by-company
    const companies: string[] = safeJSON(c.companies)
    for (const compName of companies) {
      const compSlug = slugify(compName)
      ensureDir(join(outDir, 'contacts', '_by-company', compSlug))
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-company', compSlug, filename),
      )
    }

    // _by-tag
    const tags: string[] = safeJSON(c.tags)
    for (const tag of tags) {
      ensureDir(join(outDir, 'contacts', '_by-tag', tag))
      copyFileSync(filePath, join(outDir, 'contacts', '_by-tag', tag, filename))
    }
  }

  // Write companies
  const companies = await db.select().from(schema.companies)
  for (const co of companies) {
    const data = await buildCompanyJSON(db, co, config)
    const filename = companyFilename(co)
    const filePath = join(outDir, 'companies', filename)
    writeJSON(filePath, data)

    // _by-website
    const websites: string[] = safeJSON(co.websites)
    for (const website of websites) {
      copyFileSync(
        filePath,
        join(outDir, 'companies', '_by-website', `${website}.json`),
      )
    }

    // _by-phone
    const phones: string[] = safeJSON(co.phones)
    for (const phone of phones) {
      copyFileSync(
        filePath,
        join(outDir, 'companies', '_by-phone', `${phone}.json`),
      )
    }

    // _by-tag
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
    const data = await buildDealJSON(db, d, config)
    const filename = dealFilename(d)
    const filePath = join(outDir, 'deals', filename)
    writeJSON(filePath, data)

    // _by-stage
    if (d.stage) {
      const stageDir = join(outDir, 'deals', '_by-stage', d.stage)
      ensureDir(stageDir)
      copyFileSync(filePath, join(stageDir, filename))
    }

    // _by-company
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

    // _by-tag
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

    // _by-contact
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

    // _by-company
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

    // _by-deal
    if (a.deal) {
      ensureDir(join(outDir, 'activities', '_by-deal', a.deal))
      copyFileSync(
        filePath,
        join(outDir, 'activities', '_by-deal', a.deal, filename),
      )
    }

    // _by-type
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
  writeJSON(join(outDir, 'reports', 'stale.json'), [])
  writeJSON(join(outDir, 'reports', 'forecast.json'), [])
  writeJSON(join(outDir, 'reports', 'conversion.json'), [])
  writeJSON(join(outDir, 'reports', 'velocity.json'), [])
  writeJSON(join(outDir, 'reports', 'won.json'), [])
  writeJSON(join(outDir, 'reports', 'lost.json'), [])
}

export function registerFuseCommands(program: Command) {
  program
    .command('mount')
    .description('Mount CRM as virtual filesystem (requires FUSE)')
    .argument('[mountpoint]', 'Mount point directory')
    .option('--readonly', 'Mount read-only')
    .action(async (mountpoint, opts) => {
      const { config } = await getCtx()
      const mp = mountpoint || config.mount.default_path

      if (!existsSync(mp)) {
        mkdirSync(mp, { recursive: true })
      }

      // Check if FUSE helper binary exists
      const helperPath = join(homedir(), '.crm', 'bin', 'crm-fuse')

      if (!existsSync(helperPath)) {
        // Try to compile it
        const srcPath = join(import.meta.dir, '..', 'fuse-helper.c')
        if (!existsSync(srcPath)) {
          die(
            'Error: FUSE helper not found. Install FUSE dependencies and rebuild, or use `crm export-fs` instead.',
          )
        }
        ensureDir(join(homedir(), '.crm', 'bin'))
        const compile = spawnSync(
          'gcc',
          [
            '-o',
            helperPath,
            srcPath,
            ...(() => {
              const pkgConfig = spawnSync('pkg-config', [
                '--cflags',
                '--libs',
                'fuse3',
              ])
              return pkgConfig.stdout
                ? pkgConfig.stdout.toString().trim().split(/\s+/)
                : ['-lfuse3', '-lpthread']
            })(),
            '-lsqlite3',
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
        if (compile.status !== 0) {
          die(
            `Error: Failed to compile FUSE helper. Ensure libfuse3-dev and libsqlite3-dev are installed.\n${compile.stderr?.toString() || ''}`,
          )
        }
      }

      // Spawn the helper
      const args = ['-f', mp, '--', config.database.path]
      if (opts.readonly || config.mount.readonly) {
        args.unshift('-o', 'ro')
      }

      const proc = Bun.spawn([helperPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Wait briefly for mount to succeed
      await new Promise((resolve) => setTimeout(resolve, 500))

      if (proc.exitCode !== null) {
        die('Error: FUSE mount failed. Is FUSE available?')
      }

      // Write PID file for unmount
      const pidFile = join(homedir(), '.crm', `mount-${slugify(mp)}.pid`)
      writeFileSync(pidFile, String(proc.pid))

      console.log(`Mounted at ${mp} (PID ${proc.pid})`)
    })

  program
    .command('unmount')
    .description('Unmount CRM filesystem')
    .argument('<mountpoint>', 'Mount point')
    .action((mountpoint: string) => {
      const result = spawnSync('fusermount', ['-u', mountpoint], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (result.status !== 0) {
        // Try umount as fallback
        const umount = spawnSync('umount', [mountpoint], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (umount.status !== 0) {
          die(`Error: Failed to unmount ${mountpoint}`)
        }
      }
    })

  program
    .command('export-fs')
    .description('Export CRM data as static filesystem tree')
    .argument('<dir>', 'Output directory')
    .action(async (dir) => {
      const { db, config } = await getCtx()
      await generateFS(db, config, dir)
      console.log(`Exported to ${dir}`)
    })
}
