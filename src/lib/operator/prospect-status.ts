// Reading a prospect's status the way an operator needs to see it.
//
// Three questions the pipeline screen could not answer, all of them answerable from columns
// that were already populated and simply never read:
//
//   CAN THIS BE EMAILED?      email_send_eligible exists. A card reading "Tier 1: 93" while
//                             only 73 of those can be emailed is not a small imprecision:
//                             it is the number the operator plans a campaign around.
//   WHY WAS IT TIERED THERE?  tiering_reason holds the disqualifier for removed rows and the
//                             full score breakdown for kept ones. The review table rendered
//                             it as a raw string truncated at 140 pixels, which shows
//                             "tier_1 (score 100)..." and cuts off everything that explains
//                             the score. The reason was on screen and unreadable.
//   DID VERIFICATION FAIL?    last_verification_error exists. A third of a cohort sat on
//                             vendor 403 and 429 responses for ninety minutes with nothing
//                             anywhere in the product saying so.
//
// ═════════════════════════════════════════════════════════════════════════════
// RULE ZERO: NOTHING VENDOR-SPECIFIC OR CLIENT-SPECIFIC REACHES A LABEL
//
// This matters more here than anywhere else on the screen, because two of the three columns
// contain exactly that:
//
//   last_verification_error      holds text like "Email verification failed:
//                                <vendor> API returned 429". Rendering the column would put
//                                a vendor name on the screen. Only the HTTP status and the
//                                attempt count are surfaced.
//   email_send_ineligible_reason holds values like "country_excluded_de". Rendering it would
//                                put a country code on the screen. It is bucketed to
//                                "excluded country" with no country named.
//
// The codes stay canonical in the database and in these types. Only the LABELS are neutral,
// and they live in one map at the bottom of this file.

import { toCanonicalVerdict } from '@/lib/sourcing/verification-verdict'
import { REMOVAL_REASONS } from '@/lib/sourcing/tier-classification'

// ═════════════════════════════════════════════════════════════════════════════
// ITEM 4: CAN THIS PROSPECT BE EMAILED, AND IF NOT, WHY

/**
 * Why a tiered prospect cannot be emailed.
 *
 * `no_reason_recorded` is not a defensive default. MEASURED ON PRODUCTION 2026-09-02: of
 * the 24 tiered prospects that cannot be emailed, 3 carry a reason and 21 do not.
 * email_send_ineligible_reason is only ever written by the country rule, so every prospect
 * blocked by its VERIFICATION verdict arrives here with the column null. The verdict is
 * therefore consulted as a fallback below, and the bucket exists for what is left, because a
 * count of "we do not know" that is visible is worth more than one folded into a neighbour.
 */
export type NotSendableReason =
  | 'excluded_country'
  | 'not_verified'
  | 'undeliverable'
  | 'unconfirmable'
  | 'no_reason_recorded'

/** The columns this module reads. Named so a caller cannot pass the wrong shape by accident. */
export interface SendabilityFacts {
  email_send_eligible: boolean | null
  email_send_ineligible_reason: string | null
  independent_verified_at: string | null
  independent_email_status: string | null
  verification_provider: string | null
  second_pass_status: string | null
  second_pass_provider: string | null
}

/**
 * Why this prospect cannot be emailed, or null when it can.
 *
 * READS THE MATERIALISED VERDICT, DELIBERATELY, unlike checkResearchEligibility next door.
 * The two answer different questions. That one asks "is this worth spending research money
 * on", which is a policy applied fresh to raw evidence. This one asks "will the send path
 * actually send to this address", and the send path reads email_send_eligible and nothing
 * else (actions.ts:288, actions.ts:329). Reporting anything other than the column the send
 * gate reads would be reporting a number that no longer describes what will happen.
 *
 * ADR-034 is the caveat and it is not this function's to fix: the column is frozen at
 * verification time, so it can be stale with respect to a rule changed afterwards.
 */
export function whyNotSendable(facts: SendabilityFacts): NotSendableReason | null {
  if (facts.email_send_eligible === true) return null

  // The one reason the column actually records. Bucketed, never rendered raw: the values
  // name a country.
  if (facts.email_send_ineligible_reason !== null) return 'excluded_country'

  if (facts.independent_verified_at === null) return 'not_verified'

  const first = toCanonicalVerdict(facts.verification_provider, facts.independent_email_status)
  const second = toCanonicalVerdict(facts.second_pass_provider, facts.second_pass_status)

  // Newest evidence first, matching send-eligibility-policy.ts.
  if (second === 'undeliverable' || first === 'undeliverable') return 'undeliverable'
  if (second === 'risky' || first === 'risky') return 'unconfirmable'

  return 'no_reason_recorded'
}

// ═════════════════════════════════════════════════════════════════════════════
// ITEM 5: WHAT tiering_reason ACTUALLY SAYS

/** A parsed tiering_reason. */
export type TieringVerdict =
  /** Tiering ran and kept the prospect. The components are what produced the score. */
  | { kind: 'scored'; tier: string; score: number; components: Array<{ name: string; points: number }> }
  /** Tiering ran and removed the prospect. `code` is a REMOVAL_REASONS member. */
  | { kind: 'disqualified'; code: string }
  /** Tiering has not run, so there is nothing to explain. */
  | { kind: 'not_tiered' }
  /**
   * A reason this parser does not recognise.
   *
   * NOT AN ERROR, AND NOT DISCARDED. The live data already contains a legacy value
   * ('geography_excluded') that tier-classification.ts no longer writes and REMOVAL_REASONS
   * does not list. A parser that dropped what it did not recognise would make exactly the
   * rows worth looking at disappear, so an unknown reason is carried through verbatim and
   * rendered as itself.
   */
  | { kind: 'unrecognised'; raw: string }

/**
 * The format classifyTier writes for a kept prospect, as at tier-classification.ts:321:
 *
 *     tier_1 (score 100): industry 45, seniority 35, headcount 20
 *
 * THIS PATTERN AND THAT TEMPLATE ARE A PAIR. If one changes and the other does not, every
 * kept row silently falls through to 'unrecognised' and the screen goes back to showing an
 * opaque string. prospect-status.test.ts asserts the pair by parsing classifyTier's own
 * output rather than a fixture copied from it, so the two cannot drift apart quietly.
 */
const SCORED_REASON = /^(\w+) \(score (-?\d+)\): (.+)$/
const COMPONENT = /^([a-z_]+) (-?\d+)$/

export function parseTieringReason(raw: string | null): TieringVerdict {
  if (raw === null || raw.trim() === '') return { kind: 'not_tiered' }

  const scored = SCORED_REASON.exec(raw)
  if (scored) {
    const [, tier, score, rest] = scored
    const components: Array<{ name: string; points: number }> = []
    for (const part of rest.split(',')) {
      const component = COMPONENT.exec(part.trim())
      // A malformed component makes the WHOLE reason unrecognised rather than producing a
      // partial breakdown. A breakdown missing one line looks complete and is not.
      if (!component) return { kind: 'unrecognised', raw }
      components.push({ name: component[1], points: Number(component[2]) })
    }
    return { kind: 'scored', tier, score: Number(score), components }
  }

  if ((REMOVAL_REASONS as readonly string[]).includes(raw)) {
    return { kind: 'disqualified', code: raw }
  }

  return { kind: 'unrecognised', raw }
}

// ═════════════════════════════════════════════════════════════════════════════
// ITEM 6: A VERIFICATION FAILURE THE OPERATOR CAN SEE

export interface VerificationFailure {
  /** HTTP status parsed out of the stored error, when there is one. */
  status: number | null
  /** How many times verification has been attempted for this prospect. */
  attempts: number
  /** True when attempts have reached the cap, so nothing will retry it on its own. */
  givenUp: boolean
}

/**
 * The provider's HTTP status, and nothing else from the stored string.
 *
 * THE COLUMN IS NOT SAFE TO RENDER. Measured on production 2026-09-02, all five stored
 * values read "Email verification failed: <vendor name> API returned <status>". Passing that
 * to the screen would put a vendor name in the UI, which Rule Zero forbids and which the
 * pre-commit tool-name check exists to catch. So the status is extracted and the sentence is
 * thrown away.
 */
export function readVerificationFailure(
  lastError: string | null,
  attempts: number | null,
  maxAttempts: number,
): VerificationFailure | null {
  if (lastError === null || lastError.trim() === '') return null
  const status = /\b([45]\d{2})\b/.exec(lastError)
  return {
    status: status ? Number(status[1]) : null,
    attempts: attempts ?? 0,
    givenUp: (attempts ?? 0) >= maxAttempts,
  }
}

/** Attempts after which verification stops retrying on its own. Mirrors verification-trigger. */
export const VERIFICATION_MAX_ATTEMPTS = 3

// ═════════════════════════════════════════════════════════════════════════════
// LABELS. THE ONLY PLACE OPERATOR-FACING WORDING FOR THESE CODES LIVES.
//
// Every one of these is checked against Rule Zero: no industry, sector, country, buyer
// title, vendor name or client name. "Excluded country" names the RULE, not the country.
// "Off specification" replaces a code that names a sector.

export const NOT_SENDABLE_LABELS: Record<NotSendableReason, string> = {
  excluded_country:   'Excluded country',
  not_verified:       'Not verified yet',
  undeliverable:      'Address does not exist',
  unconfirmable:      'Address cannot be confirmed',
  no_reason_recorded: 'No reason recorded',
}

export const DISQUALIFIER_LABELS: Record<string, string> = {
  email_unverified:        'Email not verified',
  no_title:                'No job title',
  not_decision_maker:      'Not a decision-maker',
  company_too_large:       'Company above the headcount ceiling',
  industry_excluded:       'Sector excluded by the specification',
  industry_not_consulting: 'Sector off specification',
}

/** Component names classifyTier scores on, glossed. An unlisted one renders as itself. */
export const SCORE_COMPONENT_LABELS: Record<string, string> = {
  industry:  'Sector',
  seniority: 'Seniority',
  headcount: 'Headcount',
}
