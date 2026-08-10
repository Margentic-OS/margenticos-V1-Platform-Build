// Send eligibility rules: determine whether a prospect can be sent to based on compliance, geography, etc.

interface SendEligibilityCheck {
  is_eligible: boolean
  reason: string | null
}

// Country codes that are excluded from sending
const EXCLUDED_COUNTRIES = new Set(['DE'])

// Domain suffixes that map to excluded countries
const EXCLUDED_DOMAIN_SUFFIXES: Map<string, string> = new Map([
  ['.de', 'DE'],
])

/**
 * Determine if a prospect is eligible for sending based on country/geography rules.
 * Returns { is_eligible, reason } where reason is null if eligible, or a code if not.
 *
 * Eligibility rules:
 * 1. If country is populated, check against exclusion list (e.g., DE)
 * 2. If country is null, infer from email domain (e.g., @example.de → Germany)
 *
 * Exclusion reasons:
 * - 'country_excluded_de': Prospect is from Germany (excluded per compliance decision)
 */
export function checkSendEligibility(
  country: string | null,
  email: string | null,
): SendEligibilityCheck {
  // Check country field (primary source of truth)
  if (country) {
    if (EXCLUDED_COUNTRIES.has(country)) {
      return {
        is_eligible: false,
        reason: `country_excluded_${country.toLowerCase()}`,
      }
    }
    return { is_eligible: true, reason: null }
  }

  // Infer country from email domain if country field is null
  if (email) {
    const domain = email.split('@')[1]?.toLowerCase()
    if (domain) {
      for (const [suffix, inferredCountry] of EXCLUDED_DOMAIN_SUFFIXES.entries()) {
        if (domain.endsWith(suffix)) {
          return {
            is_eligible: false,
            reason: `country_excluded_${inferredCountry.toLowerCase()}`,
          }
        }
      }
    }
  }

  // No exclusion applies
  return { is_eligible: true, reason: null }
}
