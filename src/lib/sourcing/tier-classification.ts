import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { logger } from '@/lib/logger'

export interface EnrichedProspect {
  id: string
  organisation_id: string
  email_status: string | null
  enrichment_status: string | null
  job_title: string | null
  company_headcount: number | null
  company_industry: string | null
}

interface TierResult {
  prospect_id: string
  sourced_tier: 'tier_1' | 'tier_2' | 'tier_3' | null
  classification_reason: string
}

// Decision-maker seniority levels per PRD-15 and DECISION 2
const DECISION_MAKER_SENIORITY = ['owner', 'founder', 'c_suite', 'vp']

export function classifyTier(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
  tamStatus: string | null,
  tamOverrideReason: string | null,
): TierResult {
  const prospectId = prospect.id

  // Gate 1: Email must be verified
  if (prospect.email_status !== 'verified') {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: `non_verified_email (${prospect.email_status})`,
    }
  }

  // Gate 2: Job title missing means we don't know seniority - discard
  if (!prospect.job_title) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'missing_job_title_seniority_unknown',
    }
  }

  // Extract seniority from job title (case-insensitive check)
  // Simplified: if job_title contains decision-maker keywords, it's a match
  const jobTitleLower = prospect.job_title.toLowerCase()
  const isDecisionMaker = DECISION_MAKER_SENIORITY.some(
    level => jobTitleLower.includes(level) || jobTitleLower.includes(level.replace('_', ' '))
  )

  // Gate 3: Must be decision-maker seniority (this is NEVER loosened per DECISION 2)
  if (!isDecisionMaker) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'non_decision_maker_seniority_rejected',
    }
  }

  // Tier 1: Strict match on all dimensions
  if (matchesTier1Strict(prospect, icpFilterSpec)) {
    return {
      prospect_id: prospectId,
      sourced_tier: 'tier_1',
      classification_reason: 'tier_1_strict_match',
    }
  }

  // Tier 2: Loosened on ONE dimension (headcount OR industry), but not both
  if (matchesTier2Loosened(prospect, icpFilterSpec)) {
    return {
      prospect_id: prospectId,
      sourced_tier: 'tier_2',
      classification_reason: 'tier_2_loosened_match',
    }
  }

  // Tier 3: Significantly loosened, BUT only if TAM allows
  const tier3Allowed = tamStatus === 'amber' || (tamStatus === 'red' && !!tamOverrideReason)
  if (tier3Allowed && matchesTier3Loosened(prospect, icpFilterSpec)) {
    return {
      prospect_id: prospectId,
      sourced_tier: 'tier_3',
      classification_reason: 'tier_3_loosened_match_tam_allowed',
    }
  }

  // No tier matched
  const tierDisqualifier = tier3Allowed ? 'no_tier_match' : 'no_tier_match_tam_blocks_tier3'
  return {
    prospect_id: prospectId,
    sourced_tier: null,
    classification_reason: tierDisqualifier,
  }
}

function matchesTier1Strict(
  prospect: EnrichedProspect,
  spec: ICPFilterSpec,
): boolean {
  // Industry: must match one of the ICP's industries exactly
  if (
    spec.industries &&
    spec.industries.length > 0 &&
    prospect.company_industry
  ) {
    const industryMatch = spec.industries.some(
      ind => ind.toLowerCase() === prospect.company_industry!.toLowerCase()
    )
    if (!industryMatch) return false
  } else if (spec.industries && spec.industries.length > 0 && !prospect.company_industry) {
    // ICP specifies industries but prospect has no industry data
    return false
  }

  // Headcount: must be within [min, max] range
  if (prospect.company_headcount !== null) {
    const min = spec.company_headcount_min || 0
    const max = spec.company_headcount_max || Infinity
    if (prospect.company_headcount < min || prospect.company_headcount > max) {
      return false
    }
  } else if ((spec.company_headcount_min !== undefined || spec.company_headcount_max !== undefined) && prospect.company_headcount === null) {
    // ICP specifies headcount but prospect has no headcount data
    return false
  }

  return true
}

function matchesTier2Loosened(
  prospect: EnrichedProspect,
  spec: ICPFilterSpec,
): boolean {
  // First check: is this a Tier 1 match? If yes, don't classify as Tier 2.
  if (matchesTier1Strict(prospect, spec)) {
    return false
  }

  // Tier 2: at least ONE of these is true:
  // 1. Headcount within +/-50% widened range
  // 2. Industry adjacent (in the industry list, even if not exact match)

  let headcountMatches = false
  let industryMatches = false

  // Check headcount: within ±50% widened range
  if (prospect.company_headcount !== null) {
    const min = spec.company_headcount_min || 0
    const max = spec.company_headcount_max || Infinity
    const wideMin = Math.max(0, min * 0.5)
    const wideMax = max * 1.5
    if (prospect.company_headcount >= wideMin && prospect.company_headcount <= wideMax) {
      headcountMatches = true
    }
  } else {
    // No headcount data, can't match on this dimension
    headcountMatches = false
  }

  // Check industry: matches ICP's industry list (adjacent = in list)
  if (prospect.company_industry && spec.industries && spec.industries.length > 0) {
    const industryMatch = spec.industries.some(
      ind => ind.toLowerCase() === prospect.company_industry!.toLowerCase()
    )
    if (industryMatch) {
      industryMatches = true
    }
  }

  // Tier 2 if at least one dimension matches (but NOT Tier 1)
  return headcountMatches || industryMatches
}

function matchesTier3Loosened(
  prospect: EnrichedProspect,
  spec: ICPFilterSpec,
): boolean {
  // First check: is this already Tier 1 or Tier 2? If yes, don't classify as Tier 3.
  if (matchesTier1Strict(prospect, spec) || matchesTier2Loosened(prospect, spec)) {
    return false
  }

  // Tier 3: significantly loosened
  // Very permissive: headcount way out of range OR industry mismatch
  // Just check: has some viable firmographic data and decision-maker seniority (already checked)

  // If we have headcount OR industry data, prospect qualifies for Tier 3
  const hasHeadcount = prospect.company_headcount !== null
  const hasIndustry = prospect.company_industry !== null

  return hasHeadcount || hasIndustry
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

  logger.info('tier-classification: run complete', {
    organisation_id: organisationId,
    total_classified: results.length,
    tier_1_count: counts.tier_1,
    tier_2_count: counts.tier_2,
    tier_3_count: counts.tier_3,
    untiered_count: counts.null,
    breakdown_by_reason: reasons,
  })
}
