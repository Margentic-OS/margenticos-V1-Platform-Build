import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'

// ICP Filter Spec derivation.
// Deterministic extraction from an approved ICP document JSON into the
// ADR-015 filter spec schema. Used by the TAM gate and sourcing orchestrator.
//
// Canonical industry names are defined here. The ICP agent prompt enforces
// the same list at generation time. This module validates at read time.
// Both must stay in sync — see CLAUDE.md prompt/validator consistency rules.

// ─── Canonical NAICS-derived industry taxonomy ────────────────────────────────
// Source of truth for industry naming across the entire platform.
// ICP agent prompt must reference this list. Apollo handler owns translation
// from these canonical names to Apollo's own taxonomy.

export const CANONICAL_INDUSTRIES = [
  // Professional Services & Consulting
  'Management Consulting',
  'Operations Consulting',
  'Marketing Consulting',
  'Advertising and Marketing Agencies',
  'Human Resources Consulting',
  'Information Technology Consulting',
  'Strategy Consulting',
  'Sales Consulting',
  'Financial Advisory Services',
  'Accounting Services',
  'Legal Services',
  'Executive Coaching',
  'Business Coaching',
  'Change Management Consulting',
  'Environmental Consulting',
  'Engineering Consulting',
  'Healthcare Consulting',
  'Supply Chain Consulting',
  'Procurement Consulting',
  'Risk Management Consulting',
  'Compliance Consulting',
  'Data Analytics Consulting',
  'Cybersecurity Consulting',
  'Public Relations',
  'Recruitment and Staffing',
  'Training and Development',
  // Education
  'Primary and Secondary Education',
  'Higher Education',
  'Educational Services and Training',
  // Healthcare & Life Sciences
  'Healthcare Providers',
  'Pharmaceutical Manufacturing',
  'Medical Devices and Equipment',
  'Biotechnology',
  // Construction & Real Estate
  'Construction and Building',
  'Real Estate Development',
  'Property Management Services',
  'Architecture and Engineering',
  // Manufacturing
  'General Manufacturing',
  'Food and Beverage Manufacturing',
  'Automotive Manufacturing',
  'Electronics Manufacturing',
  'Industrial Equipment Manufacturing',
  // Financial Services
  'Banking and Credit',
  'Insurance',
  'Investment and Securities',
  'Wealth Management',
  // Retail & E-Commerce
  'Retail Trade',
  'E-Commerce and Online Retail',
  'Department Stores',
  'Specialty Retail',
  'Wholesale Trade',
  // Hospitality & Food Service
  'Hotels and Lodging',
  'Food Service and Restaurants',
  'Hospitality Management',
  // Transportation & Logistics
  'Transportation and Warehousing',
  'Logistics and Supply Chain',
  'Freight and Cargo',
  // Information Technology
  'Software Publishers',
  'IT Services and Consulting',
  'Data Processing and Hosting',
  'Telecommunications',
  // Media & Entertainment
  'Media and Broadcasting',
  'Entertainment and Arts',
  'Publishing',
  // Agriculture & Natural Resources
  'Agriculture',
  'Forestry and Logging',
  'Mining and Extraction',
  // Energy & Utilities
  'Electric Power Generation',
  'Petroleum and Natural Gas',
  'Utilities and Water',
  // Government & Non-Profit
  'Government Agencies',
  'Non-Profit Organizations',
  'Public Administration',
] as const

export type CanonicalIndustry = typeof CANONICAL_INDUSTRIES[number]

// Validate a single industry name. Throws a descriptive error if it is not
// in the canonical list — prevents non-canonical names from entering the
// filter spec and then silently failing translation in a sourcing handler.
export function validateCanonicalIndustry(name: string): asserts name is CanonicalIndustry {
  if (!(CANONICAL_INDUSTRIES as readonly string[]).includes(name)) {
    const closest = CANONICAL_INDUSTRIES
      .filter(c => c.toLowerCase().includes(name.toLowerCase().split(' ')[0]))
      .slice(0, 3)
    const hint = closest.length > 0
      ? ` Closest canonical matches: ${closest.map(c => `"${c}"`).join(', ')}.`
      : ' No close match found — check the CANONICAL_INDUSTRIES list in icp-filter-spec.ts.'
    throw new Error(
      `ICP filter spec: "${name}" is not a canonical industry name.${hint} ` +
      'Fix the ICP agent prompt to use canonical names, or add a new canonical name to this module.'
    )
  }
}

// ─── ADR-015 filter spec schema ───────────────────────────────────────────────

export interface ICPFilterSpec {
  job_titles: string[]
  job_titles_excluded: string[]
  seniority_levels: ('founder' | 'owner' | 'c_suite' | 'vp' | 'director' | 'manager' | 'senior' | 'entry')[]
  person_countries: string[]          // ISO-3166 alpha-2 codes
  company_countries: string[]         // ISO-3166 alpha-2 codes
  company_headcount_min: number
  company_headcount_max: number
  industries: CanonicalIndustry[]
  industries_excluded: CanonicalIndustry[]
  keywords: string[]
  keywords_excluded: string[]
  notes: string
  unmatched_industries?: string[]     // Non-canonical industries flagged for operator review
  /**
   * Who this client will actually EMAIL, derived from this client's own documents.
   *
   * NOT THE SAME THING AS seniority_levels, and the two must never be conflated.
   * seniority_levels is what we ask the sourcing provider for and is deliberately wide,
   * because a provider derives seniority from job title and is coarse; narrowing it was
   * measured at 29,139 rows against 72,458. This is the narrower question of who, out of
   * that wide result, is worth paying to enrich.
   *
   * Optional because every spec written before this field existed lacks one. Absent means
   * the gate fails OPEN and warns. See src/lib/sourcing/buyer-criterion.ts.
   */
  buyer_criterion?: BuyerCriterion
}

// ─── Layer G: ONE list of spec fields, and a compile-time guard on it ─────────
//
// There used to be THREE lists of filter-field names and they disagreed:
//
//   ICPFilterSpec's own keys          13
//   FILTER_FIELDS in sourcing/types   19  (6 fields no spec has ever had, plus revenue)
//   SUPPORTED_FIELDS in adapter-apollo 13  (including 2 fields ICPFilterSpec lacks)
//
// The orchestrator's manifest check iterates FILTER_FIELDS, so a field added to
// ICPFilterSpec but not to FILTER_FIELDS was NEVER CHECKED: the adapter could discard
// it and nothing would report a divergence. That is the parallel-array shape CLAUDE.md
// warns about, three lists deep, and it is why this is fixed before anything is built
// on top of the spec.
//
// The two lists below are the single source. Everything else derives from them.
//
// The split is load-bearing. FILTER fields are constraints a handler is expected to
// honour, so the manifest check iterates exactly these. METADATA fields travel with the
// spec but constrain nothing, so listing them would make the manifest check demand that
// every handler "support" `notes`, which would throw for every client.

export const FILTER_SPEC_FIELDS = [
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
] as const

// buyer_criterion is METADATA rather than a FILTER field, and the distinction is
// load-bearing. The orchestrator's manifest check iterates FILTER_SPEC_FIELDS and
// demands that the sourcing handler support each one. This constrains OUR gate, not the
// handler's query: the handler never sees it, and listing it as a filter field would
// make the manifest check report a divergence for every client on every run.
export const FILTER_SPEC_METADATA_FIELDS = [
  'notes',
  'unmatched_industries',
  'buyer_criterion',
] as const

export type FilterSpecField = typeof FILTER_SPEC_FIELDS[number]

// The guard. Adding a key to ICPFilterSpec without classifying it above is a COMPILE
// ERROR here, and so is naming a field above that ICPFilterSpec does not have.
//
// Written as two `never` checks rather than a boolean, because `extends true` would
// still pass when the Exclude resolves to a union containing true. Both directions are
// checked on purpose: one catches a field added to the type and forgotten in the list,
// the other catches a field removed from the type and left in the list. Only checking
// the direction you expect to break is how the original three lists drifted.
type _AllSpecFields = FilterSpecField | typeof FILTER_SPEC_METADATA_FIELDS[number]
type _FieldsMissingFromLists = Exclude<keyof ICPFilterSpec, _AllSpecFields>
type _FieldsNotOnTheType = Exclude<_AllSpecFields, keyof ICPFilterSpec>

// If either line below errors, read the type name: it says which direction drifted.
const _specFieldsAreExhaustive: [_FieldsMissingFromLists] extends [never] ? true : never = true
const _specFieldsAllExist: [_FieldsNotOnTheType] extends [never] ? true : never = true
void _specFieldsAreExhaustive
void _specFieldsAllExist

// ─── ICP document types (mirrors icp-generation-agent.ts output schema) ───────

export interface IcpCompanyProfile {
  revenue_range: string
  headcount: string
  stage?: string
  industries: string[]
  geography?: string
  business_model?: string
}

export interface IcpDocument {
  jtbd_statement: string
  summary: string
  tier_1: {
    company_profile: IcpCompanyProfile
    buyer_profile: { title: string; seniority: string }
    disqualifiers: string[]
    [key: string]: unknown
  }
  tier_2: {
    company_profile: IcpCompanyProfile
    buyer_profile: { title: string; seniority: string }
    disqualifiers: string[]
    [key: string]: unknown
  }
  tier_3: {
    company_profile: IcpCompanyProfile
    [key: string]: unknown
  }
}

// ─── Default spec values ──────────────────────────────────────────────────────
// Applied universally for English-speaking B2B consulting ICPs unless overridden.
// Modify per-client in the filter spec approval UI when needed.
//
// These three MATCH the sourcing filter in adapter-apollo.ts, and they have to.
// The filter is the enforcement: it is hardcoded and nothing in this spec can
// widen it. But a default that lists a country the filter refuses is a document
// that lies, and it made the adapter log a divergence on every single run, which
// is the kind of noise a team learns to scroll past.
//
// CA and DE are gone on legal grounds, not preference. Canada is out on CASL,
// which requires consent before first contact. Germany is out because two GmbHs
// were mailed against an exclusion that lived in convention and had nothing to
// read it. AU and NL are gone for the narrower reason that the filter does not
// source them, so listing them here claimed reach that did not exist.
//
// Widening this list alone changes NOTHING about who gets sourced. Both this and
// APOLLO_FILTER have to change together, and the legal reasons above have to be
// answered first.

const DEFAULT_PERSON_COUNTRIES = ['GB', 'IE', 'US']
const DEFAULT_COMPANY_COUNTRIES = ['GB', 'IE', 'US']

// "agency" removed: many solo consultants self-describe as "boutique agency"
// and would be incorrectly excluded. "staffing" and "recruitment" are kept
// because they describe firms in a different business category.
const DEFAULT_KEYWORDS_EXCLUDED = ['staffing', 'recruitment', 'SaaS', 'software product']

// ─── Main derivation function ─────────────────────────────────────────────────

export function deriveFilterSpec(doc: IcpDocument): ICPFilterSpec {
  const t1 = doc.tier_1
  const t2 = doc.tier_2

  // Merge Tier 1 + Tier 2 industries, deduplicate, validate each name.
  const rawIndustries = [...new Set([
    ...(t1.company_profile.industries ?? []),
    ...(t2.company_profile.industries ?? []),
  ])]

  for (const name of rawIndustries) {
    validateCanonicalIndustry(name)
  }

  const industries = rawIndustries as CanonicalIndustry[]

  // Headcount: union of both tiers (min across both, max across both).
  // Both tiers are sourced; tier classification happens downstream (sourced_tier).
  // The ICP headcount strings are human-readable ("1–3 people") — parse the bounds.
  // Previous pairing (t1-min / t2-max) silently inverted when tier 2 was smaller, excluding valid tier 1 range.
  // Both tiers are sourced, so the spec spans the union of the two ranges.
  //
  // The `?? 1` / `?? 20` / `?? 8` fallbacks that used to sit here are DELETED, not adjusted.
  // They turned "this document does not say" into a confident 1-20 that nothing downstream
  // could tell apart from a parsed one, and 20 is a hard ceiling: resolveHeadcountCeiling
  // removes every prospect above it. A default that silently decides who a client is allowed
  // to reach is worse than a run that stops and says the document is unusable.
  const t1Range = parseHeadcountRange(t1.company_profile.headcount)
  const t2Range = parseHeadcountRange(t2.company_profile.headcount)

  const mins = [t1Range.min, t2Range.min].filter((n): n is number => n !== null)
  const maxs = [t1Range.max, t2Range.max].filter((n): n is number => n !== null)

  if (mins.length === 0 || maxs.length === 0) {
    const side = mins.length === 0 ? 'lower' : 'upper'
    throw new Error(
      `ICP filter spec: neither tier establishes a ${side} headcount bound. ` +
      `Tier 1 headcount reads ${JSON.stringify(t1.company_profile.headcount)}, ` +
      `tier 2 reads ${JSON.stringify(t2.company_profile.headcount)}. ` +
      'Fix the headcount fields on the ICP document and regenerate the spec.',
    )
  }

  const headcountMin = Math.min(...mins)
  const headcountMax = Math.max(...maxs)

  // Math.min/Math.max over non-empty lists cannot invert this. The check is here so that a
  // later edit to the lines above cannot write an inverted pair to the database, which is
  // what happened before: nothing validated the pair and it was stored exactly as parsed.
  if (headcountMin > headcountMax) {
    throw new Error(
      `ICP filter spec: headcount range inverted (min ${headcountMin} > max ${headcountMax}) ` +
      `from tier 1 ${JSON.stringify(t1.company_profile.headcount)} and ` +
      `tier 2 ${JSON.stringify(t2.company_profile.headcount)}.`,
    )
  }

  return {
    job_titles: [
      'Founder',
      'Owner',
      'Managing Director',
      'Managing Partner',
      'Principal Consultant',
      'Chief Executive Officer',
      'CEO',
      'Director',
    ],
    job_titles_excluded: [
      'Operations Manager',
      'Marketing Coordinator',
      'Marketing Manager',
      'HR Manager',
      'Sales Manager',
      'Business Development Manager',
      'SDR',
      'Sales Development Representative',
    ],
    seniority_levels: (() => {
      const t1Seniority = (t1.buyer_profile?.seniority ?? '').toLowerCase()
      const t2Seniority = (t2.buyer_profile?.seniority ?? '').toLowerCase()
      const isFounderLed = t1Seniority.includes('founder') || t1Seniority.includes('owner') ||
                           t2Seniority.includes('founder') || t2Seniority.includes('owner')

      if (isFounderLed) {
        return ['founder', 'owner', 'c_suite', 'vp', 'director'] as const
      }
      return ['c_suite', 'vp', 'director'] as const
    })() as ICPFilterSpec['seniority_levels'],
    person_countries: DEFAULT_PERSON_COUNTRIES,
    company_countries: DEFAULT_COMPANY_COUNTRIES,
    company_headcount_min: headcountMin,
    company_headcount_max: headcountMax,
    industries,
    industries_excluded: [],
    keywords: ['consulting', 'consultant', 'advisory', 'consultancy'],
    keywords_excluded: DEFAULT_KEYWORDS_EXCLUDED,
    notes:
      `Tier 1 primary: ${t1.company_profile.revenue_range}, ` +
      `headcount ${t1.company_profile.headcount}. ` +
      `Tier 2 secondary: ${t2.company_profile.revenue_range}, ` +
      `headcount ${t2.company_profile.headcount}. ` +
      'Exclude: pre-validation founders (<3 clients, no pricing page), ' +
      'ops managers (not decision-makers), firms with in-house sales teams (10+ people). ' +
      'Sourced countries: ' + DEFAULT_COMPANY_COUNTRIES.join(', ') + '. Review per-client at onboarding.',
  }
}

// ─── Headcount parser ─────────────────────────────────────────────────────────
//
// ONE function returning a PAIR, replacing the previous parseHeadcountMin and
// parseHeadcountMax. Two functions that each re-parsed the same string independently were
// free to disagree about it, which is the parallel-array shape from CLAUDE.md: nothing could
// express the constraint that they describe the same range. A pair makes the disagreement
// unrepresentable.
//
// What the old pair did, measured on real inputs:
//   "Over 500 employees"     min 500, max null  -> caller's ?? fallback gave max 20. INVERTED.
//   "1,000-5,000 employees"  min 1,   max 0     -> it read "1" and "000" as the two bounds.
//   "Fewer than 10 people"   min 10             -> an upper bound stored as a lower one.
// None of that errored. `min` was simply the first integer and `max` the second, so any
// string that was not exactly "<lo> to <hi>" was misread silently, and the misreading went
// to the database as a real filter. resolveHeadcountCeiling reads the max and REMOVES every
// prospect above it, so an inverted or zero ceiling decides who a client may reach.
//
// null on either side means "this string does not bound that end", NOT "use a default".
// Callers must resolve nulls explicitly. See deriveFilterSpec.

export interface HeadcountRange {
  min: number | null
  max: number | null
}

const RANGE_SEPARATOR = /(\d+)\s*(?:-|–|—|to|through)\s*(\d+)/i
const UPPER_BOUND = /\b(?:under|below|fewer than|less than|up to|at most|no more than|maximum(?: of)?|max)\s+(\d+)/i
const LOWER_BOUND = /\b(?:over|above|more than|at least|minimum(?: of)?|min|starting at|from)\s+(\d+)/i
const TRAILING_PLUS = /(\d+)\s*\+/

export function parseHeadcountRange(raw: string | null | undefined): HeadcountRange {
  // Strip the separators out of comma-grouped thousands FIRST. Without this "1,000" is two
  // separate integers to every pattern below, which is exactly how "1,000-5,000" became 1-0.
  const text = (raw ?? '').replace(/(\d),(?=\d{3}\b)/g, '$1')

  // A two-sided range wins over everything else, and is read in EITHER order: a document
  // saying "80-20 people" means the same set as "20-80", and sorting is the only reading
  // that is not simply wrong.
  const range = text.match(RANGE_SEPARATOR)
  if (range) {
    const a = parseInt(range[1], 10)
    const b = parseInt(range[2], 10)
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }

  const upper = text.match(UPPER_BOUND)
  const lower = text.match(LOWER_BOUND) ?? text.match(TRAILING_PLUS)

  // Both directions present without a range separator, e.g. "under X or over Y".
  if (upper && lower) {
    const a = parseInt(upper[1], 10)
    const b = parseInt(lower[1], 10)
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }
  if (upper) return { min: null, max: parseInt(upper[1], 10) }
  if (lower) return { min: parseInt(lower[1], 10), max: null }

  // A single bare figure is an exact size, not the open-ended bound the old code made of it.
  const single = text.match(/(\d+)/)
  if (single) {
    const n = parseInt(single[1], 10)
    return { min: n, max: n }
  }

  // Nothing numeric at all: "Varies", "". Explicitly unbounded on both sides. The caller
  // decides whether it can proceed, because only the caller knows what other evidence it has.
  return { min: null, max: null }
}
