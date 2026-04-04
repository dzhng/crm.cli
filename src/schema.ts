import { z } from 'zod'
import { normalizePhone, normalizeWebsite, normalizeSocialHandle } from './normalize'

// ── Reusable transforms ──

/** Zod transform that normalizes a phone string via libphonenumber-js. */
export const phoneTransform = (defaultCountry?: string) =>
  z.string().transform((val, ctx) => {
    try {
      return normalizePhone(val, defaultCountry)
    } catch (e: any) {
      ctx.addIssue({ code: 'custom', message: e.message })
      return val
    }
  })

/** Zod transform that normalizes a website URL. */
export const websiteTransform = z.string().transform((val, ctx) => {
  try {
    return normalizeWebsite(val)
  } catch (e: any) {
    ctx.addIssue({ code: 'custom', message: `Invalid website: ${val}` })
    return val
  }
})

/** Zod transform for social handles. */
export const socialHandleSchema = (platform: string) =>
  z.string().transform(val => normalizeSocialHandle(platform, val))

// ── Contact schemas ──

export const contactAddSchema = (defaultCountry?: string) =>
  z.object({
    name: z.string().min(1, 'Contact name is required'),
    email: z.array(z.string().email('Invalid email format')).default([]),
    phone: z.array(phoneTransform(defaultCountry)).default([]),
    company: z.array(z.string()).default([]),
    tag: z.array(z.string()).default([]),
    linkedin: z.string().transform(val => normalizeSocialHandle('linkedin', val)).optional(),
    x: z.string().transform(val => normalizeSocialHandle('x', val)).optional(),
    bluesky: z.string().transform(val => normalizeSocialHandle('bluesky', val)).optional(),
    telegram: z.string().transform(val => normalizeSocialHandle('telegram', val)).optional(),
    set: z.array(z.string()).default([]),
  })

export const contactEditSchema = (defaultCountry?: string) =>
  z.object({
    name: z.string().min(1).optional(),
    addEmail: z.array(z.string().email('Invalid email format')).default([]),
    rmEmail: z.array(z.string()).default([]),
    addPhone: z.array(phoneTransform(defaultCountry)).default([]),
    rmPhone: z.array(z.string()).default([]),
    addCompany: z.array(z.string()).default([]),
    rmCompany: z.array(z.string()).default([]),
    addTag: z.array(z.string()).default([]),
    rmTag: z.array(z.string()).default([]),
    linkedin: z.string().transform(val => normalizeSocialHandle('linkedin', val)).optional(),
    x: z.string().transform(val => normalizeSocialHandle('x', val)).optional(),
    bluesky: z.string().transform(val => normalizeSocialHandle('bluesky', val)).optional(),
    telegram: z.string().transform(val => normalizeSocialHandle('telegram', val)).optional(),
    set: z.array(z.string()).default([]),
    unset: z.array(z.string()).default([]),
  })

// ── Company schemas ──

export const companyAddSchema = (defaultCountry?: string) =>
  z.object({
    name: z.string().min(1, 'Company name is required'),
    website: z.array(websiteTransform).default([]),
    phone: z.array(phoneTransform(defaultCountry)).default([]),
    tag: z.array(z.string()).default([]),
    set: z.array(z.string()).default([]),
  })

export const companyEditSchema = (defaultCountry?: string) =>
  z.object({
    name: z.string().min(1).optional(),
    addWebsite: z.array(websiteTransform).default([]),
    rmWebsite: z.array(z.string()).default([]),
    addPhone: z.array(phoneTransform(defaultCountry)).default([]),
    rmPhone: z.array(z.string()).default([]),
    addTag: z.array(z.string()).default([]),
    rmTag: z.array(z.string()).default([]),
    set: z.array(z.string()).default([]),
    unset: z.array(z.string()).default([]),
  })

// ── Deal schemas ──

export const dealAddSchema = (validStages: string[]) =>
  z.object({
    title: z.string().min(1, 'Deal title is required'),
    value: z.string().transform(Number).pipe(z.number().nonnegative('Value must be non-negative')).optional(),
    stage: z.string().refine(s => validStages.includes(s), s => ({ message: `Invalid stage "${s}"` })).optional(),
    contact: z.array(z.string()).default([]),
    company: z.string().optional(),
    expectedClose: z.string().refine(s => !isNaN(new Date(s).getTime()), 'Invalid expected-close date').optional(),
    probability: z.string().transform(Number).pipe(z.number().min(0).max(100, 'Probability must be between 0 and 100')).optional(),
    tag: z.array(z.string()).default([]),
    set: z.array(z.string()).default([]),
  })

export const dealEditSchema = z.object({
  title: z.string().min(1).optional(),
  value: z.string().transform(Number).pipe(z.number().nonnegative('Value must be non-negative')).optional(),
  addContact: z.array(z.string()).default([]),
  rmContact: z.array(z.string()).default([]),
  addTag: z.array(z.string()).default([]),
  rmTag: z.array(z.string()).default([]),
  set: z.array(z.string()).default([]),
  unset: z.array(z.string()).default([]),
})

// ── Import row schemas ──

export const importContactRowSchema = z.object({
  name: z.string().min(1, 'Row missing name'),
}).passthrough()

export const importCompanyRowSchema = z.object({
  name: z.string().min(1, 'Company missing name'),
}).passthrough()

export const importDealRowSchema = z.object({
  title: z.string().min(1, 'Deal missing title'),
}).passthrough()

// ── Config file schema ──

export const configSchema = z.object({
  database: z.object({ path: z.string() }).optional(),
  pipeline: z.object({ stages: z.array(z.string().min(1)) }).optional(),
  defaults: z.object({ format: z.enum(['table', 'json', 'csv']) }).optional(),
  phone: z.object({
    default_country: z.string().max(2).optional(),
    display: z.enum(['e164', 'international', 'national']).optional(),
  }).optional(),
  search: z.object({ model: z.string() }).optional(),
  hooks: z.record(z.string(), z.string()).optional(),
  mount: z.object({
    default_path: z.string().optional(),
    readonly: z.boolean().optional(),
    max_recent_activity: z.number().int().positive().optional(),
    search_limit: z.number().int().positive().optional(),
  }).optional(),
}).passthrough()

// ── Helper to format Zod errors for CLI output ──

export function formatZodError(error: z.ZodError): string {
  return error.issues.map(issue => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    return `${path}${issue.message}`
  }).join('; ')
}
