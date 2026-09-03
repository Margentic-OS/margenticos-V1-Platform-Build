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
// ─── The search filter is BUILT FROM THE CLIENT'S STORED SPEC ────────────────
// It used to be one hardcoded constant serving every client. That was taken as a
// conscious ADR-009 trade-off while MargenticOS ran as client zero, on the reasoning
// that one measured filter beat a config layer that had produced two silent defects.
//
// The reasoning expired when a second and third client's specs turned out to describe
// completely different markets. A hardcoded consulting filter does not source a school
// or a medical distributor slightly wrongly; it sources a different population
// entirely, and it does so without erroring, which is the worst available failure.
//
// Every parameter below now comes from the spec. What is left hardcoded is named and
// justified at its own site: the country floor (legal), the email-status constraint
// (data quality, not targeting), and the two translation tables, which are this
// handler's job to own per CLAUDE.md.

import { logger } from '@/lib/logger'
import { normaliseLinkedInUrl } from '@/lib/sourcing/normalise-linkedin'
import type { ProspectCandidate } from '@/lib/sourcing/dedupe'
import { FILTER_SPEC_FIELDS, type FilterSpecField } from '@/lib/agents/icp-filter-spec'
import type { CanonicalIndustry } from '@/lib/agents/icp-filter-spec'

// The Apollo People Search parameters this handler sends. OPTIONAL means "sent only
// when the spec asked for it": an omitted parameter is Apollo's own no-constraint, and
// defaulting one would be this file having an opinion about a client's market.
interface ApolloApiSearchRequest {
  organization_naics_codes: string[]
  not_organization_naics_codes?: string[]
  q_organization_keyword_tags?: string[]
  person_titles: string[]
  person_seniorities?: string[]
  organization_num_employees_ranges: string[]
  organization_locations: string[]
  person_locations: string[]
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

// ─── Translation table 1: canonical industry to NAICS ────────────────────────
//
// The handler owns this, per CLAUDE.md. Nothing upstream of here sees a tool-specific
// value, and nothing here invents a canonical name.
//
// `organization_naics_codes` is the parameter Apollo actually reads, established by
// measurement rather than from the docs: Apollo IGNORES an unrecognised parameter
// SILENTLY instead of erroring, and both `naics_codes` and `q_organization_naics_codes`
// returned 770,753, the completely unfiltered count. A wrong parameter name here would
// ship as a filter that filters nothing.
//
// MATCHING IS BY PREFIX, so a shorter code is broader. Codes here are deliberately kept
// at the shortest level that still means the right thing. A precise-but-wrong 6-digit
// code sources the wrong industry silently; a broader-but-correct 3 or 4-digit code
// sources a superset, and the tier classifier's industry gate is what narrows it. Given
// the choice this file errs broad, because being broad is visible in the results and
// being wrong is not.
//
// EXHAUSTIVE BY CONSTRUCTION. Typed as Record<CanonicalIndustry, string>, so adding a
// name to CANONICAL_INDUSTRIES without giving it a code is a COMPILE ERROR here. That
// is deliberate and it is the whole point: the alternative is a lookup that returns
// undefined at run time for a client whose ICP named the new industry, and a query
// missing one of its industries looks exactly like a query that found nothing there.
// No `as` on this literal. See CLAUDE.md on casts that switch off the check.
const CANONICAL_TO_NAICS: Record<CanonicalIndustry, string> = {
  // Professional, scientific and technical services (54)
  'Management Consulting': '5416',
  'Operations Consulting': '5416',
  'Marketing Consulting': '5416',
  'Advertising and Marketing Agencies': '5418',
  'Human Resources Consulting': '5416',
  'Information Technology Consulting': '5415',
  'Strategy Consulting': '5416',
  'Sales Consulting': '5416',
  'Financial Advisory Services': '5231',
  'Accounting Services': '5412',
  'Legal Services': '5411',
  'Executive Coaching': '6114',
  'Business Coaching': '6114',
  'Change Management Consulting': '5416',
  'Environmental Consulting': '5416',
  'Engineering Consulting': '5413',
  'Healthcare Consulting': '5416',
  'Supply Chain Consulting': '5416',
  'Procurement Consulting': '5416',
  'Risk Management Consulting': '5416',
  'Compliance Consulting': '5416',
  'Data Analytics Consulting': '5416',
  'Cybersecurity Consulting': '5415',
  'Public Relations': '5418',
  'Recruitment and Staffing': '5613',
  'Training and Development': '6114',
  // Education (61)
  'Primary and Secondary Education': '6111',
  'Higher Education': '6113',
  'Educational Services and Training': '6114',
  // Health care and life sciences (62, 325, 339)
  'Healthcare Providers': '62',
  'Pharmaceutical Manufacturing': '3254',
  'Medical Devices and Equipment': '3391',
  'Biotechnology': '5417',
  // Construction and real estate (23, 53)
  'Construction and Building': '23',
  'Real Estate Development': '5311',
  'Property Management Services': '5313',
  'Architecture and Engineering': '5413',
  // Manufacturing (31-33)
  'General Manufacturing': '31',
  'Food and Beverage Manufacturing': '311',
  'Automotive Manufacturing': '3361',
  'Electronics Manufacturing': '334',
  'Industrial Equipment Manufacturing': '333',
  // Finance and insurance (52)
  'Banking and Credit': '522',
  'Insurance': '524',
  'Investment and Securities': '523',
  'Wealth Management': '5239',
  // Retail and wholesale (42, 44-45)
  'Retail Trade': '44',
  'E-Commerce and Online Retail': '4541',
  'Department Stores': '4551',
  'Specialty Retail': '45',
  'Wholesale Trade': '42',
  // Accommodation and food service (72)
  'Hotels and Lodging': '7211',
  'Food Service and Restaurants': '722',
  'Hospitality Management': '721',
  // Transportation and warehousing (48-49)
  'Transportation and Warehousing': '48',
  'Logistics and Supply Chain': '4885',
  'Freight and Cargo': '484',
  // Information and technology (51, 518, 5415)
  'Software Publishers': '5132',
  'IT Services and Consulting': '5415',
  'Data Processing and Hosting': '518',
  'Telecommunications': '517',
  // Media and entertainment (51, 71)
  'Media and Broadcasting': '516',
  'Entertainment and Arts': '71',
  'Publishing': '5131',
  // Agriculture and natural resources (11, 21)
  'Agriculture': '111',
  'Forestry and Logging': '113',
  'Mining and Extraction': '212',
  // Energy and utilities (22, 211)
  'Electric Power Generation': '2211',
  'Petroleum and Natural Gas': '211',
  'Utilities and Water': '2213',
  // Government and non-profit (92, 813)
  'Government Agencies': '92',
  'Non-Profit Organizations': '813',
  'Public Administration': '92',
}

// ─── Translation table 2: ISO-3166 alpha-2 to Apollo location name ───────────
//
// The spec stores ISO codes. Apollo expects PLACE NAMES here, not codes, and it ignores
// a value it does not recognise rather than erroring, so a code sent raw would widen the
// search to every country in silence. That is the same silent-ignore class as the
// parameter-name defect above, and it is why an unmapped code THROWS below instead of
// being dropped.
const ISO_TO_APOLLO_LOCATION: Record<string, string> = {
  US: 'united states',
  GB: 'united kingdom',
  IE: 'ireland',
  CA: 'canada',
  AU: 'australia',
  NZ: 'new zealand',
  DE: 'germany',
  FR: 'france',
  NL: 'netherlands',
  BE: 'belgium',
  ES: 'spain',
  IT: 'italy',
  PT: 'portugal',
  SE: 'sweden',
  NO: 'norway',
  DK: 'denmark',
  FI: 'finland',
  CH: 'switzerland',
  AT: 'austria',
  PL: 'poland',
  ZA: 'south africa',
  SG: 'singapore',
  IN: 'india',
}

// ─── The country floor. HARDCODED, and it must stay that way ─────────────────
//
// These are LEGAL exclusions, not targeting preferences, and they are the one thing in
// this file a client's spec is not allowed to widen.
//
//   CA  CASL requires consent before first contact.
//   DE  Two GmbHs were mailed against an exclusion that lived in convention and had
//       nothing to read it. That is what a convention is worth.
//
// It REFUSES rather than silently dropping. A spec naming an excluded country is a
// disagreement between what a client was told they would get and what the law allows,
// and an operator has to resolve it. Quietly returning a smaller result set would hide
// exactly the case that needs a person.
//
// Note what this does NOT do, per ADR-034: it governs UPLOAD, not delivery, and it
// cannot recall anything already in flight with the sending provider.
const LEGALLY_EXCLUDED_COUNTRIES = new Set(['CA', 'DE'])

/**
 * Build the Apollo request from one client's stored spec.
 *
 * PURE, and it THROWS rather than degrading. Every throw here is a case where the old
 * code would have sourced the wrong population without saying anything, which is the
 * defect this function exists to remove. Sourcing the wrong industry silently is worse
 * than an error: an error costs a run, and the wrong industry costs the client's
 * reputation with people who should never have been contacted.
 */
export function buildApolloRequest(
  spec: Record<string, unknown>,
): Omit<ApolloApiSearchRequest, 'page' | 'per_page'> {
  if (!spec || typeof spec !== 'object') {
    throw new Error(
      'Apollo sourcing failed: no filter spec. The query is built from the client\'s ' +
      'stored ICP filter spec and there is nothing to build it from. Approve an ICP ' +
      'for this organisation.',
    )
  }

  const industries = asStringArray(spec.industries)
  if (industries.length === 0) {
    throw new Error(
      'Apollo sourcing failed: the filter spec names no industries, so there is no ' +
      'population to search. This usually means the ICP was approved before the ' +
      'derivation hook existed, or its industries were not canonical.',
    )
  }

  const naicsCodes: string[] = []
  const unmappedIndustries: string[] = []
  for (const name of industries) {
    const code = CANONICAL_TO_NAICS[name as CanonicalIndustry]
    if (code) naicsCodes.push(code)
    else unmappedIndustries.push(name)
  }
  if (unmappedIndustries.length > 0) {
    throw new Error(
      `Apollo sourcing failed: no NAICS code is registered for ${unmappedIndustries
        .map(n => `"${n}"`)
        .join(', ')}. Add it to CANONICAL_TO_NAICS in the Apollo handler, which owns ` +
      'this translation. Searching without it would silently source the other ' +
      'industries only and report a full result.',
    )
  }

  // Titles are what make this a search for PEOPLE rather than for companies, and they
  // are the field most likely to be absent on an older spec. Refusing is the point:
  // the deleted default was eight consulting titles handed to every client.
  const jobTitles = asStringArray(spec.job_titles)
  if (jobTitles.length === 0) {
    throw new Error(
      'Apollo sourcing failed: the filter spec names no job titles. These come from ' +
      'the client\'s buyer criterion, so this means no criterion was derived when the ' +
      'ICP was approved. Re-approving the ICP derives one. Searching without titles ' +
      'would return every employee of every matching company.',
    )
  }

  const companyCountries = asStringArray(spec.company_countries)
  const personCountries = asStringArray(spec.person_countries)
  if (companyCountries.length === 0 || personCountries.length === 0) {
    throw new Error(
      'Apollo sourcing failed: the filter spec must constrain BOTH company_countries ' +
      'and person_countries. Constraining only the company returns employees of those ' +
      'companies wherever in the world they live, which is the exposure that mailed ' +
      'two prospects in an excluded country.',
    )
  }

  const headcountMin = asNumber(spec.company_headcount_min)
  const headcountMax = asNumber(spec.company_headcount_max)
  if (headcountMin === null || headcountMax === null || headcountMin > headcountMax) {
    throw new Error(
      'Apollo sourcing failed: the filter spec has no usable headcount range ' +
      `(min=${String(spec.company_headcount_min)}, max=${String(spec.company_headcount_max)}).`,
    )
  }

  const request: Omit<ApolloApiSearchRequest, 'page' | 'per_page'> = {
    organization_naics_codes: [...new Set(naicsCodes)],
    person_titles: jobTitles,
    organization_num_employees_ranges: [`${headcountMin},${headcountMax}`],
    organization_locations: translateCountries(companyCountries, 'company_countries'),
    person_locations: translateCountries(personCountries, 'person_countries'),

    // Only candidates Apollo claims have a verified email. NOT from the spec, and not a
    // targeting decision: no ICP has an opinion about email deliverability, and every
    // client wants the same answer. It is a data-quality constraint on the results.
    contact_email_status: ['verified'],
  }

  // ─── Optional narrowing. Sent only when the spec asked for it ──────────────
  //
  // Each of these is omitted rather than defaulted when absent. An omitted parameter is
  // Apollo's own "no constraint"; a defaulted one is this file having an opinion about a
  // client's market, which is what the whole change removes.

  // OR semantics across the tags, and the correct parameter for sourcing by category.
  // It is NOT q_keywords, which was the first silent defect here: q_keywords is AND over
  // free text matched against person and company NAMES, so it only ever found firms with
  // the literal word in their name. Measured on the consulting base, q_keywords
  // 'consulting' returned 4,924 against 72,458 for NAICS alone. The two parameters look
  // interchangeable and are not.
  const keywords = asStringArray(spec.keywords)
  if (keywords.length > 0) request.q_organization_keyword_tags = keywords

  const excludedIndustries = asStringArray(spec.industries_excluded)
  if (excludedIndustries.length > 0) {
    const excludedCodes = excludedIndustries
      .map(name => CANONICAL_TO_NAICS[name as CanonicalIndustry])
      .filter((code): code is string => Boolean(code))
    // Only exclude a code the include list does not also rely on. A client naming the
    // same NAICS parent in both lists would otherwise cancel its own search to zero,
    // silently, and a zero result reads as "no such prospects exist".
    const netExcluded = [...new Set(excludedCodes)].filter(
      code => !request.organization_naics_codes.includes(code),
    )
    if (netExcluded.length > 0) request.not_organization_naics_codes = netExcluded
  }

  // Seniority is a COARSE provider-side prefilter derived from job title, and narrowing
  // it was measured at 29,139 rows against 72,458 on the consulting base. It is sent
  // only when the spec asked, because `person_titles` above already expresses who this
  // client wants, far more precisely, in the client's own vocabulary.
  const seniorities = asStringArray(spec.seniority_levels)
  if (seniorities.length > 0) request.person_seniorities = seniorities

  return request
}

/** ISO codes to Apollo place names, refusing on anything it cannot honour. */
function translateCountries(codes: string[], field: string): string[] {
  const blocked = codes.filter(code => LEGALLY_EXCLUDED_COUNTRIES.has(code.toUpperCase()))
  if (blocked.length > 0) {
    throw new Error(
      `Apollo sourcing failed: ${field} names ${blocked.join(', ')}, which this handler ` +
      'excludes on legal grounds (CASL consent for CA, a standing exclusion for DE). ' +
      'This is refused rather than quietly dropped, because a client expecting those ' +
      'countries and silently not getting them is a conversation, not a filter.',
    )
  }

  const unknown = codes.filter(code => !ISO_TO_APOLLO_LOCATION[code.toUpperCase()])
  if (unknown.length > 0) {
    throw new Error(
      `Apollo sourcing failed: ${field} names ${unknown.join(', ')}, for which no Apollo ` +
      'location name is registered. Add it to ISO_TO_APOLLO_LOCATION. Apollo ignores a ' +
      'location it does not recognise instead of erroring, so sending the raw code ' +
      'would widen the search to every country without saying so.',
    )
  }

  return [...new Set(codes.map(code => ISO_TO_APOLLO_LOCATION[code.toUpperCase()]))]
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

// ─── How each spec field reaches Apollo, as data rather than as prose ────────
//
// `supported_fields` used to be the whole of FILTER_SPEC_FIELDS regardless of what the
// query did, and its own comment admitted it "describes the handler's post-filters and
// history rather than the search query". A manifest that describes history is worse than
// none: the orchestrator checks a client's populated spec fields against it and passes,
// which reads as confirmation that the client's spec was honoured.
//
// This is now the real answer, one entry per spec field, and adapter-apollo.test.ts
// asserts it against what buildApolloRequest actually sends.
//
//   'query'       narrows the Apollo search itself
//   'post_filter' Apollo has no parameter for it, so it narrows the RESULTS in execute()
export const SPEC_FIELD_HANDLING = {
  job_titles:            'query',        // -> person_titles
  seniority_levels:      'query',        // -> person_seniorities (only when populated)
  person_countries:      'query',        // -> person_locations, via ISO_TO_APOLLO_LOCATION
  company_countries:     'query',        // -> organization_locations, same table
  company_headcount_min: 'query',        // -> organization_num_employees_ranges, paired
  company_headcount_max: 'query',        // -> organization_num_employees_ranges, paired
  industries:            'query',        // -> organization_naics_codes, via CANONICAL_TO_NAICS
  industries_excluded:   'query',        // -> not_organization_naics_codes, net of includes
  keywords:              'query',        // -> q_organization_keyword_tags
  // NO APOLLO EQUIVALENT. People Search can exclude a company's NAICS or SIC code but
  // has no "not_person_titles" and no negative keyword-tag parameter. Both are applied
  // to the returned rows in execute() instead.
  job_titles_excluded:   'post_filter',
  keywords_excluded:     'post_filter',
} as const satisfies Record<FilterSpecField, 'query' | 'post_filter'>

// `satisfies` above, not `as`. It checks that every FILTER_SPEC_FIELD has an entry and
// that no entry names a field that is not one, without widening the literal types, so a
// field added to the spec is a compile error here rather than an untranslated field the
// query silently omits. See CLAUDE.md on casts that switch off the check that would have
// caught the thing.

const POST_FILTERED_SPEC_FIELDS = new Set<string>(
  SUPPORTED_FIELDS.filter(field => SPEC_FIELD_HANDLING[field] === 'post_filter'),
)

// Fields the query genuinely cannot express at all. Derived, so it cannot drift.
// Empty today: every remaining spec field reaches the query or the post-filter.
const QUERY_IGNORED_SPEC_FIELDS = SUPPORTED_FIELDS.filter(
  field => !(field in SPEC_FIELD_HANDLING),
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

// ─── What the spec asked for and the query cannot express ────────────────────
//
// Called ONCE PER RUN, from execute(), before the first request. It used to live inside
// adapter(), which runs once per PAGE, so the one line saying a client's spec had been
// discarded was emitted up to MAX_PAGES times per run. A report nobody reads is not one.
//
// ITS SUBJECT CHANGED COMPLETELY. It used to say "the hardcoded filter is in force and
// your spec built none of this", which was true of every field. The query is now built
// from the spec, so what is left to report is the short list of fields Apollo's People
// Search has no parameter for. Those two are honoured as POST-FILTERS on results in
// execute(), so they are not discarded, but they are not narrowing the search either,
// and that costs pages fetched and rows dropped after the fact.
//
// Nothing here gates.
export function reportSpecDivergence(spec: Record<string, unknown>): void {
  const postFiltered = Array.from(POST_FILTERED_SPEC_FIELDS).filter(field =>
    isPopulated(spec[field]),
  )

  logger.info('Apollo adapter: query built from the client spec', {
    post_filtered_spec_fields: postFiltered,
    post_filter_reason:
      'Apollo People Search has no parameter to exclude titles or company keywords, ' +
      'so these narrow the RESULTS rather than the search.',
    query_ignored_spec_fields: QUERY_IGNORED_SPEC_FIELDS.filter(field =>
      isPopulated(spec[field]),
    ),
  })
}

export const apolloHandler = {
  name: 'Apollo',

  // What this handler can honour, and how. The orchestrator's manifest check reads this.
  // Copied out rather than referencing the module constant, for the same reason the
  // request arrays are rebuilt per call: handing every caller the same array instance
  // means one caller mutating it changes what every later client is measured against.
  supported_fields: [...SUPPORTED_FIELDS],

  // What the hardcoded query targets, for the orchestrator's pre-search gate.
  targeted_industries: [...APOLLO_TARGETED_INDUSTRIES],

  // Adapter: build the request from THIS CLIENT'S spec.
  //
  // Still pure, and it must stay that way: it is called inside the pagination loop, so
  // anything with a side effect here is multiplied by the page count. It throws on a
  // spec it cannot honour, which is a return path rather than a side effect.
  //
  // Fresh arrays every call, out of buildApolloRequest. A shallow spread of a shared
  // constant hands every caller the SAME array instances, so one caller appending a
  // location would silently change the filter for every client sourced afterwards in
  // that process. That failure would be cross-client and would not raise an error.
  adapter: (spec: Record<string, unknown>): ApolloApiSearchRequest => {
    return {
      ...buildApolloRequest(spec),
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
