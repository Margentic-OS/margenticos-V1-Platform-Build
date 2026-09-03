// THE ONE PLACE THAT KNOWS WHAT A TIER VERDICT MEANS.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS EXISTS FOR
//
// sourced_tier was computed, stored and displayed, and read by nothing that decides what
// happens to a prospect next. Measured on the live organisation 2026-09-01: 16 rows had
// been disqualified by tiering, 15 of them unsuppressed. Verification quota had been spent
// on all of them, research money had been spent on 10, and 9 of those carry finished
// personalisation copy that can never be used. The tier verdict was advisory.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE THREE STATES, AND WHY sourced_tier ALONE CANNOT TELL THEM APART
//
//   sourced_tier NOT NULL                       tiering ran and the prospect QUALIFIED
//   sourced_tier NULL, tiering_reason NOT NULL  tiering ran and REJECTED the prospect
//   sourced_tier NULL, tiering_reason NULL      tiering HAS NOT RUN yet
//
// The last two are the same value in sourced_tier and mean opposite things. A gate written
// as `sourced_tier IS NOT NULL` reads "not yet tiered" as "rejected" and strands a row that
// was merely waiting; a gate written as `sourced_tier IS NULL` reads "rejected" as
// "pending" and re-admits it. tiering_reason is the discriminator, because classifyTier
// writes one on EVERY result including the passes.
//
// Verified live 2026-09-01 across EVERY organisation, not one: zero rows carry a tier
// without a reason, and the 19 rows that have never been tiered all carry both as NULL.
// There is no ambiguous row on the platform.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT MATERIALISED INTO email_send_eligible
//
// The obvious shortcut is to AND the tier verdict into email_send_eligible at verification
// time, so every consumer keeps its single flat read. It is wrong, and persist-icp-filter-
// spec.ts is why: when a new ICP specification is saved it CLEARS tiering_reason on the
// organisation's rejected rows so tiering runs on them again under the new rules
// (persist-icp-filter-spec.ts:180-183). A tier verdict frozen into the boolean would not be
// recomputed by that, because nothing re-runs verification, and the row would sit
// permanently ineligible after later qualifying.
//
// So email_send_eligible keeps exactly one meaning: THIS ADDRESS IS DELIVERABLE.
// Qualification is a separate question, asked by each consumer at the point of use, against
// whatever the tier columns say at that moment. That is also why there is no backfill
// migration alongside this change: the 11 rows holding email_send_eligible = true while
// disqualified are holding a TRUE statement about their addresses.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE RULE IS "A REJECTION REASON EXISTS" AND NAMES NO REASON VALUE
//
// The gate must never grow a list of titles, industries, countries or reason strings. Two
// reasons, beyond it not being this module's job to know them:
//
//   - The live data already contains a LEGACY reason value that tier-classification.ts no
//     longer writes and does not list in REMOVAL_REASONS. A gate keyed on a list of known
//     reason values would silently re-admit that row. A gate keyed on "a reason exists"
//     catches it without needing to know what it says, which is the point.
//   - Tiering owns the scoring and the disqualifiers. This module owns only the question
//     "did tiering reach a verdict, and was it a rejection".

/**
 * Excludes prospects tiering has REJECTED, while leaving prospects tiering has not reached.
 *
 * PostgREST negation of (sourced_tier IS NULL AND tiering_reason IS NOT NULL), which is
 * (sourced_tier IS NOT NULL OR tiering_reason IS NULL).
 *
 * Exported as a constant as well as being applied by the helper below so a test can assert
 * the exact string. It is the whole rule in one line and a typo in it would be a gate that
 * silently matches everything.
 */
export const TIER_NOT_REJECTED_FILTER = 'sourced_tier.not.is.null,tiering_reason.is.null'

/**
 * Requires a POSITIVE tier. Stricter than TIER_NOT_REJECTED_FILTER: this also refuses a
 * prospect tiering has not reached yet.
 *
 * Used by the send gate only, and only because that is what the send gate has always done.
 * Sending is the irreversible end of the pipeline and "we have not decided about this
 * prospect yet" is not a licence to email them. Upstream consumers spend money, which is
 * recoverable in a way a sent email is not, so they use the looser rule and let a pending
 * row keep moving.
 */
export const TIER_PRESENT_COLUMN = 'sourced_tier'

/** The minimum of a PostgREST filter builder this module needs. */
interface OrFilterable<Q> {
  or(filters: string): Q
}

/** The minimum of a PostgREST filter builder the send gate needs. */
interface NotFilterable<Q> {
  not(column: string, operator: string, value: unknown): Q
}

/**
 * Refuse prospects tiering rejected. Leaves prospects tiering has not reached.
 *
 * For every consumer that spends money or moves a prospect toward being sendable. As of
 * 2026-09-03 that is seven call sites, and the count matters because the first pass at this
 * wired five and the two it missed were a matched PAIR with two it wired:
 *
 *   verification, first pass ..... the organisation picker AND the row selector
 *   verification, second pass .... the organisation picker AND the row selector
 *   research ..................... both selection paths
 *   the client's approve-all
 *
 * THE PICKER AND THE SELECTOR MUST ALWAYS BE CHANGED TOGETHER. Both verification sweeps run
 * one organisation per invocation: a first query chooses the organisation, a second chooses
 * rows inside it. Gating only the selector does not half-fix anything, it converts a money
 * bug into a starvation bug, because the picker keeps nominating an organisation the
 * selector refuses everything from and no other organisation is ever reached. That shipped
 * on 2026-09-01 and ran for roughly 290 firings writing successful heartbeats.
 */
export function excludeTierRejected<Q>(query: OrFilterable<Q>): Q {
  return query.or(TIER_NOT_REJECTED_FILTER)
}

/**
 * Require a positive tier. Refuses rejected AND not-yet-tiered prospects.
 *
 * For the send gate. See TIER_PRESENT_COLUMN for why sending is stricter than everything
 * upstream of it.
 */
export function requireTierPresent<Q>(query: NotFilterable<Q>): Q {
  return query.not(TIER_PRESENT_COLUMN, 'is', null)
}
