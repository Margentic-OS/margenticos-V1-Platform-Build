// src/lib/sourcing/handlers/adapter-apollo.ts
//
// Apollo people-search sourcing handler.
// Endpoint: POST https://api.apollo.io/api/v1/mixed_people/api_search
// Credentials: x-api-key header (APOLLO_API_KEY env var)
// Rate limit: 600 calls/hour
// Credits consumed: None (People API Search is free, plan-gated above free tier)
//
// Handler workflow:
//   1. adapter(): Translate ICPFilterSpec to Apollo api_search request parameters
//   2. execute(): Call Apollo, paginate results, return ProspectCandidate array
//   3. Post-filter: Drop candidates by job_titles_excluded and keywords_excluded

import { logger } from '@/lib/logger'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { normaliseLinkedInUrl } from '@/lib/sourcing/normalise-linkedin'
import type { ProspectCandidate } from '@/lib/sourcing/dedupe'

// ─── Seniority mapping: ICPFilterSpec → Apollo enum ──────────────────────────
// Critical: when spec requests c_suite, Apollo request includes owner + founder
// because Apollo separates these and our ICP targets founder-led firms where
// owner/founder is the primary decision-maker.

const SENIORITY_MAP: Record<ICPFilterSpec['seniority_levels'][number], string[]> = {
  c_suite: ['owner', 'founder', 'c_suite'],  // Decision-maker in founder-led firms
  vp: ['vp', 'partner'],                      // Partner maps to VP-level authority
  director: ['director', 'head'],             // Head = director-level
  manager: ['manager'],
  senior: ['senior'],
  entry: ['entry'],
}

// Reverse map: which Apollo seniorities we support
const SUPPORTED_APOLLO_SENIORITIES = new Set([
  'owner', 'founder', 'c_suite', 'partner', 'vp', 'head',
  'director', 'manager', 'senior', 'entry', 'intern',
])

interface ApolloApiSearchRequest {
  person_titles?: string[]
  include_similar_titles?: boolean
  q_keywords?: string
  person_locations?: string[]
  person_seniorities?: string[]
  organization_locations?: string[]
  organization_num_employees_ranges?: string[]
  revenue_range?: { min?: number; max?: number }
  contact_email_status?: string[]
  page?: number
  per_page?: number
}

interface ApolloApiSearchResponse {
  data: {
    id: string
    first_name: string
    last_name_obfuscated: string
    title?: string | null
    last_refreshed_at?: string
    has_email?: boolean
    has_city?: boolean
    has_state?: boolean
    has_country?: boolean
    has_direct_phone?: string
    organization?: {
      name: string
      has_industry?: boolean
      has_phone?: boolean
      has_city?: boolean
      has_state?: boolean
      has_country?: boolean
      has_zip_code?: boolean
      has_revenue?: boolean
      has_employee_count?: boolean
    }
  }[]
  pagination: {
    page: number
    per_page: number
    total_entries: number
  }
}

export const apolloHandler = {
  name: 'Apollo',

  // Supported fields: what this handler can genuinely apply as filters.
  // Note: job_titles_excluded and keywords_excluded are satisfied via post-filtering,
  // not API parameters, but the handler satisfies them so they're listed here.
  // technologies_used is supported by Apollo via tech UIDs but requires external
  // CSV mapping (deferred); omitted from supported_fields so unsupported specs fail loudly.
  supported_fields: [
    'job_titles',
    'job_titles_excluded',
    'seniority_levels',
    'person_countries',
    'company_countries',
    'company_headcount_min',
    'company_headcount_max',
    'industries',
    'industries_excluded',
    'keywords',
    'keywords_excluded',
    'company_revenue_min',
    'company_revenue_max',
  ],

  // Adapter: translate ICPFilterSpec → Apollo api_search request
  adapter: (spec: Record<string, unknown>): ApolloApiSearchRequest => {
    const request: ApolloApiSearchRequest = {}

    // Person titles
    const jobTitles = spec.job_titles as string[] | undefined
    if (jobTitles?.length) {
      request.person_titles = jobTitles
    }

    // Seniority: expand c_suite to include owner + founder (founder-led firm decision-makers)
    const seniorityLevels = spec.seniority_levels as ICPFilterSpec['seniority_levels'] | undefined
    if (seniorityLevels?.length) {
      const seniorities = new Set<string>()
      for (const level of seniorityLevels) {
        const mapped = SENIORITY_MAP[level]
        if (mapped) {
          mapped.forEach(s => seniorities.add(s))
        } else {
          logger.warn('Apollo adapter: unknown seniority level, dropping', {
            seniority: level,
            known_levels: Object.keys(SENIORITY_MAP),
          })
        }
      }
      if (seniorities.size > 0) {
        request.person_seniorities = Array.from(seniorities)
      }
    }

    // Person countries (ISO-3166 alpha-2 → Apollo locations)
    const personCountries = spec.person_countries as string[] | undefined
    if (personCountries?.length) {
      request.person_locations = personCountries
    }

    // Company countries
    const companyCountries = spec.company_countries as string[] | undefined
    if (companyCountries?.length) {
      request.organization_locations = companyCountries
    }

    // Company headcount range: fold min/max into single range string "min,max"
    const headcountMin = spec.company_headcount_min as number | undefined
    const headcountMax = spec.company_headcount_max as number | undefined
    if (headcountMin !== undefined || headcountMax !== undefined) {
      const min = headcountMin ?? 1
      const max = headcountMax ?? 10000
      request.organization_num_employees_ranges = [`${min},${max}`]
    }

    // Keywords: merge industries (as keywords), keywords, excluding excluded keywords
    const industries = spec.industries as string[] | undefined
    const keywords = spec.keywords as string[] | undefined
    const allKeywords = [
      ...(industries?.map(ind => ind.toLowerCase()) ?? []),
      ...(keywords ?? []),
    ]
    if (allKeywords.length) {
      request.q_keywords = allKeywords.join(' ')
    }

    // Company revenue range (optional extended fields)
    const revenueMin = spec.company_revenue_min as number | undefined
    const revenueMax = spec.company_revenue_max as number | undefined
    if (revenueMin !== undefined || revenueMax !== undefined) {
      request.revenue_range = {}
      if (revenueMin !== undefined) {
        request.revenue_range.min = revenueMin
      }
      if (revenueMax !== undefined) {
        request.revenue_range.max = revenueMax
      }
    }

    // Pre-filter: only return candidates Apollo claims have verified email
    request.contact_email_status = ['verified']

    // Pagination: will be set by execute()
    request.page = 1
    request.per_page = 100

    return request
  },

  // Execute: call Apollo api_search, paginate, return ProspectCandidate array
  execute: async (filter: Record<string, unknown>): Promise<ProspectCandidate[]> => {
    const apiKey = process.env.APOLLO_API_KEY
    if (!apiKey) {
      const msg = 'APOLLO_API_KEY not set in environment'
      logger.error('Apollo handler: missing API key', { error: msg })
      throw new Error(`Apollo sourcing failed: ${msg}`)
    }

    const candidates: ProspectCandidate[] = []
    const MAX_PAGES = 500
    const MAX_RESULTS = 50000

    let page = 1
    let totalFetched = 0
    let morePages = true

    while (morePages && page <= MAX_PAGES && totalFetched < MAX_RESULTS) {
      const request = apolloHandler.adapter(filter) as ApolloApiSearchRequest
      request.page = page
      request.per_page = 100

      try {
        const response = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(request),
        })

        if (response.status === 403) {
          const msg = 'Apollo API returned 403 (plan-gated, likely free tier)'
          logger.error('Apollo handler: access forbidden', { status: 403, error: msg })
          throw new Error(`Apollo sourcing failed: ${msg}`)
        }

        if (response.status === 429) {
          const msg = 'Apollo API rate limit exceeded (600/hour)'
          logger.error('Apollo handler: rate limited', { status: 429, error: msg })
          throw new Error(`Apollo sourcing failed: ${msg}`)
        }

        if (!response.ok) {
          const text = await response.text()
          logger.error('Apollo handler: API error', {
            status: response.status,
            response: text,
          })
          throw new Error(`Apollo API returned ${response.status}: ${text}`)
        }

        const data: ApolloApiSearchResponse = await response.json()

        if (!data.data || !Array.isArray(data.data)) {
          logger.warn('Apollo handler: no data in response', { page })
          break
        }

        // Post-filter criteria from spec
        const jobTitlesExcluded = filter.job_titles_excluded as string[] | undefined
        const keywordsExcluded = filter.keywords_excluded as string[] | undefined

        // Convert Apollo people to ProspectCandidate, apply post-filters
        for (const person of data.data) {
          // Pre-filter: only include if Apollo claims verified email
          if (person.has_email === false) {
            continue
          }

          // Post-filter: exclude by job_titles_excluded (case-insensitive substring)
          if (jobTitlesExcluded?.length && person.title) {
            const titleLower = person.title.toLowerCase()
            if (jobTitlesExcluded.some(excluded =>
              titleLower.includes(excluded.toLowerCase())
            )) {
              logger.debug('Apollo handler: dropped by job_titles_excluded', {
                title: person.title,
                excluded_titles: jobTitlesExcluded,
              })
              continue
            }
          }

          // Post-filter: exclude by keywords_excluded
          if (keywordsExcluded?.length && person.organization?.name) {
            const companyLower = person.organization.name.toLowerCase()
            if (keywordsExcluded.some(excluded =>
              companyLower.includes(excluded.toLowerCase())
            )) {
              logger.debug('Apollo handler: dropped by keywords_excluded', {
                company: person.organization.name,
                excluded_keywords: keywordsExcluded,
              })
              continue
            }
          }

          const candidate: ProspectCandidate = {
            source_person_key: `apollo:${person.id}`,
            email: null, // Not available in api_search response; retrieved at enrichment time
            linkedin_url: null, // Not available in api_search response; retrieved at enrichment time
          }

          candidates.push(candidate)
          totalFetched++

          if (totalFetched >= MAX_RESULTS) {
            logger.info('Apollo handler: reached max results cap', {
              max_results: MAX_RESULTS,
              total_fetched: totalFetched,
            })
            morePages = false
            break
          }
        }

        // Check if more pages available
        const paginationTotal = data.pagination?.total_entries ?? 0
        if (totalFetched >= paginationTotal || data.data.length < 100) {
          morePages = false
        } else {
          page++
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('sourcing failed')) {
          throw err
        }
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('Apollo handler: fetch failed', {
          page,
          error: msg,
        })
        throw new Error(`Apollo sourcing failed at page ${page}: ${msg}`)
      }
    }

    logger.info('Apollo handler: sourcing complete', {
      total_candidates: candidates.length,
      pages_fetched: page - 1,
      max_pages: MAX_PAGES,
    })

    return candidates
  },
}
