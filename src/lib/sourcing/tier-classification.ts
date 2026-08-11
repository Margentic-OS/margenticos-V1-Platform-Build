import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { logger } from '@/lib/logger'
import { mapApolloToSpecIndustry } from './industry-mapping'

export interface EnrichedProspect {
  id: string
  organisation_id: string
  email_status: string | null
  enrichment_status: string | null
  job_title: string | null
  company_headcount: number | null
  company_industry: string | null
  company_name?: string | null
  company_description?: string | null
}

interface TierResult {
  prospect_id: string
  sourced_tier: 'tier_1' | 'tier_2' | 'tier_3' | null
  classification_reason: string
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
 * Check if company has evidence of being a consultancy/advisory/coaching business.
 * Looks for signals in company name and description.
 */
function hasConsultancyEvidence(prospect: EnrichedProspect): boolean {
  const nameAndDesc = [
    prospect.company_name || '',
    prospect.company_description || '',
  ]
    .join(' ')
    .toLowerCase()

  return CONSULTANCY_PATTERNS.some(pattern => nameAndDesc.includes(pattern))
}

/**
 * Demotion-based tiering: everyone starts tier_1, penalties apply.
 * Final tier = max(tier_1 - penalties, tier_3).
 */
export function classifyTier(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
  tamStatus: string | null,
  tamOverrideReason: string | null,
): TierResult {
  const prospectId = prospect.id

  // GATE 1: Email must be verified
  if (prospect.email_status !== 'verified') {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'email_not_verified',
    }
  }

  // GATE 2: Job title missing = seniority unknown
  if (!prospect.job_title) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'seniority_missing_job_title',
    }
  }

  // GATE 3: Decision-maker check (REMOVE if not decision-maker)
  if (!isDecisionMaker(prospect.job_title)) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'not_decision_maker',
    }
  }

  // DEMOTION-BASED TIERING: start at tier_1, apply penalties
  let tier = 1 // tier_1
  const reasons: string[] = []

  // INDUSTRY DEMOTION: three bands
  if (prospect.company_industry) {
    const mappedIndustry = mapApolloToSpecIndustry(prospect.company_industry)

    // Band 1: EXCLUDED (hard remove)
    if (
      icpFilterSpec.industries_excluded &&
      icpFilterSpec.industries_excluded.some(
        ind => ind.toLowerCase() === mappedIndustry?.toLowerCase()
      )
    ) {
      return {
        prospect_id: prospectId,
        sourced_tier: null,
        classification_reason: 'industry_excluded',
      }
    }

    // Band 2: ON-TARGET (no penalty)
    if (
      icpFilterSpec.industries &&
      icpFilterSpec.industries.some(
        ind => ind.toLowerCase() === mappedIndustry?.toLowerCase()
      )
    ) {
      // No penalty
    } else if (mappedIndustry) {
      // Band 3: ADJACENT (has consultancy evidence) or REMOVE (no consultancy evidence)
      if (hasConsultancyEvidence(prospect)) {
        tier -= 1
        reasons.push('adjacent_industry')
      } else {
        // No consultancy evidence and not on-target/excluded = REMOVE
        return {
          prospect_id: prospectId,
          sourced_tier: null,
          classification_reason: 'industry_not_consulting',
        }
      }
    }
  }

  // HEADCOUNT DEMOTION: outside range = -1 tier
  if (prospect.company_headcount !== null) {
    const min = icpFilterSpec.company_headcount_min || 0
    const max = icpFilterSpec.company_headcount_max || Infinity
    if (prospect.company_headcount < min || prospect.company_headcount > max) {
      tier -= 1
      reasons.push('headcount_out_of_range')
    }
  }

  // Floor at tier_3
  const finalTier = Math.max(tier, 3) as 1 | 2 | 3

  // Build tiering reason string
  let tieringReason: string
  if (reasons.length === 0) {
    tieringReason = 'tier_1: no demotions'
  } else {
    tieringReason = `tier_${finalTier}: ${reasons.join(' + ')}`
  }

  return {
    prospect_id: prospectId,
    sourced_tier: (`tier_${finalTier}` as 'tier_1' | 'tier_2' | 'tier_3'),
    classification_reason: tieringReason,
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

    reasons[result.classification_reason] = (reasons[result.classification_reason] || 0) + 1
  }

  logger.info('tier-classification: demotion-based run complete', {
    organisation_id: organisationId,
    total_classified: results.length,
    tier_1_count: counts.tier_1,
    tier_2_count: counts.tier_2,
    tier_3_count: counts.tier_3,
    removed_count: counts.null,
    breakdown_by_reason: reasons,
  })
}
