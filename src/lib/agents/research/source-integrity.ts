// Whether a prospect's sources came back well enough to research them at all.
//
// ═════════════════════════════════════════════════════════════════════════════
// "WE LOOKED AND FOUND NOTHING" AND "WE COULD NOT LOOK" ARE DIFFERENT ANSWERS
//
// Before this module, both arrived at synthesis as `available: false` with a one-line
// error, and synthesis could not tell them apart. So a prospect whose LinkedIn returned
// 402 and a prospect who has never posted produced the SAME research row, and the row
// asserted a verdict about the prospect in both cases.
//
// That matters because the verdict is FROZEN on the prospect and drives what ships. A row
// written while a source was unreachable is a verdict about our infrastructure wearing a
// prospect's name.
//
// ─── Why this runs BEFORE synthesis ──────────────────────────────────────────
//
// Synthesis is four Sonnet calls, about $0.159 a prospect, and it is the expensive half.
// Checking integrity after it would pay in full for a verdict we then throw away. The
// check needs only the source results, so it runs the moment they land.
// ═════════════════════════════════════════════════════════════════════════════

import { SOURCE_SKIPPED_REUSE } from './source-skip'
import type { RawSourceData } from './types'

/**
 * Errors that mean a source was DELIBERATELY NOT CALLED, rather than called and failed.
 *
 * Kept as a list of substrings, matching buildSourceTracking, because these strings are
 * produced in four different files and a shared constant only exists for the reuse one.
 * If the two ever disagree, sources_attempted and this check disagree about the same run,
 * so a test pins them together.
 */
export const SKIP_MARKERS: ReadonlyArray<string> = [
  'not set',
  'No LinkedIn URL',
  SOURCE_SKIPPED_REUSE,
]

export function isDeliberateSkip(error: string | null | undefined): boolean {
  if (!error) return false
  return SKIP_MARKERS.some(m => error.includes(m))
}

export interface SourceIntegrity {
  /** True when every source that was actually called came back. */
  complete: boolean
  /** Sources called that did not come back, with the error each gave. */
  failed: Array<{ source: string; error: string }>
  /** Sources deliberately not called. Never a reason to hold. */
  skipped: string[]
  /** Sources that came back. */
  successful: string[]
}

/**
 * Reads the four source results and says whether this prospect can be researched.
 *
 * NOTE ON STRICTNESS, because it is a policy and not a detail. A prospect is incomplete
 * when ANY called source failed, not when ALL of them did. That is deliberate and it is
 * what was asked for: a run that quietly proceeds on three sources of four produces copy
 * built on whatever survived, and the 2026-09-21 run is what that looks like.
 *
 * It is also the strict end of the range. Measured on that run, the website fetcher failed
 * on 68 of 84 prospects, so this rule would have held 68 of them. That is the correct
 * reading of the rule and a real consequence: the website fetcher has to be fixed, or this
 * policy relaxed to name which sources are load-bearing. The decision belongs to whoever
 * reads the website-fetcher report, not to this file, which is why the policy is one
 * exported function and not a condition buried in the orchestrator.
 */
export function assessSourceIntegrity(rawData: RawSourceData): SourceIntegrity {
  const failed: Array<{ source: string; error: string }> = []
  const skipped: string[] = []
  const successful: string[] = []

  for (const [source, result] of Object.entries(rawData) as [string, { available: boolean; error?: string }][]) {
    if (result.available) { successful.push(source); continue }
    if (isDeliberateSkip(result.error)) { skipped.push(source); continue }
    failed.push({ source, error: result.error ?? '(no error recorded)' })
  }

  return { complete: failed.length === 0, failed, skipped, successful }
}

/**
 * Thrown for ONE prospect whose sources did not come back. The run continues.
 *
 * Distinct from FatalApiError on purpose: that one means the account cannot call the
 * provider and every remaining prospect will fail the same way, so the run stops. This one
 * means this prospect's turn did not work and the next prospect may be fine.
 *
 * Carrying the failures rather than a formatted string is what lets the batch summary
 * count them per source without parsing prose back out of a message.
 */
export class ResearchIncompleteError extends Error {
  readonly prospect_id: string
  readonly failed: Array<{ source: string; error: string }>

  constructor(prospect_id: string, failed: Array<{ source: string; error: string }>) {
    super(
      `Research incomplete for prospect ${prospect_id}: ` +
      failed.map(f => `${f.source} (${f.error})`).join(', ') +
      '. Held for retry; no research row written.',
    )
    this.name = 'ResearchIncompleteError'
    this.prospect_id = prospect_id
    this.failed = failed
  }
}
