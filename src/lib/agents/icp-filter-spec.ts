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
  seniority_levels: ('c_suite' | 'vp' | 'director' | 'manager' | 'senior' | 'entry')[]
  departments: string[]
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
}

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
// DE and NL included: meaningful pockets of English-operating consulting founders.
// Modify per-client in the filter spec approval UI when needed.

const DEFAULT_PERSON_COUNTRIES = ['GB', 'IE', 'US', 'CA', 'AU', 'DE', 'NL']
const DEFAULT_COMPANY_COUNTRIES = ['GB', 'IE', 'US', 'CA', 'AU', 'DE', 'NL']

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

  // Headcount: Tier 1 min / Tier 2 max combined.
  // The ICP headcount strings are human-readable ("1–3 people") — parse the bounds.
  const headcountMin = parseHeadcountMin(t1.company_profile.headcount) ?? 1
  const headcountMax = parseHeadcountMax(t2.company_profile.headcount) ?? 8

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
    seniority_levels: ['c_suite', 'vp', 'director'],
    departments: ['executive', 'management'],
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
      'DE and NL included: English-operating consulting founders. Review per-client at onboarding.',
  }
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
