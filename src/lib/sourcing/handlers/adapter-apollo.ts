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
import { FILTER_SPEC_FIELDS } from '@/lib/agents/icp-filter-spec'
import type { CanonicalIndustry } from '@/lib/agents/icp-filter-spec'

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

  // 5 to 20 employees. A STOPGAP, and the one constant that reverses it. See ADR-036.
  //
  // Narrowed from '5,50' on 2026-08-27 for the ramp. Measured live on this exact
  // filter, changing only this parameter:
  //
  //     5,20  (shipped)    36,818
  //     21,50 (tier_2)     19,162
  //     5,50  (previous)   55,980
  //
  // The two bands PARTITION the previous filter exactly: 36,818 + 19,162 = 55,980,
  // zero residual. That arithmetic is the check that matters here, because Apollo
  // silently ignores a parameter it does not recognise, so a range string it failed
  // to parse would return a plausible number rather than an error. A clean partition
  // cannot happen by accident.
  //
  // Those 19,162 are not lost, they are DECLARED AND NOT SOURCED. The 21-50 band is
  // tier_2 in the ICP document, and there is no way to ask for it today because the
  // query is hardcoded rather than spec-driven. Nothing else in this filter was tuned
  // to compensate, so widening is this one edit and nothing else.
  organization_num_employees_ranges: ['5,20'],

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

// ─── What this query targets, in canonical names ─────────────────────────────
//
// EXPORTED so the orchestrator's pre-search gate READS this rather than keeping
// its own copy. A value copied into a second file is the parallel-array shape
// CLAUDE.md warns about: the copy and the filter drift apart, nothing errors,
// and the gate ends up proving something about a query that is no longer sent.
// There is one list, and it lives beside the filter it describes.
//
// Typed as CanonicalIndustry[] on purpose. A name that is not in the canonical
// taxonomy is a COMPILE ERROR here rather than a silently empty intersection at
// run time, which is the same class of mistake this gate exists to catch.
//
// This declares what the query ASKS FOR. It is not a promise about every row
// that comes back: a firm carries more than one NAICS code and Apollo's own
// industry tag is assigned independently of the code we filtered on, so this
// filter demonstrably also returns apparel, restaurants and biotechnology rows.
// Those are the tier classifier's problem (industry_off_target), not this
// list's. What this list is for is the question the gate asks: did the client
// ask for anything this query even TRIES to find?
//
// Two sources, both named so the next person does not have to re-derive them:
//
//   1. NAICS 5416, Management, Scientific and Technical Consulting Services,
//      which is the organization_naics_codes value above. Its sub-codes are
//      541611 general and strategy, 541612 human resources, 541613 marketing
//      and sales, 541614 process, logistics and procurement, 541618 other
//      management including risk and compliance, 541620 environmental, and
//      541690 other scientific and technical.
//
//   2. MEASURED. The last four canonical names are not 5416 sub-codes and are
//      here because this exact filter returns them anyway. Live enriched
//      prospects sourced through it carry the Apollo tags 'information
//      technology & services', 'financial services' and 'professional training
//      & coaching', which APOLLO_TO_SPEC maps to the first three. Leaving them
//      out would make the partial-coverage warning below report them as
//      unreachable, which would be false, and a report that cries wolf is the
//      thing this task exists to stop building.
export const APOLLO_TARGETED_INDUSTRIES: readonly CanonicalIndustry[] = [
  // NAICS 5416 sub-codes
  'Management Consulting',
  'Operations Consulting',
  'Strategy Consulting',
  'Change Management Consulting',
  'Human Resources Consulting',
  'Marketing Consulting',
  'Sales Consulting',
  'Supply Chain Consulting',
  'Procurement Consulting',
  'Risk Management Consulting',
  'Compliance Consulting',
  'Environmental Consulting',
  'Engineering Consulting',
  'Healthcare Consulting',
  'Data Analytics Consulting',
  // Measured coming back from this filter, mapped through APOLLO_TO_SPEC
  'Information Technology Consulting',
  'Financial Advisory Services',
  'Business Coaching',
  'Executive Coaching',
] as const

// ISO-3166 codes the hardcoded filter covers. Used only to report divergence.
const FILTER_COUNTRY_CODES = new Set(['US', 'GB', 'IE'])

// The fields this handler advertises. Hoisted out of the handler object so the
// divergence report below can be DERIVED from it instead of hand-listed beside it.
// Two lists that have to be kept in step by hand is the parallel-array shape
// CLAUDE.md warns about: a field added to one and forgotten in the other would be
// discarded and never reported, permanently and silently.
// Derived from the ONE list in icp-filter-spec.ts. See "Layer G" there.
//
// Hand-listed until now, and it disagreed with ICPFilterSpec in both directions: it
// claimed `company_revenue_min` and `company_revenue_max`, which no spec has ever had,
// and any field added to the spec would have been missing here. Deriving it means a new
// spec field is advertised automatically and cannot be silently dropped.
const SUPPORTED_FIELDS = FILTER_SPEC_FIELDS

// The only two spec fields that survive into the run at all. They are honoured as
// POST-FILTERS on results in execute(), never as search parameters, so they are not
// a divergence and must not be reported as one.
const POST_FILTERED_SPEC_FIELDS = new Set<string>(['job_titles_excluded', 'keywords_excluded'])

// Everything else the handler claims to support and the hardcoded query ignores.
// Derived, so it cannot drift from SUPPORTED_FIELDS.
const QUERY_IGNORED_SPEC_FIELDS = SUPPORTED_FIELDS.filter(
  field => !POST_FILTERED_SPEC_FIELDS.has(field),
)

// A field counts as diverging only when the spec actually asked for something. An
// empty array, an empty string or a null is the spec staying silent, and listing
// those would pad the report until the fields that genuinely diverge stop standing
// out. Zero is a real value and is reported.
function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

// ─── The divergence report ───────────────────────────────────────────────────
//
// Called ONCE PER RUN, from execute(), before the first request.
//
// It used to live inside adapter(), and adapter() is called inside the pagination
// loop, once per page. So the single line that says "the spec did not build this
// query" was emitted up to MAX_PAGES times per run. It is the only evidence that a
// client's stored specification was discarded, and its own volume was what made it
// something to scroll past. A report nobody reads is not a report.
//
// Nothing here gates. The filter is hardcoded whatever the spec says, and this
// function is the only thing that says so out loud.
export function reportSpecDivergence(spec: Record<string, unknown>): void {
  const specCountries = [
    ...((spec.company_countries as string[] | undefined) ?? []),
    ...((spec.person_countries as string[] | undefined) ?? []),
  ]
  const ignoredCountries = Array.from(new Set(specCountries))
    .filter(code => !FILTER_COUNTRY_CODES.has(code.toUpperCase()))

  const ignoredFields = QUERY_IGNORED_SPEC_FIELDS.filter(field => isPopulated(spec[field]))

  // UNCONDITIONAL, on every run.
  //
  // This used to fire only when the spec named a country outside US/GB/IE. So the
  // specs MOST likely to be wrong were the ones that produced no log at all: once
  // ADR-032 moved the defaults to GB/IE/US, the country test passes for every new
  // client while headcount, industries, keywords, titles and seniorities are still
  // being discarded in silence. A report that stays quiet until the problem is
  // already obvious is not a report, and 'no log' read as 'no divergence' when it
  // meant 'the only divergence I check for is absent'.
  logger.info('Apollo adapter: hardcoded filter in force, spec did not build this query', {
    ignored_spec_fields: ignoredFields,
    ignored_spec_countries: ignoredCountries,
    post_filtered_spec_fields: Array.from(POST_FILTERED_SPEC_FIELDS),
    filter_locations: APOLLO_FILTER.organization_locations,
    filter_person_locations: APOLLO_FILTER.person_locations,
    filter_headcount_ranges: APOLLO_FILTER.organization_num_employees_ranges,
  })
}

export const apolloHandler = {
  name: 'Apollo',

  // Supported fields: left as it was, and now describes the handler's post-filters
  // and history rather than the search query, which is hardcoded above. Narrowing
  // this list would make the orchestrator throw for any client whose spec
  // populates a field, which would stop sourcing rather than improve it.
  // Copied out of SUPPORTED_FIELDS rather than referencing it, for the same reason
  // the filter arrays are copied below: one caller mutating this would change what
  // every later client in the process is measured against.
  supported_fields: [...SUPPORTED_FIELDS],

  // What the hardcoded query targets, for the orchestrator's pre-search gate.
  // Copied out of the exported constant for the same reason supported_fields is:
  // handing every caller the same array instance means one caller mutating it
  // changes what every later client in the process is measured against.
  targeted_industries: [...APOLLO_TARGETED_INDUSTRIES],

  // Adapter: return the hardcoded request.
  //
  // `spec` is accepted to satisfy the SourcingHandler interface and is NOT used to
  // build the query. It is deliberately unused: the divergence it causes is reported
  // by reportSpecDivergence() above, once per run rather than once per page.
  //
  // This function is now pure. Keep it that way. It is called inside the pagination
  // loop, so anything with a side effect here is multiplied by the page count.
  adapter: (_spec: Record<string, unknown>): ApolloApiSearchRequest => {
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

    // Once per run, before the first request. See reportSpecDivergence above.
    reportSpecDivergence(spec)

    const candidates: ProspectCandidate[] = []

    // Aggregate counts for the two post-filters below. The per-candidate lines are
    // logger.debug, which the logger SUPPRESSES in production (src/lib/logger/index.ts),
    // so before these counters existed a run that dropped every candidate it fetched
    // produced no production evidence of it at all: the only number that reached the
    // orchestrator was candidates.length, already net of the drops. Counting here and
    // saying it once per run costs one log line and makes the drop visible.
    let droppedByExcludedTitle = 0
    let droppedByExcludedKeyword = 0
    let droppedByNoEmail = 0

    const MAX_PAGES = 500
    const MAX_RESULTS = cap ?? 50000
    const PAGE_SIZE = cap ? Math.min(cap, 100) : 100

    // Built ONCE. adapter() ignores `spec` and returns the same hardcoded filter every
    // call, so rebuilding it per page allocated a fresh object per request for nothing.
    // `page` and `per_page` are the only fields that vary, and they are set below.
    const request = apolloHandler.adapter(spec) as ApolloApiSearchRequest
    request.per_page = PAGE_SIZE

    let page = 1
    let totalFetched = 0
    let morePages = true

    while (morePages && page <= MAX_PAGES && totalFetched < MAX_RESULTS) {
      // Rate limit: Apollo enforces 200 calls/minute burst limit. Throttle to ~3 calls/sec (300ms between requests).
      // Only throttle between pages (if page > 1); single page request has zero added delay.
      if (page > 1) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      request.page = page

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
            droppedByNoEmail++
            continue
          }

          // Post-filter: exclude by job_titles_excluded (case-insensitive substring)
          if (jobTitlesExcluded?.length && person.title) {
            const titleLower = person.title.toLowerCase()
            if (jobTitlesExcluded.some(excluded =>
              titleLower.includes(excluded.toLowerCase())
            )) {
              droppedByExcludedTitle++
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
              droppedByExcludedKeyword++
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

    // Flat keys, not a nested object, so `dropped_job_titles_excluded` is greppable
    // in the production log stream on its own. warn when anything was dropped and
    // info when nothing was, because a run that silently discards what it fetched is
    // the case worth noticing and a clean run is not.
    const droppedTotal = droppedByNoEmail + droppedByExcludedTitle + droppedByExcludedKeyword
    const dropReport = {
      total_candidates: candidates.length,
      pages_fetched: page - 1,
      max_pages: MAX_PAGES,
      dropped_total: droppedTotal,
      dropped_no_email: droppedByNoEmail,
      dropped_job_titles_excluded: droppedByExcludedTitle,
      dropped_keywords_excluded: droppedByExcludedKeyword,
    }

    if (droppedTotal > 0) {
      logger.warn('Apollo handler: sourcing complete, candidates were dropped', dropReport)
    } else {
      logger.info('Apollo handler: sourcing complete', dropReport)
    }

    return candidates
  },
}
