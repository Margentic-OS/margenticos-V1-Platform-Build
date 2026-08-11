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

interface TierResult {
  prospect_id: string
  sourced_tier: 'tier_1' | 'tier_2' | 'tier_3' | null
  fit_score: number | null
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
      tiering_reason: 'email_unverified',
    }
  }

  // Disqualifier 2: Job title missing (seniority unknown)
  if (!prospect.job_title) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'no_title',
    }
  }

  // Disqualifier 3: Not a decision-maker
  if (!isDecisionMaker(prospect.job_title)) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'not_decision_maker',
    }
  }

  // Disqualifier 4: Company headcount > 100
  if (prospect.company_headcount !== null && prospect.company_headcount > 100) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'company_too_large',
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
        tiering_reason: 'industry_excluded',
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
        tiering_reason: 'industry_not_consulting',
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

  logger.info('tier-classification: two-stage model run complete', {
    organisation_id: organisationId,
    total_classified: results.length,
    tier_1_count: counts.tier_1,
    tier_2_count: counts.tier_2,
    tier_3_count: counts.tier_3,
    removed_count: counts.null,
    breakdown_by_reason: reasons,
  })
}
