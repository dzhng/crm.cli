import type { Command } from 'commander'
import { getCtx, levenshtein } from '../lib/helpers'
import { formatOutput, contactToRow, companyToRow, safeJSON } from '../format'

export function registerDupesCommand(program: Command) {
  program.command('dupes')
    .description('Find likely duplicates')
    .option('--type <type>', 'Entity type (contact or company)')
    .option('--threshold <n>', 'Similarity threshold 0-1', '0.3')
    .option('--limit <n>', 'Max results')
    .action((opts) => {
      const { db, config, fmt } = getCtx()
      const threshold = Number(opts.threshold)
      let results: any[] = []

      if (!opts.type || opts.type === 'contact') {
        const contacts = db.query('SELECT * FROM contacts').all() as any[]
        for (let i = 0; i < contacts.length; i++) {
          for (let j = i + 1; j < contacts.length; j++) {
            const reasons = contactDupeReasons(contacts[i], contacts[j])
            const score = dupeScore(reasons)
            if (score >= threshold) {
              results.push({
                left: contactToRow(contacts[i], config),
                right: contactToRow(contacts[j], config),
                reasons,
                score,
              })
            }
          }
        }
      }

      if (!opts.type || opts.type === 'company') {
        const companies = db.query('SELECT * FROM companies').all() as any[]
        for (let i = 0; i < companies.length; i++) {
          for (let j = i + 1; j < companies.length; j++) {
            const reasons = companyDupeReasons(companies[i], companies[j])
            const score = dupeScore(reasons)
            if (score >= threshold) {
              results.push({
                left: companyToRow(companies[i], config),
                right: companyToRow(companies[j], config),
                reasons,
                score,
              })
            }
          }
        }
      }

      results.sort((a, b) => b.score - a.score)
      if (opts.limit) results = results.slice(0, Number(opts.limit))

      if (fmt === 'json') {
        console.log(JSON.stringify(results.map(r => ({ left: r.left, right: r.right, reasons: r.reasons })), null, 2))
      } else {
        if (results.length === 0) { console.log(''); return }
        const lines = results.map(r => {
          const lName = r.left.name || r.left.title || r.left.id
          const rName = r.right.name || r.right.title || r.right.id
          return `${lName} <-> ${rName}: ${r.reasons.join(', ')}`
        })
        console.log(lines.join('\n'))
      }
    })
}

function contactDupeReasons(a: any, b: any): string[] {
  const reasons: string[] = []
  const aName = (a.name || '').toLowerCase()
  const bName = (b.name || '').toLowerCase()
  const nameDistance = levenshtein(aName, bName)
  const maxLen = Math.max(aName.length, bName.length)
  const nameSimilarity = maxLen > 0 ? 1 - nameDistance / maxLen : 0

  if (nameSimilarity >= 0.5) reasons.push('similar name')

  const aEmails: string[] = safeJSON(a.emails)
  const bEmails: string[] = safeJSON(b.emails)
  for (const ae of aEmails) {
    for (const be of bEmails) {
      if (ae.toLowerCase() === be.toLowerCase()) reasons.push('same email')
    }
  }

  const aPhones: string[] = safeJSON(a.phones)
  const bPhones: string[] = safeJSON(b.phones)
  for (const ap of aPhones) {
    for (const bp of bPhones) {
      if (ap === bp) reasons.push('same phone')
    }
  }

  const aCompanies: string[] = safeJSON(a.companies)
  const bCompanies: string[] = safeJSON(b.companies)
  for (const ac of aCompanies) {
    for (const bc of bCompanies) {
      if (ac.toLowerCase() === bc.toLowerCase()) {
        reasons.push('same company')
        break
      }
    }
  }

  // Similar social handles
  for (const field of ['linkedin', 'x', 'bluesky', 'telegram']) {
    if (a[field] && b[field]) {
      const dist = levenshtein(a[field].toLowerCase(), b[field].toLowerCase())
      const ml = Math.max(a[field].length, b[field].length)
      if (ml > 0 && 1 - dist / ml >= 0.6) reasons.push(`similar ${field}`)
    }
  }

  // Shared email domain + similar name
  if (nameSimilarity >= 0.3) {
    let found = false
    for (const ae of aEmails) {
      if (found) break
      for (const be of bEmails) {
        const aDomain = ae.split('@')[1]?.toLowerCase()
        const bDomain = be.split('@')[1]?.toLowerCase()
        if (aDomain && bDomain && aDomain === bDomain && !['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].includes(aDomain)) {
          reasons.push('shared email domain')
          found = true
          break
        }
      }
    }
  }

  return reasons
}

function companyDupeReasons(a: any, b: any): string[] {
  const reasons: string[] = []
  const aName = (a.name || '').toLowerCase()
  const bName = (b.name || '').toLowerCase()
  const nameDistance = levenshtein(aName, bName)
  const maxLen = Math.max(aName.length, bName.length)
  const nameSimilarity = maxLen > 0 ? 1 - nameDistance / maxLen : 0
  if (nameSimilarity >= 0.5) reasons.push('similar name')

  const aWebsites: string[] = safeJSON(a.websites)
  const bWebsites: string[] = safeJSON(b.websites)
  for (const aw of aWebsites) {
    for (const bw of bWebsites) {
      const aDomain = aw.split('/')[0]
      const bDomain = bw.split('/')[0]
      if (aDomain === bDomain) reasons.push('same domain')
    }
  }

  return reasons
}

function dupeScore(reasons: string[]): number {
  if (reasons.length === 0) return 0
  let score = 0
  for (const r of reasons) {
    if (r === 'same email' || r === 'same phone') score += 0.5
    else if (r === 'similar name') score += 0.4
    else if (r === 'same company') score += 0.15
    else if (r.startsWith('similar ')) score += 0.2
    else if (r === 'same domain') score += 0.2
    else if (r === 'shared email domain') score += 0.15
    else score += 0.1
  }
  return Math.min(score, 1)
}
