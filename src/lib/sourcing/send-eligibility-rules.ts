// Send eligibility rules: determine whether a prospect can be sent to based on compliance, geography, etc.

import { aliasesForIso2, toIso2CountryCode } from '@/lib/sourcing/country-code'

interface SendEligibilityCheck {
  is_eligible: boolean
  reason: string | null
}

// Country codes that are excluded from sending. ISO 3166-1 alpha-2, canonical.
const EXCLUDED_COUNTRIES = ['DE'] as const

/**
 * Every spelling of every excluded country, precomputed.
 *
 * WHY MATCH ON ALIASES AND NOT JUST THE CANONICAL CODE. Since 2026-08-25 the Apollo
 * handler normalises country to ISO-2 before writing, so in principle this set only ever
 * needs 'DE'. It carries the aliases anyway, and that redundancy is deliberate.
 *
 * The defect this file is being fixed for was exactly a format mismatch between a producer
 * writing "Germany" and this rule matching 'DE', and it went unnoticed long enough that two
 * German prospects were mailed. Normalising at the write path fixes the cause; matching
 * aliases here means the NEXT producer that skips normalisation, or a row written before
 * this change, cannot defeat a compliance rule on a spelling. A geography exclusion is a
 * legal constraint, so it gets belt and braces rather than one correct layer.
 */
const EXCLUDED_COUNTRY_ALIASES: Map<string, string> = new Map(
  EXCLUDED_COUNTRIES.flatMap(code =>
    [...aliasesForIso2(code)].map(alias => [alias, code] as [string, string]),
  ),
)

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
 *
 * NOTE ON THE EARLY RETURN AT STEP 1. A populated, non-excluded country deliberately
 * short-circuits the domain check: an explicit "US" beats a .de vanity domain. That
 * behaviour is asserted by send-eligibility-rules.test.ts and is kept. It is also the
 * reason the backfill of prospects.country had to be normalised rather than copied raw:
 * writing "Germany" into the column would have made the country branch return ELIGIBLE and
 * skipped the .de fallback that was, until now, the only thing excluding anyone at all.
 */
export function checkSendEligibility(
  country: string | null,
  email: string | null,
): SendEligibilityCheck {
  // Check country field (primary source of truth)
  if (country) {
    // Normalise before comparing. A stored value may be canonical ISO-2, or a raw vendor
    // spelling from before normalisation existed, and both must reach the same verdict.
    const canonical = toIso2CountryCode(country)
    const excluded =
      EXCLUDED_COUNTRY_ALIASES.get(canonical ?? '') ??
      EXCLUDED_COUNTRY_ALIASES.get(country.trim().toUpperCase().replace(/\s+/g, ' '))

    if (excluded) {
      return {
        is_eligible: false,
        reason: `country_excluded_${excluded.toLowerCase()}`,
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
