// Apollo source handler for prospect research agent v2.
// Extracted from v1 prospect-research-agent.ts with minimal changes.
// Returns available: false (not an error) when APOLLO_API_KEY is not set —
// the orchestrator treats this as a skipped source, not a failure.
// Returns available: false with error when the API call itself fails.

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

    if (response.status === 429) {
      return { available: false, formatted: null, raw: null, error: 'Apollo rate limit (429)' }
    }
    if (!response.ok) {
      return { available: false, formatted: null, raw: null, error: `Apollo API error: ${response.status}` }
    }

    const data = await response.json() as ApolloResponse
    if (!data.person) {
      return { available: false, formatted: null, raw: null, error: 'Apollo returned no person record' }
    }

    const p = data.person
    const org = p.organization
    const lines: string[] = []

    if (p.title)              lines.push(`Current title: ${p.title}`)
    if (p.seniority)          lines.push(`Seniority: ${p.seniority}`)
    if (p.departments?.length) lines.push(`Department: ${p.departments.join(', ')}`)

    if (p.employment_history?.length) {
      const sorted = [...p.employment_history].sort((a, b) => {
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
      if (org.job_postings?.length) {
        lines.push(`Active job postings (${org.job_postings.length}):`)
        org.job_postings.slice(0, 5).forEach(j => {
          if (j.title) lines.push(`  - ${j.title}`)
        })
      }
    }

    if (!lines.length) {
      return { available: false, formatted: null, raw: null, error: 'Apollo returned empty person data' }
    }

    const formatted = lines.join('\n')
    logger.debug('research/apollo: succeeded', { lines: lines.length })
    return { available: true, formatted, raw: data.person as Record<string, unknown> }

  } catch (err) {
    logger.warn('research/apollo: fetch failed', { error: String(err) })
    return { available: false, formatted: null, raw: null, error: String(err) }
  }
}
