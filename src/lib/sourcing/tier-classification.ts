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
}

interface TierResult {
  prospect_id: string
  sourced_tier: 'tier_1' | 'tier_2' | 'tier_3' | null
  classification_reason: string
}

// Decision-maker seniority patterns per spec
// Matches titles containing: founder, owner, co-founder, CEO/chief executive,
// managing partner, managing director, principal (consultant), partner
// Must handle compound titles with separators: &, /, |, +, "and"
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
]

/**
 * Check if job title indicates decision-maker seniority.
 * Handles compound titles and separator variations (&, /, |, +, "and").
 */
export function isDecisionMaker(jobTitle: string | null): boolean {
  if (!jobTitle) return false

  const titleLower = jobTitle.toLowerCase()

  // Split on common separators to handle compound titles
  // e.g., "Founder & CEO", "CEO/President", "Principal|Partner"
  const titleVariants = titleLower
    .split(/[&/|+]|and/)
    .map(part => part.trim())

  // Check if any part or the full title matches a decision-maker pattern
  return DECISION_MAKER_PATTERNS.some(pattern =>
    titleVariants.some(variant => variant.includes(pattern))
  )
}

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
      classification_reason: `email_not_verified`,
    }
  }

  // Gate 2: Job title missing means we don't know seniority - discard
  if (!prospect.job_title) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'seniority_missing_job_title',
    }
  }

  // Gate 3: Must be decision-maker seniority (this is NEVER loosened per DECISION 2)
  if (!isDecisionMaker(prospect.job_title)) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'seniority_non_decision_maker',
    }
  }

  // Gate 4: Industry is NEVER relaxable - must match spec industries for ANY tier
  // If industry is outside spec, route to untiered regardless of other criteria
  if (!matchesIndustrySpec(prospect, icpFilterSpec)) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      classification_reason: 'industry_outside_spec',
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

  // If Tier 1 failed, identify specific reason (INDUSTRY or SIZE)
  const tier1Reason = getTier1FailureReason(prospect, icpFilterSpec)

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

  // No tier matched - use Tier 1 failure reason (INDUSTRY or SIZE)
  return {
    prospect_id: prospectId,
    sourced_tier: null,
    classification_reason: tier1Reason,
  }
}

function getTier1FailureReason(
  prospect: EnrichedProspect,
  spec: ICPFilterSpec,
): string {
  // Determine what caused Tier 1 to fail: INDUSTRY or SIZE

  // Check industry match
  let industryMatch = true
  if (spec.industries && spec.industries.length > 0 && prospect.company_industry) {
    industryMatch = spec.industries.some(
      ind => ind.toLowerCase() === prospect.company_industry!.toLowerCase()
    )
  } else if (spec.industries && spec.industries.length > 0 && !prospect.company_industry) {
    industryMatch = false
  }

  // Check headcount match
  let headcountMatch = true
  if (prospect.company_headcount !== null) {
    const min = spec.company_headcount_min || 0
    const max = spec.company_headcount_max || Infinity
    headcountMatch =
      prospect.company_headcount >= min && prospect.company_headcount <= max
  } else if (
    (spec.company_headcount_min !== undefined || spec.company_headcount_max !== undefined) &&
    prospect.company_headcount === null
  ) {
    headcountMatch = false
  }

  // Return specific reason for Tier 1 failure
  if (!industryMatch && !headcountMatch) {
    return 'industry_size_both_reject'
  } else if (!industryMatch) {
    return 'industry_mismatch'
  } else if (!headcountMatch) {
    return 'size_mismatch'
  }

  // Should not reach here if Tier 1 fails, but return generic reason
  return 'tier_1_mismatch'
}

function matchesIndustrySpec(
  prospect: EnrichedProspect,
  spec: ICPFilterSpec,
): boolean {
  // Check if prospect's industry is in the spec's industry list
  // Industry is non-relaxable: must match for ANY tier
  // Uses Apollo->Spec mapping layer to normalize vendor vocabulary

  if (spec.industries && spec.industries.length > 0 && prospect.company_industry) {
    // Map Apollo industry to spec terminology
    const mappedIndustry = mapApolloToSpecIndustry(prospect.company_industry)

    if (mappedIndustry) {
      // Mapped successfully - check if it's in spec
      return spec.industries.some(
        ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
      )
    }

    // No mapping found - fail closed (prospect is outside spec)
    return false
  } else if (spec.industries && spec.industries.length > 0 && !prospect.company_industry) {
    // ICP specifies industries but prospect has no industry data - treat as outside spec
    return false
  }

  // If ICP doesn't specify industries, industry check passes
  return true
}

function matchesTier1Strict(
  prospect: EnrichedProspect,
  spec: ICPFilterSpec,
): boolean {
  // Industry check already handled in main classifyTier gate
  // Here just check headcount for strict match

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

  // Tier 2: Loosened on headcount only (industry is non-relaxable, checked at gate level)
  // Headcount must be within ±50% widened range
  if (prospect.company_headcount !== null) {
    const min = spec.company_headcount_min || 0
    const max = spec.company_headcount_max || Infinity
    const wideMin = Math.max(0, min * 0.5)
    const wideMax = max * 1.5
    return prospect.company_headcount >= wideMin && prospect.company_headcount <= wideMax
  }

  // No headcount data and doesn't match Tier 1, doesn't qualify for Tier 2
  return false
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
