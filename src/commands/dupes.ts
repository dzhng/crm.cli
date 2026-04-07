import type { Command } from 'commander'

import type { Company, Contact } from '../drizzle-schema'
import * as schema from '../drizzle-schema'
import { companyToRow, contactToRow, safeJSON } from '../format'
import { diceCoefficient, getCtx, levenshtein } from '../lib/helpers'

interface DupeResult {
  left: Record<string, unknown>
  reasons: string[]
  right: Record<string, unknown>
  score: number
}

export function registerDupesCommand(program: Command) {
  program
    .command('dupes')
    .description('Find likely duplicates')
    .option('--type <type>', 'Entity type (contact or company)')
    .option('--threshold <n>', 'Similarity threshold 0-1', '0.3')
    .option('--limit <n>', 'Max results')
    .action(async (opts) => {
      const { db, fmt } = await getCtx()
      const threshold = Number(opts.threshold)
      let results: DupeResult[] = []

      if (!opts.type || opts.type === 'contact') {
        const contacts = await db.select().from(schema.contacts)
        for (let i = 0; i < contacts.length; i++) {
          for (let j = i + 1; j < contacts.length; j++) {
            const reasons = contactDupeReasons(contacts[i], contacts[j])
            const score = dupeScore(reasons)
            if (score >= threshold) {
              results.push({
                left: contactToRow(contacts[i]),
                right: contactToRow(contacts[j]),
                reasons,
                score,
              })
            }
          }
        }
      }

      if (!opts.type || opts.type === 'company') {
        const companies = await db.select().from(schema.companies)
        for (let i = 0; i < companies.length; i++) {
          for (let j = i + 1; j < companies.length; j++) {
            const reasons = companyDupeReasons(companies[i], companies[j])
            const score = dupeScore(reasons)
            if (score >= threshold) {
              results.push({
                left: companyToRow(companies[i]),
                right: companyToRow(companies[j]),
                reasons,
                score,
              })
            }
          }
        }
      }

      results.sort((a, b) => b.score - a.score)
      if (opts.limit) {
        results = results.slice(0, Number(opts.limit))
      }

      if (fmt === 'json') {
        console.log(
          JSON.stringify(
            results.map((r) => ({
              left: r.left,
              right: r.right,
              reasons: r.reasons,
            })),
            null,
            2,
          ),
        )
      } else {
        if (results.length === 0) {
          console.log('')
          return
        }
        const lines = results.map((r) => {
          const lName = r.left.name || r.left.title || r.left.id
          const rName = r.right.name || r.right.title || r.right.id
          return `${lName} <-> ${rName}: ${r.reasons.join(', ')}`
        })
        console.log(lines.join('\n'))
      }
    })
}

type SocialField = 'linkedin' | 'x' | 'bluesky' | 'telegram'

function contactDupeReasons(a: Contact, b: Contact): string[] {
  const reasons: string[] = []
  const aName = (a.name || '').toLowerCase()
  const bName = (b.name || '').toLowerCase()
  const nameDistance = levenshtein(aName, bName)
  const maxLen = Math.max(aName.length, bName.length)
  const levSimilarity = maxLen > 0 ? 1 - nameDistance / maxLen : 0
  // Dice coefficient catches prefix/suffix/containment cases that Levenshtein
  // misses (e.g. "Acme" vs "Acme Inc"). Use the max of both metrics.
  const nameSimilarity = Math.max(levSimilarity, diceCoefficient(aName, bName))

  if (nameSimilarity >= 0.6) {
    reasons.push('similar name')
  }

  const aEmails: string[] = safeJSON(a.emails)
  const bEmails: string[] = safeJSON(b.emails)
  for (const ae of aEmails) {
    for (const be of bEmails) {
      if (ae.toLowerCase() === be.toLowerCase()) {
        reasons.push('same email')
      }
    }
  }

  const aPhones: string[] = safeJSON(a.phones)
  const bPhones: string[] = safeJSON(b.phones)
  for (const ap of aPhones) {
    for (const bp of bPhones) {
      if (ap === bp) {
        reasons.push('same phone')
      }
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
  const socialFields: SocialField[] = ['linkedin', 'x', 'bluesky', 'telegram']
  for (const field of socialFields) {
    if (a[field] && b[field]) {
      const aVal = a[field] as string
      const bVal = b[field] as string
      const dist = levenshtein(aVal.toLowerCase(), bVal.toLowerCase())
      const ml = Math.max(aVal.length, bVal.length)
      if (ml > 0 && 1 - dist / ml >= 0.6) {
        reasons.push(`similar ${field}`)
      }
    }
  }

  // Shared email domain + similar name
  if (nameSimilarity >= 0.3) {
    let found = false
    for (const ae of aEmails) {
      if (found) {
        break
      }
      for (const be of bEmails) {
        const aDomain = ae.split('@')[1]?.toLowerCase()
        const bDomain = be.split('@')[1]?.toLowerCase()
        if (
          aDomain &&
          bDomain &&
          aDomain === bDomain &&
          !['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].includes(
            aDomain,
          )
        ) {
          reasons.push('shared email domain')
          found = true
          break
        }
      }
    }
  }

  return reasons
}

function companyDupeReasons(a: Company, b: Company): string[] {
  const reasons: string[] = []
  const aName = (a.name || '').toLowerCase()
  const bName = (b.name || '').toLowerCase()
  const nameDistance = levenshtein(aName, bName)
  const maxLen = Math.max(aName.length, bName.length)
  const levSimilarity = maxLen > 0 ? 1 - nameDistance / maxLen : 0
  const nameSimilarity = Math.max(levSimilarity, diceCoefficient(aName, bName))
  if (nameSimilarity >= 0.6) {
    reasons.push('similar name')
  }

  const aWebsites: string[] = safeJSON(a.websites)
  const bWebsites: string[] = safeJSON(b.websites)
  for (const aw of aWebsites) {
    for (const bw of bWebsites) {
      const aDomain = aw.split('/')[0]
      const bDomain = bw.split('/')[0]
      if (aDomain === bDomain) {
        reasons.push('same domain')
      }
    }
  }

  return reasons
}

function dupeScore(reasons: string[]): number {
  if (reasons.length === 0) {
    return 0
  }
  let score = 0
  for (const r of reasons) {
    if (r === 'same email' || r === 'same phone') {
      score += 0.5
    } else if (r === 'similar name') {
      score += 0.4
    } else if (r === 'same company') {
      score += 0.15
    } else if (r.startsWith('similar ')) {
      score += 0.2
    } else if (r === 'same domain') {
      score += 0.2
    } else if (r === 'shared email domain') {
      score += 0.15
    } else {
      score += 0.1
    }
  }
  return Math.min(score, 1)
}
