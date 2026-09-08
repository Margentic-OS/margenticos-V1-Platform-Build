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
import { OPERATOR_HOLD_REASON } from '@/lib/sourcing/send-eligibility-rules'
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
  /** An operator placed a durable hold on this specific prospect. Not a rule. */
  | 'operator_hold'
  /**
   * This person must not be contacted at all: they opted out, or somebody stopped them.
   *
   * SEPARATE FROM 'operator_hold' AND FROM EVERY VERIFICATION REASON, deliberately. Those
   * say something about the ADDRESS. This says something about the PERSON, it is the only
   * one of the six that can be true while the address is perfectly deliverable, and it is
   * the only one that can mean "they asked us to stop". Folding it into a neighbour would
   * repeat exactly the mistake OPERATOR_HOLD_REASON was created to undo.
   */
  | 'suppressed'
  | 'not_verified'
  | 'undeliverable'
  | 'unconfirmable'
  | 'no_reason_recorded'

/**
 * The columns this module reads. Named so a caller cannot pass the wrong shape by accident.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY `suppressed` IS IN THIS INTERFACE AND WHY IT IS NOT OPTIONAL
 *
 * It was absent until 2026-09-08, and its absence WAS the defect rather than a symptom of
 * one. A caller cannot answer "will this person be emailed" from the verification columns
 * alone, so an interface that offered only those columns was asking a question it did not
 * supply the answer to, and every caller got the same wrong answer independently.
 *
 * MEASURED ON PRODUCTION 2026-09-08: three prospects read "Can be emailed: Yes" while
 * suppressed. Two had replied `stop` in August. The third had been stopped by an operator
 * that morning, and their row rendered "Yes" beside a "Stopped" badge in the next column.
 *
 * REQUIRED, NOT OPTIONAL, AND NOT DEFAULTED. Optional would compile at every existing call
 * site and change nothing, which is the failure it is meant to prevent. Required makes an
 * incomplete caller a COMPILE ERROR, so a new screen cannot ask this question without
 * fetching the column, and a query that stops selecting it cannot go quietly.
 */
export interface SendabilityFacts {
  /** prospects.suppressed. The send gate reads it; so must anything claiming to predict it. */
  suppressed: boolean | null
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
 * on", which is a policy applied fresh to raw evidence. This one asks "will this person
 * actually be emailed", so it must mirror applySendGate, and reporting anything the gate
 * does not agree with is reporting a number that does not describe what will happen.
 *
 * MIRRORS THE GATE ON TWO COLUMNS, NOT ONE. This comment previously said the send path
 * "reads email_send_eligible and nothing else". THAT WAS WRONG, and being wrong here is
 * what produced the defect: applySendGate has always also required `suppressed = false`
 * (send-gate.ts). The gate's third condition, `client_review_status = 'approved'`, is
 * deliberately NOT mirrored: this screen exists to be read BEFORE that approval, so folding
 * it in would report every unreviewed prospect as unsendable and hide the actual answer.
 *
 * ADR-034 is the caveat and it is not this function's to fix: the eligibility column is
 * frozen at verification time, so it can be stale with respect to a rule changed
 * afterwards. The suppression column has no such lag; it is true the moment it is written.
 */
export function whyNotSendable(facts: SendabilityFacts): NotSendableReason | null {
  // FIRST, AND BEFORE THE ELIGIBILITY COLUMN. This ordering is the whole fix.
  //
  // applySendGate requires `suppressed = false` AND `email_send_eligible = true`. Reading
  // the second without the first is not a smaller version of the gate, it is a DIFFERENT
  // predicate that says yes to people the gate says no to. Checking eligibility first would
  // return null on exactly the rows this exists to catch, because a suppressed prospect
  // very often still holds `email_send_eligible = true`.
  //
  // It stays true for as long as the row does. stopProspect deliberately does not write
  // email_send_eligible (durability comes from send_hold_at, honoured at the NEXT
  // verification), and an opt-out never touches that column at all. So this is not a
  // backfill gap that drains away: without this line every future stop on a sendable
  // prospect leaves the screen reading "Yes" for good.
  //
  // Wins over operator_hold when both are set. Both are true; this one is the more current,
  // and it is the one the gate acts on today rather than after a re-verification.
  if (facts.suppressed === true) return 'suppressed'

  if (facts.email_send_eligible === true) return null

  // TWO reasons the column records, since 2026-09-07, and they are told apart by VALUE.
  //
  // An operator hold is reported as itself. Anything else non-null is a country exclusion
  // and stays bucketed, never rendered raw, because those values name a country. The
  // ordering matters only for readability; the two cases are disjoint.
  if (facts.email_send_ineligible_reason === OPERATOR_HOLD_REASON) return 'operator_hold'
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
  // Covers both an opt-out and an operator's stop, because the operator-facing consequence
  // is identical and prospects.suppression_reason is where the difference is recorded. It
  // names neither the person's words nor the vendor that carried the stop.
  suppressed:         'Stopped, not to be contacted',
  operator_hold:      'Held by an operator',
  not_verified:       'Not verified yet',
  undeliverable:      'Address does not exist',
  unconfirmable:      'Address cannot be confirmed',
  no_reason_recorded: 'No reason recorded',
}

//
// BOTH `industry_off_target` AND `industry_not_consulting` ARE HERE, on purpose. The
// second is the old name for the same rule and nothing writes it any more, but rows
// removed under it are still stored and still have to render. Deleting it would leave
// those rows falling through to the raw code, which is the failure this map exists to
// prevent. It goes when the last row carrying it does, not before.
export const DISQUALIFIER_LABELS: Record<string, string> = {
  email_unverified:        'Email not verified',
  no_title:                'No job title',
  not_decision_maker:      'Not a decision-maker',
  no_buyer_criterion:      'No buyer criterion for this client yet',
  company_too_large:       'Company above the headcount ceiling',
  industry_excluded:       'Sector excluded by the specification',
  industry_off_target:     'Sector off specification',
  industry_not_consulting: 'Sector off specification',
}

/** Component names classifyTier scores on, glossed. An unlisted one renders as itself. */
export const SCORE_COMPONENT_LABELS: Record<string, string> = {
  industry:  'Sector',
  seniority: 'Seniority',
  headcount: 'Headcount',
}
