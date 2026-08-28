import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Apollo industry tags to ICP spec consulting verticals mapping
// Apollo uses broad sectors; spec uses consulting-specific names
// This layer normalizes Apollo tags to spec industries with fail-closed behavior

const APOLLO_TO_SPEC: Record<string, string> = {
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

// ─── What this mapping can PRODUCE ───────────────────────────────────────────
//
// The RANGE of APOLLO_TO_SPEC, not its domain. This is the set of canonical industry
// names a sourced prospect can ever be classified as.
//
// It exists because the map is MANY-TO-ONE and therefore not invertible. Both
// 'business coaching' and 'executive coaching' map to 'Business Coaching', so the
// canonical name 'Executive Coaching' is in CANONICAL_INDUSTRIES, is listed in the
// Apollo handler's APOLLO_TARGETED_INDUSTRIES, passes the orchestrator's reachability
// gate, and can then never come back out of this function. A client whose ICP named
// only that industry would pass every pre-search check and lose every prospect to
// `industry_not_consulting` at tier classification.
//
// LIMIT, stated so it is not over-trusted: this is the STATIC range only. Operators can
// add rows to industry_tag_mappings, which can only ADD names, never remove them. So a
// name flagged here may be classifiable in practice. That is why every consumer of this
// set reports rather than gates, and why callers may pass extra names they know about.
export const CLASSIFIABLE_INDUSTRIES: ReadonlySet<string> = new Set(
  Object.values(APOLLO_TO_SPEC),
)

// Cache for database mappings — keyed by apollo_tag
let mappingCache: Record<string, string> | null = null
let cacheFetchedAt: number = 0
const CACHE_TTL_MS = 60000 // 1 minute cache

export function mapApolloToSpecIndustry(apolloIndustry: string | null): string | null {
  if (!apolloIndustry) return null

  const normalised = apolloIndustry.toLowerCase().trim()

  // Direct match in static mapping
  if (APOLLO_TO_SPEC[normalised]) {
    return APOLLO_TO_SPEC[normalised]
  }

  // Partial match: if the Apollo tag contains one of our mapping keys
  for (const [key, value] of Object.entries(APOLLO_TO_SPEC)) {
    if (normalised.includes(key)) {
      return value
    }
  }

  // No match found - fail closed, return null (will be flagged)
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
