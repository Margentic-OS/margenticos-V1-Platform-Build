// Send eligibility rules: determine whether a prospect can be sent to based on compliance, geography, etc.

import { aliasesForIso2, toIso2CountryCode } from '@/lib/sourcing/country-code'

export interface SendEligibilityCheck {
  is_eligible: boolean
  reason: string | null
}

// Country codes that are excluded from sending. ISO 3166-1 alpha-2, canonical.
//
// EXPORTED, membership unchanged. The ICP filter spec derivation subtracts this together
// with the sourcing-side list at one single point, so an excluded country never enters a
// client's spec in the first place. This rule keeps firing exactly as it did: it is the
// last line for prospects already in the database, which a derivation-time subtraction
// cannot reach. See src/lib/sourcing/geography-exclusion.ts.
export const EXCLUDED_COUNTRIES = ['DE'] as const

/**
 * The value written to prospects.email_send_ineligible_reason when an OPERATOR has placed a
 * durable hold on a prospect, as opposed to a rule having excluded it.
 *
 * WHY THIS STRING EXISTS AT ALL. Until 2026-09-07 that column carried exactly one shape of
 * value, `country_excluded_<code>`, and two readers took the shortcut of treating ANY
 * non-null value as a country exclusion:
 *
 *   send-eligibility-policy.ts   the research spend gate
 *   prospect-status.ts           the operator display
 *
 * So the column could not record a second kind of block without both of them misreporting
 * it. That is the whole reason three hand-held prospects had a NULL reason: there was
 * nowhere truthful to put one. Both readers now match on the VALUE rather than on
 * non-nullness, and this constant is the value they match.
 */
export const OPERATOR_HOLD_REASON = 'operator_hold'

/**
 * Is this reason one of the country-exclusion codes produced by checkSendEligibility?
 *
 * Exported so the readers do not each re-derive the prefix. Note the deliberate asymmetry
 * with OPERATOR_HOLD_REASON above: a hold is ONE exact value and is matched by equality, a
 * country exclusion is a FAMILY of values (one per country) and is matched by prefix.
 */
export function isCountryExclusionReason(reason: string | null): boolean {
  return reason !== null && reason.startsWith('country_excluded_')
}

/** What the first pass writes to the two materialised send-eligibility columns. */
export interface FirstPassSendEligibility {
  email_send_eligible: boolean
  email_send_ineligible_reason: string | null
}

/**
 * The first pass's send-eligibility policy, as a pure function.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO LINES INSIDE recordVerificationResult, WHERE IT LIVED.
 *
 * It was an inline expression in verification-trigger.ts, assembled from a country check and
 * a vendor boolean. Inline, it could not be tested without a database, so the guard that
 * matters most here (an operator hold must survive re-verification) would have been provable
 * only through a live-database test. Extracted, it is provable by deleting one term and
 * watching a unit test go red.
 *
 * THE HOLD IS ANDed IN, so it can only ever REMOVE eligibility and never grant it, and it
 * reports its OWN reason so the row does not claim to be a country exclusion.
 *
 * This is deliberately NOT resolveSendEligibility. That function applies the full two-pass
 * disagreement rule and would change the verdict for rows that are not held, which is a
 * larger change than making a hold durable. Unifying the two is tracked separately.
 */
export function firstPassSendEligibility(args: {
  /** prospects.send_hold_at. Non-null means an operator has held this prospect. */
  heldAt: string | null
  /** The country rule's verdict for this prospect. */
  country: SendEligibilityCheck
  /** The vendor handler's own send_eligible boolean for this verification result. */
  vendorSendEligible: boolean
}): FirstPassSendEligibility {
  if (args.heldAt !== null) {
    return { email_send_eligible: false, email_send_ineligible_reason: OPERATOR_HOLD_REASON }
  }
  return {
    email_send_eligible: args.country.is_eligible && args.vendorSendEligible,
    email_send_ineligible_reason: args.country.reason,
  }
}

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
