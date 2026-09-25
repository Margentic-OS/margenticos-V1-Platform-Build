// WHICH PATH A RESEARCH RUN TAKES, decided in ONE place.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
//
// queue_research_sources has been TRUE since 2026-09-14, so the Batch API path — which
// bills synthesis at 50% — has been switched on for eleven days. And measured on
// 2026-09-25, the 300 fresh research runs of 2026-09-23 to 25 ALL paid full price.
//
// The flag was never the problem. The route reads it; the CLI never did. scripts/
// run-research.ts calls runResearchBatchForOrg, which is the INLINE implementation, so
// every CLI run went inline whatever the flag said. Synthesis is 90.6% of a prospect's
// Anthropic cost (measured, 105 prospects), so that is about $0.10 a prospect, or 45% of
// the Anthropic bill, for the same model on the same prompt.
//
// The fix is not a third copy of the decision. There are already TWO: the route's inline
// logic, and readResearchPath in research-verdict.ts, whose own comment says it "read[s] the
// queue flags in the same order, and with the same meaning, as the route does" — which is a
// parallel list kept in step by hand and an admission of it.
//
// So this does NOT read the flags. It delegates to readResearchPath and adds the one thing
// that function does not decide: what the caller should DO. The count of places that read
// those three flags goes from two to one.
//
// ═══ THE ONE THING THE CALLERS LEGITIMATELY DISAGREE ABOUT ═══════════════════
//
// A queued job carries no per-job options, so it always uses stored findings. A caller
// asking for a FRESH fetch therefore cannot be queued, and the two callers want different
// answers to that:
//
//   the HTTP route  REFUSES. Re-fetching every source is paid work and must not happen
//                   because a dashboard control was left in the wrong position.
//   the CLI         RUNS IT INLINE. That is what --fresh is for, and it is the documented
//                   escape hatch: the route's own refusal text says "Run it from the CLI,
//                   which stays on the inline path."
//
// That difference is a PARAMETER rather than an assumption, so reading this file tells you
// both behaviours instead of one.

import type { SupabaseClient } from '@supabase/supabase-js'
import { readResearchPath } from './research-verdict'

/** What a caller must do with the run. */
export type ResearchRouting =
  /**
   * Enqueue it. `batched` true means the two-phase Batch API path and the 50% discount;
   * false means the single-job 'research' path, which is queued but pays standard rates.
   */
  | { kind: 'queue'; jobType: 'research_sources' | 'research'; batched: boolean }
  /** Run it in this process. `reason` says why, because "inline" alone hides the cause. */
  | { kind: 'inline'; reason: 'flags_off' | 'explicit_fresh' }
  /** Do neither. `status` is the HTTP code the route returns; the CLI prints and exits. */
  | { kind: 'refuse'; reason: string; status: 400 | 409 }

/**
 * Refusing a fresh fetch on the queued path. Exported so the CLI can recognise the case
 * it is allowed to override, rather than matching on prose.
 */
export const FRESH_FETCH_NOT_QUEUEABLE =
  'Refused: use_stored_findings=false cannot be honoured while research runs through ' +
  'the queue, because a queued job carries no per-job options and always uses the safe ' +
  'default. Re-fetching every source is a paid operation and must not happen by ' +
  'accident. Run it from the CLI, which stays on the inline path.'

export interface ResolveResearchRoutingInput {
  /** False means the caller asked for every source to be fetched again. */
  useStoredFindings: boolean
  /**
   * What to do when a fresh fetch meets a live queue. 'refuse' is the HTTP route's answer,
   * 'inline' is the CLI's. REQUIRED, because a default here would silently give one caller
   * the other's policy, and one of them spends money.
   */
  freshPolicy: 'refuse' | 'inline'
}

/**
 * READ AT ENQUEUE, NEVER AT CLAIM.
 *
 * A prospect that entered the batch path must finish down it. Flipping a flag mid-batch
 * would otherwise strand it between phase 1 and phase 2 with its sources bought and no job
 * able to finish it. Moved here verbatim from the route, including the order of the two
 * refusals: the half-enabled check comes FIRST, so a half-enabled batch path answers 409
 * rather than 400 even when the caller also asked for a fresh fetch.
 */
export async function resolveResearchRouting(
  supabase: SupabaseClient,
  { useStoredFindings, freshPolicy }: ResolveResearchRoutingInput,
): Promise<ResearchRouting> {
  // ONE READ OF THE FLAGS, in research-verdict.ts, which already owns their order, their
  // mutual exclusion and the half-enabled refusal string.
  const state = await readResearchPath(supabase)

  if (state.path === 'inline') return { kind: 'inline', reason: 'flags_off' }

  // ── A HALF-ENABLED BATCH PATH IS REFUSED FIRST ─────────────────────────────
  // Phase 1 buys sources and leaves the prospect waiting for a batch. With collection
  // disabled that batch is submitted, billed, and never read: money spent on work nothing
  // will finish. Checked BEFORE the fresh-fetch refusal below, so a half-enabled path
  // answers 409 rather than 400 even when the caller also asked for a fresh fetch. That
  // order is the route's, preserved deliberately.
  if (state.halfEnabledRefusal !== null) {
    return { kind: 'refuse', reason: state.halfEnabledRefusal, status: 409 }
  }

  if (!useStoredFindings) {
    return freshPolicy === 'refuse'
      ? { kind: 'refuse', reason: FRESH_FETCH_NOT_QUEUEABLE, status: 400 }
      : { kind: 'inline', reason: 'explicit_fresh' }
  }

  return {
    kind: 'queue',
    // The SAME guards either way. Only the final insert differs, so a prospect is eligible
    // under one definition no matter which path is live.
    jobType: state.jobType,
    batched: state.path === 'queue:batch',
  }
}
