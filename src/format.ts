import { formatPhone } from './normalize.ts'

export function formatOutput(data: any, format: string, config?: any): string {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2)
    case 'csv':
      return formatCSV(data)
    case 'tsv':
      return formatTSV(data)
    case 'ids':
      return formatIDs(data)
    case 'table':
    default:
      return formatTable(data, config)
  }
}

function formatIDs(data: any[]): string {
  if (!Array.isArray(data)) return ''
  return data.map((r) => r.id).join('\n')
}

function formatCSV(data: any[]): string {
  if (!Array.isArray(data) || data.length === 0) return ''
  const keys = Object.keys(data[0])
  const header = keys.map(csvEscape).join(',')
  const rows = data.map((row) =>
    keys.map((k) => {
      const v = row[k]
      if (Array.isArray(v)) return csvEscape(v.join(', '))
      if (v && typeof v === 'object') return csvEscape(JSON.stringify(v))
      return csvEscape(String(v ?? ''))
    }).join(','),
  )
  return [header, ...rows].join('\n')
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function formatTSV(data: any[]): string {
  if (!Array.isArray(data) || data.length === 0) return ''
  const keys = Object.keys(data[0])
  const header = keys.join('\t')
  const rows = data.map((row) =>
    keys.map((k) => {
      const v = row[k]
      if (Array.isArray(v)) return v.join(', ')
      if (v && typeof v === 'object') return JSON.stringify(v)
      return String(v ?? '')
    }).join('\t'),
  )
  return [header, ...rows].join('\n')
}

function formatTable(data: any, _config?: any): string {
  if (!data || (Array.isArray(data) && data.length === 0)) return ''
  if (!Array.isArray(data)) {
    // Single entity display
    return formatEntityDetail(data)
  }
  const keys = Object.keys(data[0])
  const widths: Record<string, number> = {}
  for (const k of keys) {
    widths[k] = k.length
  }
  for (const row of data) {
    for (const k of keys) {
      const v = displayValue(row[k])
      widths[k] = Math.max(widths[k], v.length)
    }
  }
  const header = keys.map((k) => k.padEnd(widths[k])).join('  ')
  const separator = keys.map((k) => '─'.repeat(widths[k])).join('──')
  const rows = data.map((row: any) =>
    keys.map((k) => displayValue(row[k]).padEnd(widths[k])).join('  '),
  )
  return [header, separator, ...rows].join('\n')
}

function displayValue(v: any): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function formatEntityDetail(entity: any): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(entity)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (typeof value[0] === 'object') {
        lines.push(`${key}:`)
        for (const item of value) {
          lines.push(`  ${JSON.stringify(item)}`)
        }
      } else {
        lines.push(`${key}: ${value.join(', ')}`)
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${v}`)
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  return lines.join('\n')
}

export function contactToRow(c: any, config?: any): any {
  const emails: string[] = safeJSON(c.emails)
  const phones: string[] = safeJSON(c.phones)
  const companies: string[] = safeJSON(c.companies)
  const tags: string[] = safeJSON(c.tags)
  const custom: Record<string, any> = safeJSON(c.custom_fields)
  const displayPhones = phones.map((p) => formatPhone(p, config?.phone?.display || 'international', config?.phone?.default_country))
  return {
    id: c.id,
    name: c.name,
    emails,
    phones,
    companies,
    linkedin: c.linkedin || null,
    x: c.x || null,
    bluesky: c.bluesky || null,
    telegram: c.telegram || null,
    tags,
    custom_fields: custom,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }
}

export function contactToDisplay(c: any, config?: any): any {
  const row = contactToRow(c, config)
  const phones: string[] = safeJSON(c.phones)
  row._display_phones = phones.map((p) => formatPhone(p, config?.phone?.display || 'international', config?.phone?.default_country))
  return row
}

export function companyToRow(c: any, _config?: any): any {
  return {
    id: c.id,
    name: c.name,
    websites: safeJSON(c.websites),
    phones: safeJSON(c.phones),
    tags: safeJSON(c.tags),
    custom_fields: safeJSON(c.custom_fields),
    created_at: c.created_at,
    updated_at: c.updated_at,
  }
}

export function dealToRow(d: any, _config?: any): any {
  return {
    id: d.id,
    title: d.title,
    value: d.value ?? null,
    stage: d.stage,
    contacts: safeJSON(d.contacts),
    company: d.company || null,
    expected_close: d.expected_close || null,
    probability: d.probability ?? null,
    tags: safeJSON(d.tags),
    custom_fields: safeJSON(d.custom_fields),
    created_at: d.created_at,
    updated_at: d.updated_at,
  }
}

export function activityToRow(a: any): any {
  return {
    id: a.id,
    type: a.type,
    body: a.body,
    contact: a.contact || null,
    company: a.company || null,
    deal: a.deal || null,
    custom_fields: safeJSON(a.custom_fields),
    created_at: a.created_at,
  }
}

export function safeJSON(val: any): any {
  if (val === null || val === undefined) return typeof val === 'string' ? val : (Array.isArray(val) ? [] : {})
  if (typeof val === 'string') {
    try { return JSON.parse(val) } catch { return val }
  }
  return val
}
