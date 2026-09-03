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

// ─── There is no default keyword list any more ───────────────────────────────
//
// DEFAULT_KEYWORDS_EXCLUDED was four literals naming one market's adjacent categories.
// Every client received them, including clients for whom they name nothing at all. It
// is deleted rather than parameterised, for the same reason the decision-maker list and
// the consultancy patterns were: a default that names a sector is that sector's
// vocabulary applied to everyone, and the client it is wrong for has no way to say so.
//
// Exclusions now come from the client's own ICP disqualifiers, below.

// ─── Deriving words to search on, without naming a sector ────────────────────
//
// RULE ZERO. Nothing in this module may name an industry, a sector, a buyer title or a
// problem domain. So the keywords cannot be a list, and they cannot be a list with a
// switch on top of it. They have to be COMPUTED from the client's own canonical
// industry names, which is the one place a sector name legitimately arrives at run time.
//
// The computation is: the full lowercased name, plus its HEAD NOUN.
//
// The full name is the precise phrase. The head noun is the category word, and it is
// what makes the tiering rescue work at all: a firm's name rarely contains its full
// canonical industry name but often contains the category word. Taking the last word is
// not a linguistic claim, it is a property of how the canonical taxonomy is written,
// where every multi-word name ends in its category.
//
// GENERIC_HEAD_NOUNS is the one judgement here, and it is deliberately tiny. These words
// end a canonical name without saying what the business does, so emitting them as a
// keyword would match almost any company and widen both the sourcing query and the
// tiering rescue to near-uselessness. They are ordinary English, not a sector list.
const GENERIC_HEAD_NOUNS = new Set(['services', 'and', 'the', 'of'])

export function deriveKeywords(industries: readonly string[]): string[] {
  const out: string[] = []
  for (const name of industries) {
    const lower = name.toLowerCase().trim()
    if (!lower) continue
    out.push(lower)

    const words = lower.split(/\s+/)
    if (words.length > 1) {
      const head = words[words.length - 1]
      if (!GENERIC_HEAD_NOUNS.has(head)) out.push(head)
    }
  }
  return [...new Set(out)]
}

// ─── Main derivation function ─────────────────────────────────────────────────

/**
 * Build a client's filter spec from that client's own ICP, and nothing else.
 *
 * ─── WHY THE CRITERION IS A PARAMETER ────────────────────────────────────────
 *
 * `job_titles` and `job_titles_excluded` used to be sixteen literals naming one
 * market's roles, handed to every client. 360 Bia Og sells into schools and its stored
 * spec asked for "Principal Consultant" and "Managing Partner" and excluded "SDR".
 *
 * The right answer already existed and was being computed a few lines later:
 * `buyer_criterion.accept` and `.reject`, derived per client from that client's own
 * documents by the buyer criterion agent. It produced "principal", "deputy principal"
 * and "board of management" for that school. Re-deriving titles here would be a second
 * copy of a judgement that is already made well, and a second copy is what drifts.
 *
 * So the criterion is passed IN rather than duplicated. Its fragments are lowercase
 * title substrings, which is exactly what a provider's title filter wants, so the
 * translation is the identity function and there is nothing in between to get wrong.
 *
 * OPTIONAL, and empty is the honest result when it is absent. A spec with no titles is
 * a spec that cannot build a people search, and the sourcing handler refuses to run on
 * one. That refusal is the point: sourcing a default set of titles is how the wrong
 * market's vocabulary reached a live client, and an error is cheaper than a batch.
 */
export function deriveFilterSpec(
  doc: IcpDocument,
  buyerCriterion?: BuyerCriterion | null,
): ICPFilterSpec {
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
  const t1Min = parseHeadcountMin(t1.company_profile.headcount) ?? 1
  const t1Max = parseHeadcountMax(t1.company_profile.headcount) ?? 20
  const t2Min = parseHeadcountMin(t2.company_profile.headcount) ?? 1
  const t2Max = parseHeadcountMax(t2.company_profile.headcount) ?? 8
  const headcountMin = Math.min(t1Min, t2Min)
  const headcountMax = Math.max(t1Max, t2Max)

  // Titles come from the criterion or not at all. `accept` carries both ranks: the
  // rank drives the fit score, not who gets searched for, so a secondary buyer is still
  // someone to source. A criterion that did not settle (`unsettled` / `out_of_band`)
  // still carries usable fragments, so it is read here even though it does not gate:
  // the alternative is falling back to a default, and there is no default any more.
  const acceptFragments = (buyerCriterion?.accept ?? [])
    .map(entry => entry.fragment.toLowerCase().trim())
    .filter(fragment => fragment.length > 0)
  const rejectFragments = (buyerCriterion?.reject ?? [])
    .map(fragment => fragment.toLowerCase().trim())
    .filter(fragment => fragment.length > 0)

  return {
    job_titles: [...new Set(acceptFragments)],
    job_titles_excluded: [...new Set(rejectFragments)],
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
    keywords: deriveKeywords(industries),

    // NOTHING IS EXCLUDED BY DEFAULT. The four literals that used to sit here named one
    // market's adjacent categories. A client who genuinely needs an exclusion has one in
    // their ICP disqualifiers, which reach `notes` below, and an operator can add one to
    // the spec. An exclusion nobody asked for silently drops inventory, and it drops it
    // for the clients least able to notice.
    keywords_excluded: [],

    // Notes is metadata: it travels with the spec, constrains nothing, and exists to be
    // read by an operator. So it is built ENTIRELY from what this ICP says.
    //
    // The tail it replaces was three sentences of one client's qualification rules
    // handed to every client, ending in "DE and NL included", which had also been false
    // since the country defaults moved to GB/IE/US. A hardcoded note is worse than no
    // note: it reads as a finding about this client and is a finding about another one.
    notes: buildNotes(t1, t2, buyerCriterion),
  }
}

/**
 * Operator-facing summary of what this spec was derived from. Client's words only.
 *
 * The disqualifiers are the ICP's own `disqualifiers` arrays, which is where a client's
 * genuine exclusions already live. Reading them here means an exclusion an operator
 * cares about is visible beside the spec instead of being invented for them.
 */
function buildNotes(
  t1: IcpDocument['tier_1'],
  t2: IcpDocument['tier_2'],
  buyerCriterion?: BuyerCriterion | null,
): string {
  const parts: string[] = [
    `Tier 1 primary: ${t1.company_profile.revenue_range}, headcount ${t1.company_profile.headcount}.`,
    `Tier 2 secondary: ${t2.company_profile.revenue_range}, headcount ${t2.company_profile.headcount}.`,
  ]

  const disqualifiers = [...new Set([
    ...(t1.disqualifiers ?? []),
    ...(t2.disqualifiers ?? []),
  ].map(d => String(d).trim()).filter(d => d.length > 0))]

  if (disqualifiers.length > 0) {
    parts.push(`Excluded by this ICP: ${disqualifiers.join('; ')}.`)
  }

  // Said out loud, because a spec with no titles sources nothing and the operator should
  // learn that here rather than from an empty batch.
  if (!buyerCriterion) {
    parts.push('No buyer criterion was available when this spec was derived, so it carries no job titles.')
  } else if (buyerCriterion.status !== 'derived') {
    parts.push(
      `Buyer criterion status is ${buyerCriterion.status}, so it does not gate. ` +
      `${buyerCriterion.unsettled_reason ?? buyerCriterion.sanity?.note ?? ''}`.trim()
    )
  }

  return parts.join(' ')
}

// ─── Headcount parsers ────────────────────────────────────────────────────────
// Extracts the first/last integer from strings like "1–3 people" or "3–8 people total".

function parseHeadcountMin(raw: string): number | null {
  const m = raw.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

function parseHeadcountMax(raw: string): number | null {
  const matches = [...raw.matchAll(/(\d+)/g)]
  return matches.length >= 2 ? parseInt(matches[1][1], 10) : null
}
