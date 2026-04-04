import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseTOML } from 'toml'

export interface CRMConfig {
  database: { path: string }
  pipeline: { stages: string[] }
  defaults: { format: string }
  phone: { default_country?: string; display: string }
  search: { model: string }
  hooks: Record<string, string>
  mount: { default_path: string; readonly: boolean; max_recent_activity: number; search_limit: number }
}

const DEFAULT_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'closed-won', 'closed-lost']

function defaultConfig(): CRMConfig {
  return {
    database: { path: join(homedir(), '.crm', 'crm.db') },
    pipeline: { stages: [...DEFAULT_STAGES] },
    defaults: { format: 'table' },
    phone: { display: 'international' },
    search: { model: 'all-MiniLM-L6-v2' },
    hooks: {},
    mount: { default_path: join(homedir(), 'crm'), readonly: false, max_recent_activity: 10, search_limit: 20 },
  }
}

function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir)
  while (true) {
    const candidate = join(dir, 'crm.toml')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const global = join(homedir(), '.crm', 'config.toml')
  if (existsSync(global)) return global
  return null
}

function mergeConfig(base: CRMConfig, override: Record<string, any>): CRMConfig {
  const result = { ...base }
  if (override.database?.path) result.database = { ...result.database, path: override.database.path }
  if (override.pipeline?.stages) result.pipeline = { ...result.pipeline, stages: override.pipeline.stages }
  if (override.defaults?.format) result.defaults = { ...result.defaults, format: override.defaults.format }
  if (override.phone) {
    result.phone = { ...result.phone }
    if (override.phone.default_country) result.phone.default_country = override.phone.default_country
    if (override.phone.display) result.phone.display = override.phone.display
  }
  if (override.hooks) result.hooks = { ...result.hooks, ...override.hooks }
  if (override.mount) result.mount = { ...result.mount, ...override.mount }
  if (override.search) result.search = { ...result.search, ...override.search }
  return result
}

export function loadConfig(opts: { configPath?: string; dbPath?: string; format?: string }): CRMConfig {
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
      // ignore bad config
    }
  }

  // DB path resolution: --db flag > CRM_DB env > config > cwd/test.db > default
  if (opts.dbPath) {
    config.database.path = opts.dbPath
  } else if (process.env.CRM_DB) {
    config.database.path = process.env.CRM_DB
  } else if (!configPath) {
    // No config file found — use local DB in working directory
    config.database.path = join(process.cwd(), 'test.db')
  }

  // Format: --format flag > CRM_FORMAT env > config > default
  if (opts.format) {
    config.defaults.format = opts.format
  } else if (process.env.CRM_FORMAT) {
    config.defaults.format = process.env.CRM_FORMAT
  }

  return config
}
