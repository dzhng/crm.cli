import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js'
import normalizeUrl from 'normalize-url'

// ── Phone normalization ──

export function normalizePhone(input: string, defaultCountry?: string): string {
  const cleaned = input.trim()
  const country = defaultCountry as CountryCode | undefined
  let phone = parsePhoneNumberFromString(cleaned, country)
  if (!(phone || cleaned.startsWith('+') || country)) {
    // Try US as fallback for formatted numbers like (212) 555-1234
    phone = parsePhoneNumberFromString(cleaned, 'US')
    if (phone?.isValid()) {
      // Only use US fallback if it parses as valid
      // But we need to be strict: without explicit default_country, only accept if the input had formatting hints
      const hasFormatting = /[()\-\s]/.test(cleaned)
      if (!hasFormatting) {
        throw new Error(
          `Invalid phone number: "${input}". No country code provided — set phone.default_country in config or prefix with +`,
        )
      }
    }
  }
  if (!phone) {
    if (!(defaultCountry || cleaned.startsWith('+'))) {
      throw new Error(
        `Invalid phone number: "${input}". No country code provided — set phone.default_country in config or prefix with +`,
      )
    }
    throw new Error(`Invalid phone number: "${input}"`)
  }
  if (!phone.isValid()) {
    throw new Error(`Invalid phone number: "${input}"`)
  }
  return phone.format('E.164')
}

export function formatPhone(
  e164: string,
  display: string,
  _defaultCountry?: string,
): string {
  const phone = parsePhoneNumberFromString(e164)
  if (!phone) {
    return e164
  }
  switch (display) {
    case 'e164':
      return phone.format('E.164')
    case 'national':
      return phone.formatNational()
    default:
      return phone.formatInternational()
  }
}

export function tryNormalizePhone(
  input: string,
  defaultCountry?: string,
): string | null {
  try {
    return normalizePhone(input, defaultCountry)
  } catch {
    return null
  }
}

export function extractPhoneDigits(input: string): string {
  return input.replace(/[^\d]/g, '')
}

export function phoneMatchesByDigits(e164: string, digits: string): boolean {
  const stored = extractPhoneDigits(e164)
  return stored.endsWith(digits) || digits.endsWith(stored)
}

// ── Website normalization ──

const NORMALIZE_URL_OPTS = {
  stripProtocol: true,
  stripHash: true,
  removeQueryParameters: true,
  stripWWW: true,
  removeSingleSlash: true,
  sortQueryParameters: false,
}

export function normalizeWebsite(input: string): string {
  return normalizeUrl(input.trim(), NORMALIZE_URL_OPTS)
}

export function tryNormalizeWebsite(input: string): string | null {
  try {
    return normalizeUrl(input.trim(), NORMALIZE_URL_OPTS)
  } catch {
    return null
  }
}

// ── Social handle normalization ──

const SOCIAL_PATTERNS: Record<string, RegExp[]> = {
  linkedin: [/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([^/?#]+)\/?/i],
  x: [/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)\/?/i],
  bluesky: [/(?:https?:\/\/)?(?:www\.)?bsky\.app\/profile\/([^/?#]+)\/?/i],
  telegram: [/(?:https?:\/\/)?(?:www\.)?t\.me\/([^/?#]+)\/?/i],
}

export function normalizeSocialHandle(platform: string, input: string): string {
  const trimmed = input.trim()
  const patterns = SOCIAL_PATTERNS[platform]
  if (patterns) {
    for (const pattern of patterns) {
      const match = trimmed.match(pattern)
      if (match) {
        return match[1]
      }
    }
  }
  // Strip leading @
  if (trimmed.startsWith('@')) {
    return trimmed.slice(1)
  }
  return trimmed
}

export function tryExtractSocialHandle(
  input: string,
): { platform: string; handle: string } | null {
  for (const [platform, patterns] of Object.entries(SOCIAL_PATTERNS)) {
    for (const pattern of patterns) {
      const match = input.match(pattern)
      if (match) {
        return { platform, handle: match[1] }
      }
    }
  }
  return null
}
