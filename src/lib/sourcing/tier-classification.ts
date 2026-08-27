import type { SupabaseClient } from '@supabase/supabase-js'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { logger } from '@/lib/logger'
import {
  mapApolloToSpecIndustry,
  mapApolloToSpecIndustryWithDatabase,
  loadIndustryTagMappings,
} from './industry-mapping'

export interface EnrichedProspect {
  id: string
  organisation_id: string
  email_status: string | null
  enrichment_status: string | null
  job_title: string | null
  company_headcount: number | null
  company_industry: string | null
  company_name?: string | null
}

// Every reason a prospect can be REMOVED at stage 1. One list, and the reporting
// counts are derived from it rather than hand-listed beside it, so a new
// disqualifier cannot be added without its count appearing in the log.
//
// It is a `const` array rather than a bare union type because a type alone would
// vanish at run time and the counting code would be back to a hand-maintained
// second list. Anything not in here still gets counted, under `removed_other`,
// with the raw reasons named: a reason that falls through must be visible rather
// than silently absent, which is the whole point of this file's changes.
export const REMOVAL_REASONS = [
  'email_unverified',
  'no_title',
  'not_decision_maker',
  'company_too_large',
  'industry_excluded',
  'industry_not_consulting',
] as const

export type RemovalReason = typeof REMOVAL_REASONS[number]

interface TierResult {
  prospect_id: string
  sourced_tier: 'tier_1' | 'tier_2' | 'tier_3' | null
  fit_score: number | null
  // For a removed prospect this is a RemovalReason. For a survivor it is the
  // free-text score breakdown built at the bottom of classifyTier, which is why
  // the type stays `string` rather than narrowing to the union.
  tiering_reason: string
}

// Decision-maker seniority patterns
const DECISION_MAKER_PATTERNS = [
  'founder',
  'co-founder',
  'co founder',
  'owner',
  'ceo',
  'chief executive',
  'chief executive officer',
  'managing partner',
  'managing director',
  'principal',
  'partner',
  'president',
]

// Consultancy evidence patterns
const CONSULTANCY_PATTERNS = [
  'consulting',
  'consultancy',
  'advisory',
  'advisor',
  'coaching',
  'coach',
  'fractional',
]

/**
 * Check if job title indicates decision-maker seniority.
 */
export function isDecisionMaker(jobTitle: string | null): boolean {
  if (!jobTitle) return false

  const titleLower = jobTitle.toLowerCase()
  const titleVariants = titleLower
    .split(/[&/|+]|and/)
    .map(part => part.trim())

  return DECISION_MAKER_PATTERNS.some(pattern =>
    titleVariants.some(variant => variant.includes(pattern))
  )
}

/**
 * Check if company or person has evidence of being a consultancy/advisory/coaching business.
 * Looks for signals in company name and job title.
 */
function hasConsultancyEvidence(prospect: EnrichedProspect): boolean {
  const signals = [
    prospect.company_name || '',
    prospect.job_title || '',
  ]
    .join(' ')
    .toLowerCase()

  return CONSULTANCY_PATTERNS.some(pattern => signals.includes(pattern))
}

/**
 * Calculate seniority score based on job title.
 * Returns 0-35 points based on decision-maker patterns.
 */
function calculateSeniorityScore(jobTitle: string | null): number {
  if (!jobTitle) return 0

  const titleLower = jobTitle.toLowerCase()
  const titleVariants = titleLower
    .split(/[&/|+]|and/)
    .map(part => part.trim())

  for (const variant of titleVariants) {
    if (variant.includes('founder') || variant.includes('co-founder') || variant.includes('co founder') || variant.includes('owner')) {
      return 35 // founder/owner/co-founder
    }
    if (variant.includes('ceo') || variant.includes('chief executive') || variant.includes('managing partner') || variant.includes('managing director')) {
      return 30 // CEO/chief executive/managing partner/managing director
    }
    if (variant.includes('principal') || variant.includes('partner') || (variant === 'president')) {
      return 25 // principal/partner/president
    }
  }

  return 0
}

/**
 * Calculate headcount score based on company size.
 * Returns 0-20 points based on headcount bands.
 */
function calculateHeadcountScore(headcount: number | null): number {
  if (headcount === null || headcount === undefined) return 10 // unknown = 10

  if (headcount >= 1 && headcount <= 20) return 20
  if (headcount >= 21 && headcount <= 50) return 10
  if (headcount >= 51 && headcount <= 100) return 5

  return 0 // Outside the viable range
}

/**
 * Calculate industry score based on mapping to ICP spec.
 * Returns 0-45 points based on on-target vs. adjacent industry.
 */
function calculateIndustryScore(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
  databaseMappings: Record<string, string>,
): number {
  if (!prospect.company_industry) return 0

  const mappedIndustry = mapApolloToSpecIndustryWithDatabase(
    prospect.company_industry,
    databaseMappings,
  )

  if (!mappedIndustry) return 0

  // On-target industry = 45 points
  if (
    icpFilterSpec.industries &&
    icpFilterSpec.industries.some(
      ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
    )
  ) {
    return 45
  }

  // Adjacent industry (has consultancy evidence) = 20 points
  if (hasConsultancyEvidence(prospect)) {
    return 20
  }

  return 0
}

/**
 * Two-stage tiering model:
 * STAGE 1: Disqualifiers (binary REMOVE)
 * STAGE 2: Fit Score (0-100) for survivors
 */
export async function classifyTier(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
  supabase?: SupabaseClient<any>,
): Promise<TierResult> {
  const prospectId = prospect.id

  // Load database mappings for industry if supabase is provided
  let databaseMappings: Record<string, string> = {}
  if (supabase) {
    try {
      databaseMappings = await loadIndustryTagMappings(supabase)
    } catch (error) {
      logger.warn('Failed to load database mappings, falling back to static', {
        prospect_id: prospectId,
        error: String(error),
      })
      databaseMappings = {}
    }
  }

  // STAGE 1: DISQUALIFIERS (binary REMOVE)

  // Disqualifier 1: Email status must be verified
  if (prospect.email_status !== 'verified') {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'email_unverified' satisfies RemovalReason,
    }
  }

  // Disqualifier 2: Job title missing (seniority unknown)
  if (!prospect.job_title) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'no_title' satisfies RemovalReason,
    }
  }

  // Disqualifier 3: Not a decision-maker
  if (!isDecisionMaker(prospect.job_title)) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'not_decision_maker' satisfies RemovalReason,
    }
  }

  // Disqualifier 4: Company headcount > 100
  if (prospect.company_headcount !== null && prospect.company_headcount > 100) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'company_too_large' satisfies RemovalReason,
    }
  }

  // Disqualifier 5: Industry excluded (hard gate)
  if (prospect.company_industry) {
    const mappedIndustry = mapApolloToSpecIndustryWithDatabase(
      prospect.company_industry,
      databaseMappings,
    )

    if (
      mappedIndustry &&
      icpFilterSpec.industries_excluded &&
      icpFilterSpec.industries_excluded.some(
        ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
      )
    ) {
      return {
        prospect_id: prospectId,
        sourced_tier: null,
        fit_score: null,
        tiering_reason: 'industry_excluded' satisfies RemovalReason,
      }
    }
  }

  // Disqualifier 6: Not on-target AND no consultancy evidence
  if (prospect.company_industry) {
    const mappedIndustry = mapApolloToSpecIndustryWithDatabase(
      prospect.company_industry,
      databaseMappings,
    )

    // Check if it's on-target (in the ICP industries list)
    const isOnTarget =
      mappedIndustry &&
      icpFilterSpec.industries &&
      icpFilterSpec.industries.some(
        ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
      )

    // Disqualify if: NOT on-target AND no consultancy evidence
    // This applies to both unmapped industries and mapped-but-off-target industries
    if (!isOnTarget && !hasConsultancyEvidence(prospect)) {
      return {
        prospect_id: prospectId,
        sourced_tier: null,
        fit_score: null,
        tiering_reason: 'industry_not_consulting' satisfies RemovalReason,
      }
    }
  }

  // STAGE 2: FIT SCORE (0-100) for survivors
  const industryScore = calculateIndustryScore(prospect, icpFilterSpec, databaseMappings)
  const seniorityScore = calculateSeniorityScore(prospect.job_title)
  const headcountScore = calculateHeadcountScore(prospect.company_headcount)

  const fitScore = industryScore + seniorityScore + headcountScore

  // Determine tier based on score thresholds
  let tier: 'tier_1' | 'tier_2' | 'tier_3'
  if (fitScore >= 80) {
    tier = 'tier_1'
  } else if (fitScore >= 50) {
    tier = 'tier_2'
  } else {
    tier = 'tier_3'
  }

  const tiering_reason = `${tier} (score ${fitScore}): industry ${industryScore}, seniority ${seniorityScore}, headcount ${headcountScore}`

  return {
    prospect_id: prospectId,
    sourced_tier: tier,
    fit_score: fitScore,
    tiering_reason,
  }
}

export function logClassificationStats(
  results: TierResult[],
  organisationId: string,
): void {
  const counts = {
    tier_1: 0,
    tier_2: 0,
    tier_3: 0,
    null: 0,
  }

  const reasons: Record<string, number> = {}

  for (const result of results) {
    if (result.sourced_tier) {
      counts[result.sourced_tier]++
    } else {
      counts.null++
    }

    reasons[result.tiering_reason] = (reasons[result.tiering_reason] || 0) + 1
  }

  // ── Flat, greppable removal counts ─────────────────────────────────────────
  //
  // WHY FLAT AND NOT NESTED. `breakdown_by_reason` is a nested object, so in the
  // production log stream the only literal that appears is the outer key. A search
  // for `industry_not_consulting` finds it inside the JSON blob but nothing can
  // alert or chart on it without parsing the object first. `removed_industry_not_consulting`
  // is a key in its own right, always present, always a number.
  //
  // ALWAYS PRESENT, including as a zero. A key that only appears when non-zero
  // makes "no prospects were removed for this reason" and "this reason is no longer
  // being counted" look identical downstream, which is the failure mode this whole
  // change exists to remove.
  //
  // Derived from REMOVAL_REASONS with Object.fromEntries rather than written out,
  // so the counts and the reasons cannot drift into the parallel-array shape.
  const removedCounts = Object.fromEntries(
    REMOVAL_REASONS.map(reason => [`removed_${reason}`, reasons[reason] ?? 0]),
  ) as Record<`removed_${RemovalReason}`, number>

  // Anything that removed a prospect without being a registered reason. Counted
  // and NAMED rather than dropped: an unregistered reason is a defect in this
  // file, and it must not be the quiet kind.
  const knownReasons = new Set<string>(REMOVAL_REASONS)
  const otherRemovalReasons = results
    .filter(r => r.sourced_tier === null && !knownReasons.has(r.tiering_reason))
    .map(r => r.tiering_reason)
  const removedOther = otherRemovalReasons.length

  const payload = {
    organisation_id: organisationId,
    total_classified: results.length,
    tier_1_count: counts.tier_1,
    tier_2_count: counts.tier_2,
    tier_3_count: counts.tier_3,
    removed_count: counts.null,
    ...removedCounts,
    removed_other: removedOther,
    ...(removedOther > 0
      ? { removed_other_reasons: Array.from(new Set(otherRemovalReasons)) }
      : {}),
    breakdown_by_reason: reasons,
  }

  // warn when the batch lost prospects, info when it did not.
  //
  // These were already logger.info, which the logger does NOT suppress in
  // production (only `debug` is suppressed, src/lib/logger/index.ts). So the
  // counts did reach the logs. What they did not do is stand out: a batch where
  // every prospect was removed produced a line indistinguishable in level from a
  // batch where none were, sitting in a stream of ordinary run-progress info.
  // warn is what separates them.
  if (counts.null > 0) {
    logger.warn('tier-classification: two-stage model run complete, prospects were removed', payload)
  } else {
    logger.info('tier-classification: two-stage model run complete', payload)
  }
}
