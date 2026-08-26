// src/lib/sourcing/handlers/adapter-apollo.ts
//
// Apollo people-search sourcing handler.
// Endpoint: POST https://api.apollo.io/api/v1/mixed_people/api_search
// Credentials: x-api-key header (APOLLO_API_KEY env var)
// Rate limit: 600 calls/hour
// Credits consumed: None (People API Search is free, plan-gated above free tier)
//
// Handler workflow:
//   1. adapter(): Return the hardcoded Apollo search filter (APOLLO_FILTER below)
//   2. execute(): Call Apollo, paginate results, return ProspectCandidate array
//   3. Post-filter: Drop candidates by job_titles_excluded and keywords_excluded
//
// ─── The search filter is HARDCODED, deliberately ────────────────────────────
// The ICPFilterSpec no longer builds the Apollo query. Every client sourced
// through this handler gets the one filter below. That is a conscious trade-off
// taken while MargenticOS runs as client zero (ADR-009): one filter that has
// been measured against the live index beats a config layer that produced two
// silent defects. Reinstate spec-driven translation when client two actually
// needs a different filter, not before. The ISO-3166 to Apollo location table
// and the seniority map that used to live here are recoverable from git history
// (the commit before this one) when that day comes.
//
// Two consequences worth knowing, neither hidden:
//   - The orchestrator's manifest check (step 4) still compares spec fields
//     against supported_fields below and still passes. It no longer describes
//     the query that gets sent. Logged in docs/BACKLOG.md.
//   - spec.job_titles_excluded and spec.keywords_excluded are still honoured,
//     because those are post-filters applied to RESULTS in execute(), not
//     search parameters.

import { logger } from '@/lib/logger'
import { normaliseLinkedInUrl } from '@/lib/sourcing/normalise-linkedin'
import type { ProspectCandidate } from '@/lib/sourcing/dedupe'

interface ApolloApiSearchRequest {
  organization_naics_codes: string[]
  q_organization_keyword_tags: string[]
  organization_num_employees_ranges: string[]
  organization_locations: string[]
  person_locations: string[]
  person_seniorities: string[]
  contact_email_status: string[]
  page: number
  per_page: number
}

interface ApolloApiSearchResponse {
  people: {
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
  total_entries: number
}

// ─── The filter ──────────────────────────────────────────────────────────────
// Live total_entries with exactly these values: 55,975, measured 2026-08-26.
//
// Without the person_locations line below it measures 61,523, against 61,492 for
// the same filter on 2026-08-24. Those 31 rows are Apollo's index moving over two
// days, not a change in the filter.
//
// Every number quoted below was measured on this exact base, changing one
// parameter at a time. They are here so the next person does not have to
// re-derive why each value is what it is.

const APOLLO_FILTER: Omit<ApolloApiSearchRequest, 'page' | 'per_page'> = {
  // NAICS 5416: Management, Scientific and Technical Consulting Services.
  //
  // `organization_naics_codes` is the parameter Apollo actually reads. That was
  // established by measurement rather than from the docs, because Apollo IGNORES
  // an unrecognised parameter silently instead of erroring: both `naics_codes`
  // and `q_organization_naics_codes` returned 770,753, the completely unfiltered
  // count, and would have shipped as a filter that filtered nothing.
  //
  // 5418 (Advertising, PR and related services) is deliberately NOT excluded.
  // A firm carries more than one NAICS code, so a marketing consultancy coded
  // both 5416 and 5418 is in scope, and an exclusion rule would drop it.
  // Adding 5418 to this include list is a different thing and is not wanted:
  // it measured 66,134 against the 61,524 above.
  organization_naics_codes: ['5416'],

  // OR semantics across the tags, and the correct parameter for sourcing by
  // category. It replaces q_keywords, which was the first silent defect:
  // q_keywords is AND over free text, matched against person and company NAMES,
  // so it only ever found firms with the literal word in their name. Measured on
  // this base, q_keywords 'consulting' returns 4,924 against 72,458 for NAICS
  // alone. The two parameters look interchangeable and are not.
  q_organization_keyword_tags: [
    'management consulting',
    'business consulting',
    'strategy consulting',
  ],

  // 5 to 50 employees.
  organization_num_employees_ranges: ['5,50'],

  // United States, United Kingdom and Ireland only. Apollo expects place names
  // here, not ISO codes.
  //
  // Germany and Canada are removed HERE, at the filter, rather than by a
  // downstream convention. Two GmbHs were mailed against a standing exclusion
  // that had nothing to read it, which is what a convention is worth. Canada is
  // out on CASL: consent is required before first contact.
  organization_locations: ['united states', 'united kingdom', 'ireland'],

  // The SAME three countries again, applied to where the PERSON is.
  //
  // organization_locations alone removes German and Canadian FIRMS. It does not
  // remove a person sitting in Toronto who works for a US-registered company, and
  // measured against the org-only filter there were 545 of them in Canada and 238
  // in Germany. CASL attaches to the RECIPIENT, not to where the firm is
  // registered, so those 545 were the same exposure as the two GmbHs and not a
  // smaller version of it.
  //
  // This costs inventory and is worth it: 61,523 to 55,975, which is 5,548 rows or
  // about 9 percent. A complaint is not affordable; 9 percent is.
  //
  // Proved by arithmetic rather than asserted, because Apollo silently ignores a
  // parameter it does not recognise and an ignored person_locations would look
  // exactly like a working one. Adding a country BACK to this list returns
  // precisely the people it was excluding: +canada gives 56,520, which is 55,975
  // plus exactly the 545, and +germany gives 56,213, which is 55,975 plus exactly
  // the 238. Both residuals are therefore outside the shipped set.
  person_locations: ['united states', 'united kingdom', 'ireland'],

  // Second silent defect. Apollo derives seniority from job TITLE, not from
  // ownership, and in professional services the owner is usually titled Partner
  // or Managing Partner. owner+founder alone therefore missed most of the
  // population it was meant to target. Measured on this base: 29,139 with
  // owner+founder, 72,458 once c_suite and partner were added.
  person_seniorities: ['owner', 'founder', 'c_suite', 'partner'],

  // Only candidates Apollo claims have a verified email.
  contact_email_status: ['verified'],
}

// ISO-3166 codes the hardcoded filter covers. Used only to report divergence.
const FILTER_COUNTRY_CODES = new Set(['US', 'GB', 'IE'])

export const apolloHandler = {
  name: 'Apollo',

  // Supported fields: left as it was, and now describes the handler's post-filters
  // and history rather than the search query, which is hardcoded above. Narrowing
  // this list would make the orchestrator throw for any client whose spec
  // populates a field, which would stop sourcing rather than improve it.
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

  // Adapter: return the hardcoded request.
  //
  // `spec` is accepted to satisfy the SourcingHandler interface and is not used
  // to build the query. It is read for exactly one thing: to say out loud when
  // the stored spec disagrees with the filter, so that gap is visible in the
  // logs instead of silent. Client zero's stored spec still lists DE and CA,
  // so this will fire until the spec defaults are changed.
  adapter: (spec: Record<string, unknown>): ApolloApiSearchRequest => {
    const specCountries = [
      ...((spec.company_countries as string[] | undefined) ?? []),
      ...((spec.person_countries as string[] | undefined) ?? []),
    ]
    const ignored = Array.from(new Set(specCountries))
      .filter(code => !FILTER_COUNTRY_CODES.has(code.toUpperCase()))

    if (ignored.length > 0) {
      logger.info('Apollo adapter: hardcoded filter in force, spec countries not honoured', {
        ignored_spec_countries: ignored,
        filter_locations: APOLLO_FILTER.organization_locations,
      })
    }

    // Copy the arrays out rather than spreading the references. A shallow spread
    // hands every caller the SAME array instances as the module-level constant, so
    // one caller appending a location would silently change the filter for every
    // client sourced afterwards in that process. Nothing mutates them today. This
    // makes it impossible to start, because that failure would be a cross-client
    // one and would not raise an error when it happened.
    return {
      organization_naics_codes: [...APOLLO_FILTER.organization_naics_codes],
      q_organization_keyword_tags: [...APOLLO_FILTER.q_organization_keyword_tags],
      organization_num_employees_ranges: [...APOLLO_FILTER.organization_num_employees_ranges],
      organization_locations: [...APOLLO_FILTER.organization_locations],
      person_locations: [...APOLLO_FILTER.person_locations],
      person_seniorities: [...APOLLO_FILTER.person_seniorities],
      contact_email_status: [...APOLLO_FILTER.contact_email_status],
      page: 1,
      per_page: 100,
    }
  },

  // Execute: call Apollo api_search, paginate, return ProspectCandidate array
  // Input: spec (containing all filter fields including those used for post-filtering)
  //        cap (optional batch size cap; if set, stops pagination once cap candidates are fetched)
  execute: async (spec: Record<string, unknown>, cap?: number): Promise<ProspectCandidate[]> => {
    const apiKey = process.env.APOLLO_API_KEY
    if (!apiKey) {
      const msg = 'APOLLO_API_KEY not set in environment'
      logger.error('Apollo handler: missing API key', { error: msg })
      throw new Error(`Apollo sourcing failed: ${msg}`)
    }

    const candidates: ProspectCandidate[] = []
    const MAX_PAGES = 500
    const MAX_RESULTS = cap ?? 50000
    const PAGE_SIZE = cap ? Math.min(cap, 100) : 100

    let page = 1
    let totalFetched = 0
    let morePages = true

    while (morePages && page <= MAX_PAGES && totalFetched < MAX_RESULTS) {
      // Rate limit: Apollo enforces 200 calls/minute burst limit. Throttle to ~3 calls/sec (300ms between requests).
      // Only throttle between pages (if page > 1); single page request has zero added delay.
      if (page > 1) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      const request = apolloHandler.adapter(spec) as ApolloApiSearchRequest
      request.page = page
      request.per_page = PAGE_SIZE

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
          const retryAfter = response.headers.get('Retry-After')
          const msg = `Apollo API rate limited (600/hour). Retry-After: ${retryAfter || 'not provided'}`
          logger.error('Apollo handler: rate limited', {
            status: 429,
            error: msg,
            retryAfterHeader: retryAfter,
          })
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

        if (!data.people || !Array.isArray(data.people)) {
          logger.warn('Apollo handler: no people in response', { page })
          break
        }

        // Post-filter criteria from spec
        const jobTitlesExcluded = spec.job_titles_excluded as string[] | undefined
        const keywordsExcluded = spec.keywords_excluded as string[] | undefined

        // Convert Apollo people to ProspectCandidate, apply post-filters
        for (const person of data.people) {
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
            first_name: person.first_name || null,
            job_title: person.title || null,
            company_name: person.organization?.name || null,
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
        const totalEntries = data.total_entries ?? 0
        if (totalFetched >= totalEntries || data.people.length < 100) {
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
