import { safeJSON } from './format.ts'

interface FilterCondition {
  field: string
  op: '=' | '!=' | '~=' | '>' | '<'
  value: string
}

interface FilterGroup {
  conditions: FilterCondition[]
  logic: 'AND' | 'OR'
}

export function parseFilter(expr: string): FilterGroup {
  // Split by OR first, then AND
  const orParts = expr.split(/\s+OR\s+/)
  if (orParts.length > 1) {
    const conditions: FilterCondition[] = []
    for (const part of orParts) {
      conditions.push(parseSingleCondition(part.trim()))
    }
    return { conditions, logic: 'OR' }
  }

  const andParts = expr.split(/\s+AND\s+/)
  const conditions: FilterCondition[] = andParts.map((p) =>
    parseSingleCondition(p.trim()),
  )
  return { conditions, logic: 'AND' }
}

function parseSingleCondition(expr: string): FilterCondition {
  // Try ~= first (before = to avoid partial match)
  const match = expr.match(/^([^!~<>=]+)(~=|!=|>=|<=|>|<|=)(.*)$/)
  if (match) {
    return {
      field: match[1].trim(),
      op: match[2] as FilterCondition['op'],
      value: match[3].trim(),
    }
  }
  throw new Error(`Invalid filter expression: ${expr}`)
}

export function applyFilter(row: any, filter: FilterGroup): boolean {
  if (filter.logic === 'AND') {
    return filter.conditions.every((c) => matchCondition(row, c))
  }
  return filter.conditions.some((c) => matchCondition(row, c))
}

function matchCondition(row: any, condition: FilterCondition): boolean {
  const { field, op, value } = condition
  let fieldValue = row[field]

  // Check in custom_fields if not found on top level
  if (fieldValue === undefined || fieldValue === null) {
    const custom =
      typeof row.custom_fields === 'string'
        ? safeJSON(row.custom_fields)
        : row.custom_fields || {}
    fieldValue = custom[field]
  }

  if (fieldValue === undefined || fieldValue === null) {
    if (op === '!=') {
      return true
    }
    return false
  }

  const strVal = String(fieldValue)

  switch (op) {
    case '=':
      return strVal === value
    case '!=':
      return strVal !== value
    case '~=':
      return strVal.toLowerCase().includes(value.toLowerCase())
    case '>':
      return Number(strVal) > Number(value)
    case '<':
      return Number(strVal) < Number(value)
    default:
      return false
  }
}
