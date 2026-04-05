import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseTOML } from 'toml'

export interface CRMConfig {
  database: { path: string }
  defaults: { format: string }
  hooks: Record<string, string>
  mount: {
    default_path: string
    readonly: boolean
    max_recent_activity: number
    search_limit: number
  }
  phone: { default_country?: string; display: string }
  pipeline: { stages: string[]; won_stage: string; lost_stage: string }
}

export const SEARCH_MODEL = 'mxbai-embed-xsmall-v1'

const DEFAULT_STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'closed-won',
  'closed-lost',
]

function defaultConfig(): CRMConfig {
  return {
    database: { path: join(homedir(), '.crm', 'crm.db') },
    pipeline: {
      stages: [...DEFAULT_STAGES],
      won_stage: 'closed-won',
      lost_stage: 'closed-lost',
    },
    defaults: { format: 'table' },
    phone: { display: 'international' },
    hooks: {},
    mount: {
      default_path: join(homedir(), 'crm'),
      readonly: false,
      max_recent_activity: 10,
      search_limit: 20,
    },
  }
}

function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir)
  while (true) {
    const candidate = join(dir, 'crm.toml')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  const global = join(homedir(), '.crm', 'config.toml')
  if (existsSync(global)) {
    return global
  }
  return null
}

function mergeConfig(
  base: CRMConfig,
  // biome-ignore lint/suspicious/noExplicitAny: TOML parse output has no static type
  override: Record<string, any>,
): CRMConfig {
  const result = { ...base }
  if (override.database?.path) {
    result.database = { ...result.database, path: override.database.path }
  }
  if (override.pipeline) {
    result.pipeline = { ...result.pipeline }
    if (override.pipeline.stages) {
      result.pipeline.stages = override.pipeline.stages
    }
    if (override.pipeline.won_stage) {
      result.pipeline.won_stage = override.pipeline.won_stage
    }
    if (override.pipeline.lost_stage) {
      result.pipeline.lost_stage = override.pipeline.lost_stage
    }
  }
  if (override.defaults?.format) {
    result.defaults = { ...result.defaults, format: override.defaults.format }
  }
  if (override.phone) {
    result.phone = { ...result.phone }
    if (override.phone.default_country) {
      result.phone.default_country = override.phone.default_country
    }
    if (override.phone.display) {
      result.phone.display = override.phone.display
    }
  }
  if (override.hooks) {
    result.hooks = { ...result.hooks, ...override.hooks }
  }
  if (override.mount) {
    result.mount = { ...result.mount, ...override.mount }
  }
  return result
}

export function loadConfig(opts: {
  configPath?: string
  dbPath?: string
  format?: string
}): CRMConfig {
  let config = defaultConfig()

  // Env var overrides for phone
  if (process.env.CRM_PHONE_DEFAULT_COUNTRY) {
    config.phone.default_country = process.env.CRM_PHONE_DEFAULT_COUNTRY
  }
  if (process.env.CRM_PHONE_DISPLAY) {
    config.phone.display = process.env.CRM_PHONE_DISPLAY
  }

  // Resolve config file
  let configPath = opts.configPath || process.env.CRM_CONFIG || null
  if (!configPath) {
    configPath = findConfigFile(process.cwd())
  }

  if (configPath && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = parseTOML(raw)
      config = mergeConfig(config, parsed)
    } catch (_e) {
      console.error(`Warning: could not parse config file ${configPath}`)
    }
  }

  // DB path resolution: --db flag > CRM_DB env > config file > default (~/.crm/crm.db)
  if (opts.dbPath) {
    config.database.path = opts.dbPath
  } else if (process.env.CRM_DB) {
    config.database.path = process.env.CRM_DB
  }

  // Format: --format flag > CRM_FORMAT env > config > default
  if (opts.format) {
    config.defaults.format = opts.format
  } else if (process.env.CRM_FORMAT) {
    config.defaults.format = process.env.CRM_FORMAT
  }

  return config
}
