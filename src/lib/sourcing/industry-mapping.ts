import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'

// Apollo industry tags to ICP spec consulting verticals mapping
// Apollo uses broad sectors; spec uses consulting-specific names
// This layer normalizes Apollo tags to spec industries with fail-closed behavior

const TAG_ALIASES: Record<string, string> = {
  'human resources': 'Human Resources Consulting',
  'information technology & services': 'Information Technology Consulting',
  'financial services': 'Financial Advisory Services',
  'professional training & coaching': 'Business Coaching',
  'management consulting': 'Management Consulting',
  'marketing & advertising': 'Marketing Consulting',
  'digital marketing': 'Marketing Consulting',
  'marketing consulting': 'Marketing Consulting',
  'operations consulting': 'Operations Consulting',
  'strategy consulting': 'Strategy Consulting',
  'sales consulting': 'Sales Consulting',
  'change management': 'Change Management Consulting',
  'supply chain': 'Supply Chain Consulting',
  'procurement': 'Procurement Consulting',
  'risk management': 'Risk Management Consulting',
  'compliance': 'Compliance Consulting',
  'data analytics': 'Data Analytics Consulting',
  'business coaching': 'Business Coaching',
  'executive coaching': 'Business Coaching',
  'organizational development': 'Change Management Consulting',
  'hr consulting': 'Human Resources Consulting',
  'it consulting': 'Information Technology Consulting',
}

// ─── Layer 1: the identity map, DERIVED from the canonical taxonomy ──────────
//
// Every canonical industry, keyed by its own lowercased name. Derived from
// CANONICAL_INDUSTRIES rather than listed, so a name added to the taxonomy is
// recognisable here in the same commit with nothing to remember. There is no second
// list that can fall out of step with the first.
//
// IT INVENTS NO PROVIDER VOCABULARY. It resolves a tag only when the provider's own
// string already IS a canonical name, which is a fact about the two strings rather than
// a guess about the provider. Writing the provider's tag spellings from memory is the
// separate, unmeasurable thing the BACKLOG entry refuses to do, and this does not do it:
// a tag whose wording differs still returns null, still fails closed, and still reaches
// the operator's mapping queue.
//
// MEASURED against the 24 distinct company_industry values stored in the prospects table
// on 2026-09-03: three of them resolve on this layer and previously resolved nowhere.
// The rest are wording gaps that only a paid enrichment sample can close, as recorded.
const CANONICAL_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  CANONICAL_INDUSTRIES.map(name => [name.toLowerCase(), name]),
)

// ─── What this mapping can PRODUCE ───────────────────────────────────────────
//
// The set of canonical industry names a sourced prospect can ever be classified as.
//
// DERIVED FROM THE TAXONOMY AS OF 2026-09-03, and that is the substance of the change.
// It used to be `new Set(Object.values(TAG_ALIASES))`: the 15 distinct values of the
// hand-written table above, every one of them from a single market. Because that table
// is MANY-TO-ONE and therefore not invertible, 58 of the 73 canonical names had no route
// back at all. A client could name such an industry, pass the orchestrator's reachability
// gate, pay to source and enrich it, and then lose every prospect at classification under
// `industry_off_target` with nothing saying the sector was merely unknown to the
// translator. That was structural rather than a short list of oversights, which is why it
// is closed by deriving the set instead of by extending the list.
//
// LIMIT, stated so it is not over-trusted: this is the STATIC range. Operators can add
// rows to industry_tag_mappings, which can only ADD names, never remove them, so a name
// absent here may still be classifiable in practice. That is why every consumer of this
// set reports rather than gates, and why callers may pass extra names they know about.
export const CLASSIFIABLE_INDUSTRIES: ReadonlySet<string> = new Set<string>([
  ...CANONICAL_BY_LOWERCASE.values(),
  ...Object.values(TAG_ALIASES),
])

// Cache for database mappings — keyed by apollo_tag
let mappingCache: Record<string, string> | null = null
let cacheFetchedAt: number = 0
const CACHE_TTL_MS = 60000 // 1 minute cache

export function mapApolloToSpecIndustry(apolloIndustry: string | null): string | null {
  if (!apolloIndustry) return null

  const normalised = apolloIndustry.toLowerCase().trim()

  // 1. The provider's own string IS a canonical name. Exact, and checked first.
  //
  // ORDER IS LOAD-BEARING FOR EXACTLY ONE KEY. 'executive coaching' is both a canonical
  // name and an alias key pointing at a DIFFERENT canonical name. Identity-first is what
  // stops a provider tag that names a canonical industry precisely from being rewritten
  // into a neighbouring one, and that collision is why 'Executive Coaching' was one of
  // the four industries this handler could target and never classify. Measured: no
  // stored prospect carries that tag, so this reorders nothing that exists today.
  const identity = CANONICAL_BY_LOWERCASE.get(normalised)
  if (identity) {
    return identity
  }

  // 2. A known alias, for a tag whose wording differs from the canonical name.
  if (TAG_ALIASES[normalised]) {
    return TAG_ALIASES[normalised]
  }

  // 3. The same aliases, contained in a longer tag.
  //
  // SUBSTRING MATCHING IS DELIBERATELY NOT EXTENDED TO THE 73 CANONICAL NAMES. Each
  // alias key was chosen against a tag known to contain it. A short canonical name found
  // inside an unrelated longer tag would misclassify SILENTLY, which is worse than
  // returning null, and no measurement supports doing it.
  for (const [key, value] of Object.entries(TAG_ALIASES)) {
    if (normalised.includes(key)) {
      return value
    }
  }

  // No match. Fail closed: an unknown tag is flagged for operator mapping, never guessed.
  return null
}

// Load database mappings and cache them
export async function loadIndustryTagMappings(
  supabase: SupabaseClient<any>,
): Promise<Record<string, string>> {
  const now = Date.now()

  // Return cached mappings if still fresh
  if (mappingCache && now - cacheFetchedAt < CACHE_TTL_MS) {
    return mappingCache
  }

  const { data: mappings, error } = await supabase
    .from('industry_tag_mappings')
    .select('apollo_tag, canonical_industry') as any

  if (error) {
    // Log error but don't crash — fall back to static mappings
    console.error('Failed to load industry tag mappings:', error)
    return {}
  }

  // Build cache from database mappings
  const cache: Record<string, string> = {}
  if (Array.isArray(mappings)) {
    for (const mapping of mappings) {
      if (mapping && mapping.apollo_tag && mapping.canonical_industry) {
        cache[mapping.apollo_tag.toLowerCase()] = mapping.canonical_industry
      }
    }
  }

  mappingCache = cache
  cacheFetchedAt = now
  return cache
}

// Clear cache when a new mapping is added (called from API endpoint)
export function clearIndustryMappingCache(): void {
  mappingCache = null
  cacheFetchedAt = 0
}

export function mapApolloToSpecIndustryWithDatabase(
  apolloIndustry: string | null,
  databaseMappings: Record<string, string>,
): string | null {
  if (!apolloIndustry) return null

  const normalised = apolloIndustry.toLowerCase().trim()

  // Check database mappings first (operator-added mappings take precedence)
  if (databaseMappings[normalised]) {
    return databaseMappings[normalised]
  }

  // Fall back to static mapping
  return mapApolloToSpecIndustry(apolloIndustry)
}

export function getIndustryMappingNote(apolloIndustry: string | null): string {
  if (!apolloIndustry) return 'no_industry_data'

  const mapped = mapApolloToSpecIndustry(apolloIndustry)
  if (mapped) {
    return `mapped: ${apolloIndustry} -> ${mapped}`
  }

  return `unmapped: ${apolloIndustry}`
}
