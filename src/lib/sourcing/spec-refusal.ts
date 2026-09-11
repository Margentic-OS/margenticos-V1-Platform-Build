// Why a version of the ICP has no usable search specification, written on the document.
//
// THE GAP. Every path that promotes an ICP (approve, auto-approve, revise, revert) builds the
// search specification AFTER the new version is live, in the background, once the reply has
// already gone. When the build refused, the only record was a Sentry event. The page said the
// change succeeded, the document looked finished, and sourcing refused later with nothing on
// the screen to say why. Measured 2026-09-08 on one live client: three versions in a row went
// live with no specification, each reported as a success.
//
// So persistIcpFilterSpec now writes the refusal onto the document, naming the cause, and the
// strategy page shows it to the operator. This is the post-promotion flag decided on
// 2026-09-08 (Notion Backlog: "DECIDED — replace the impossible pre-approval gate with a
// post-promotion flag on failed spec derivation"), which asked that the mark name the cause
// rather than say only that the spec is missing.

import type { FilterSpecRefusalReason } from '@/lib/agents/icp-filter-spec'

export type SpecRefusalReason =
  | FilterSpecRefusalReason
  // deriveFilterSpec threw something that is not one of its named refusals
  | 'unclassified'
  | 'geography_unresolved'
  // the buyer criterion call failed; seniority comes off the same call, so the spec refuses
  | 'buyer_criterion_failed'
  | 'spec_write_failed'
  | 'unexpected'

export interface SpecRefusalRecord {
  reason: SpecRefusalReason
  detail: string
  recorded_at: string
}

// `satisfies`, so a new reason with no label is a compile error here rather than a blank line
// on the operator's screen.
const REASON_LABELS = {
  non_canonical_industry: 'An industry on this document is not one the search recognises.',
  no_seniority_bands:     'No buyer seniority could be worked out for the search.',
  no_geography:           'No country could be established to search in.',
  geography_unresolved:   'The locations on this document could not be turned into countries.',
  no_headcount_bound:     'The staff-size range on this document has no usable numbers.',
  headcount_inverted:     'The staff-size range is inverted: the lower figure is above the upper one.',
  buyer_criterion_failed: 'Who this client emails could not be worked out, so there is no one to search for.',
  spec_write_failed:      'The specification was built but could not be saved.',
  unclassified:           'The specification could not be built, for a reason that has no name yet.',
  unexpected:             'The specification could not be built, because of an unexpected error.',
} satisfies Record<SpecRefusalReason, string>

// The detail is the refusal's own message, which names the field and quotes its value. It is
// kept whole up to this length: the column is a record for the operator, not a log.
const DETAIL_LIMIT = 2000

export function buildSpecRefusal(
  reason: SpecRefusalReason,
  detail: string,
  at: Date = new Date(),
): SpecRefusalRecord {
  return { reason, detail: detail.slice(0, DETAIL_LIMIT), recorded_at: at.toISOString() }
}

export function describeSpecRefusalReason(reason: SpecRefusalReason): string {
  return REASON_LABELS[reason]
}

/** Read the stored value back. Anything malformed is still a refusal, never a pass. */
export function readSpecRefusal(value: unknown): SpecRefusalRecord | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') {
    return { reason: 'unexpected', detail: String(value), recorded_at: '' }
  }
  const v = value as Record<string, unknown>
  const reason =
    typeof v.reason === 'string' && v.reason in REASON_LABELS
      ? (v.reason as SpecRefusalReason)
      : 'unexpected'
  return {
    reason,
    detail: typeof v.detail === 'string' ? v.detail : '',
    recorded_at: typeof v.recorded_at === 'string' ? v.recorded_at : '',
  }
}

export type OperatorSpecStatus =
  | { kind: 'usable' }
  | { kind: 'not_built' }
  | { kind: 'refused'; reason: SpecRefusalReason; label: string; detail: string; recordedAt: string }

/**
 * What the operator should be told about this version's search specification.
 *
 * A recorded refusal wins over everything. No spec and no refusal is NOT a pass: it means the
 * background build has not finished, or never ran, and the page says so rather than showing
 * nothing, because nothing is what a finished document looks like.
 */
export function operatorSpecStatus(spec: unknown, refusal: unknown): OperatorSpecStatus {
  const recorded = readSpecRefusal(refusal)
  if (recorded) {
    return {
      kind: 'refused',
      reason: recorded.reason,
      label: describeSpecRefusalReason(recorded.reason),
      detail: recorded.detail,
      recordedAt: recorded.recorded_at,
    }
  }
  if (spec === null || spec === undefined) return { kind: 'not_built' }
  return { kind: 'usable' }
}
