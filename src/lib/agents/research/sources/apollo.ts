// Apollo source handler for prospect research agent v2.
// Extracted from v1 prospect-research-agent.ts with minimal changes.
// Returns available: false (not an error) when APOLLO_API_KEY is not set —
// the orchestrator treats this as a skipped source, not a failure.
// Returns available: false with error when the API call itself fails.

import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import type { ProspectContext, ApolloSourceResult } from '../types'

interface ApolloEmployment {
  title?: string
  organization_name?: string
  start_date?: string
  end_date?: string
  current?: boolean
}

interface ApolloOrganization {
  estimated_num_employees?: number
  industry?: string
  short_description?: string
  job_postings?: Array<{ title?: string }>
}

interface ApolloPerson {
  title?: string
  seniority?: string
  departments?: string[]
  employment_history?: ApolloEmployment[]
  organization?: ApolloOrganization
}

interface ApolloResponse {
  person?: ApolloPerson
}

/**
 * Format an Apollo person object into the lines the synthesis prompt reads.
 *
 * Extracted 2026-08-24 so the SAME formatting serves both the stored enrichment subset
 * and a live fallback call. Two copies would drift, and the synthesis prompt would then
 * see different shapes depending on which path produced them.
 */
export function formatApolloLines(p: Record<string, any>): string | null {
  const org = p.organization as Record<string, any> | undefined
  const lines: string[] = []

  if (p.title)               lines.push(`Current title: ${p.title}`)
  if (p.seniority)           lines.push(`Seniority: ${p.seniority}`)
  if (p.departments?.length) lines.push(`Department: ${p.departments.join(', ')}`)
  if (p.headline)            lines.push(`Headline: ${p.headline}`)

  if (p.employment_history?.length) {
    const sorted = [...p.employment_history].sort((a: any, b: any) => {
      const da = a.start_date ? new Date(a.start_date).getTime() : 0
      const db = b.start_date ? new Date(b.start_date).getTime() : 0
      return db - da
    })
    lines.push('Recent employment history:')
    for (const job of sorted.slice(0, 3)) {
      const since = job.start_date ? ` (since ${job.start_date})` : ''
      const until = job.end_date ? ` to ${job.end_date}` : job.current ? ' – present' : ''
      lines.push(`  - ${job.title ?? 'Unknown title'} at ${job.organization_name ?? 'Unknown'}${since}${until}`)
    }
  }

  if (org) {
    if (org.estimated_num_employees) lines.push(`Company headcount: ~${org.estimated_num_employees}`)
    if (org.industry)                lines.push(`Industry: ${org.industry}`)
    if (org.short_description)       lines.push(`Company description: ${org.short_description}`)
    if (org.founded_year)            lines.push(`Founded: ${org.founded_year}`)
    // Growth is a dateable-shaped signal and we were already paying for it.
    const g12 = org.organization_headcount_twelve_month_growth
    if (typeof g12 === 'number') lines.push(`Headcount growth, 12 months: ${g12}%`)
    if (org.job_postings?.length) {
      lines.push(`Active job postings (${org.job_postings.length}):`)
      org.job_postings.slice(0, 5).forEach((j: any) => { if (j.title) lines.push(`  - ${j.title}`) })
    }
  }

  return lines.length ? lines.join('\n') : null
}

/**
 * Apollo data from the prospect row, when enrichment already bought it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: WE WERE BUYING THE SAME PERSON TWICE.
 *
 * Enrichment calls bulk_match and pays a credit. It then parsed 13 of the 72 fields the
 * response carries and discarded the rest, including employment_history. Research then
 * called people/match for the same person and paid AGAIN, largely to get that field back.
 *
 * Measured on live data: employment_history produces 38 of research's 40 winning Apollo
 * candidates, and Apollo is the highest-performing source in the system at 40 of 92 wins
 * against Apify's 8. So the call could not simply be removed. It had to be SERVED FROM
 * THE ROW instead.
 *
 * Roughly 113 duplicate paid calls per 244 researched prospects.
 *
 * Returns null when nothing is stored, and the caller falls back to the live call.
 */
export function apolloSourceFromRow(
  stored: Record<string, any> | null | undefined,
): ApolloSourceResult | null {
  if (!stored || typeof stored !== 'object') return null
  const formatted = formatApolloLines(stored)
  if (!formatted) return null
  return { available: true, formatted, raw: stored }
}

export async function fetchApolloSource(prospect: ProspectContext): Promise<ApolloSourceResult> {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) {
    return { available: false, formatted: null, raw: null, error: 'APOLLO_API_KEY not set' }
  }

  const body: Record<string, unknown> = {
    reveal_personal_emails: false,
    reveal_phone_number: false,
  }
  if (prospect.first_name)   body.first_name      = prospect.first_name
  if (prospect.last_name)    body.last_name       = prospect.last_name
  if (prospect.company_name) body.organization_name = prospect.company_name
  if (prospect.linkedin_url) body.linkedin_url    = prospect.linkedin_url

  try {
    const response = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })

    if (response.status === 401) {
      // API key invalid or not configured — alert operator; this won't self-resolve.
      logger.warn('research/apollo: API key invalid or not configured (401)')
      Sentry.captureException(
        new Error('Apollo 401: API key invalid or not configured — verify APOLLO_API_KEY in integration_credentials'),
        { level: 'warning' }
      )
      return { available: false, formatted: null, raw: null, error: 'Apollo API key invalid (401)' }
    }

    if (response.status === 403) {
      // Free tier or insufficient scope — expected when plan doesn't include enrichment.
      // No Sentry alert: this is an anticipated state, not an error.
      logger.info('research/apollo: access denied (403) — free tier or insufficient scope; continuing without Apollo data')
      return { available: false, formatted: null, raw: null, error: 'Apollo access denied (403)' }
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      logger.info('research/apollo: rate limited (429)', { retry_after: retryAfter ?? 'unknown' })
      return {
        available: false,
        formatted: null,
        raw: null,
        error: retryAfter
          ? `Apollo rate limited (429) — retry after ${retryAfter}s`
          : 'Apollo rate limited (429)',
      }
    }

    if (response.status >= 500) {
      // Transient outage — alert operator; may self-resolve.
      logger.warn('research/apollo: transient outage', { status: response.status })
      Sentry.captureException(
        new Error(`Apollo ${response.status}: transient outage`),
        { level: 'warning' }
      )
      return { available: false, formatted: null, raw: null, error: `Apollo transient outage (${response.status})` }
    }

    if (!response.ok) {
      logger.warn('research/apollo: unexpected error', { status: response.status })
      return { available: false, formatted: null, raw: null, error: `Apollo unexpected error (${response.status})` }
    }

    const data = await response.json() as ApolloResponse
    if (!data.person) {
      return { available: false, formatted: null, raw: null, error: 'Apollo returned no person record' }
    }

    const formatted = formatApolloLines(data.person as Record<string, any>)
    if (!formatted) {
      return { available: false, formatted: null, raw: null, error: 'Apollo returned empty person data' }
    }

    logger.debug('research/apollo: succeeded via LIVE CALL (no stored enrichment)')
    return { available: true, formatted, raw: data.person as Record<string, unknown> }

  } catch (err) {
    logger.warn('research/apollo: fetch failed', { error: String(err) })
    return { available: false, formatted: null, raw: null, error: String(err) }
  }
}
