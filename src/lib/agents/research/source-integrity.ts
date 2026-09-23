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

/**
 * The sources whose absence makes a prospect NOT WORTH RESEARCHING, so their failure holds.
 *
 * ─── WHY THESE TWO AND NOT THE OTHER TWO, decided 2026-09-23 ─────────────────
 *
 * The first version of this file held on ANY source failure. That is the strict reading
 * and it was measured to hold 68 of 84 prospects, because the website fetcher was failing
 * on 81% of them for a reason that had nothing to do with the prospect. A policy that
 * stops nearly every prospect over a defect in one fetcher is a stop-the-world switch
 * wearing a correctness argument.
 *
 * So the split is by WHAT THE SOURCE CONTRIBUTES, measured on the 2026-09-21 cohort:
 *
 *   linkedin    58 of 58 true recent events came from it, and where it ran, 88% of
 *               prospects had one. Where it failed, 9%. It is the difference between
 *               research and a database lookup.
 *   apollo      160 of 395 candidates, and 39 of the 58 shipped openings. The strongest
 *               single contributor to copy that actually went out.
 *   website     1 candidate in 395, 0 recent events. Contributes nothing today.
 *   web_search  11 of 69 event-shaped candidates, 8 of the 58 true ones. Useful, not
 *               load-bearing, and it already degrades gracefully to nothing.
 *
 * WEBSITE AND WEB SEARCH ARE RECORDED AND THE RUN CONTINUES. That is not a judgement that
 * their failures do not matter. It is that their failure mode is "we learned less", while
 * a LinkedIn or Apollo failure is "we learned nothing about this person". MON-034 watches
 * both tiers, so a recorded failure is still visible; it just does not stop the prospect.
 *
 * A PROSPECT WITH NO LINKEDIN URL IS NOT HELD, and that needs no special case here: the
 * handler returns 'No LinkedIn URL for this prospect', which is a deliberate skip. The
 * distinction lives where it is known, which is the source, not this file.
 */
export const HOLDING_SOURCES: ReadonlyArray<string> = ['linkedin', 'apollo']

export interface SourceIntegrity {
  /** True when no HOLDING source failed. Website and web search never make this false. */
  complete: boolean
  /**
   * EVERY source that was called and did not come back, holding or not. Kept whole so the
   * batch's per-source counts and MON-034 see recorded failures as well as holding ones:
   * a source silently degrading is exactly what nobody noticed on 2026-09-21, and
   * narrowing this to holding failures would rebuild that blind spot one tier down.
   */
  failed: Array<{ source: string; error: string }>
  /** The subset of `failed` that holds the prospect. */
  holding: Array<{ source: string; error: string }>
  /** The subset of `failed` that is recorded and continued past. */
  recorded: Array<{ source: string; error: string }>
  /** Sources deliberately not called. Never a reason to hold. */
  skipped: string[]
  /** Sources that came back. */
  successful: string[]
}

/**
 * Reads the four source results and says whether this prospect can be researched.
 *
 * `complete` is false only when a HOLDING source failed. Every failure is still reported
 * in `failed`, so nothing gets quieter as a result of this policy; what changes is which
 * failures stop a prospect.
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

  const holding  = failed.filter(f => HOLDING_SOURCES.includes(f.source))
  const recorded = failed.filter(f => !HOLDING_SOURCES.includes(f.source))

  return { complete: holding.length === 0, failed, holding, recorded, skipped, successful }
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
    // Constructed from the HOLDING failures by both callers. Passing every failure here
    // would name website in the reason a prospect was held, which it never is.
    this.name = 'ResearchIncompleteError'
    this.prospect_id = prospect_id
    this.failed = failed
  }
}
