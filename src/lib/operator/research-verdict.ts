// What the research button will actually do, for one organisation.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// The dashboard computed its own research count, as
//
//     current_research_result_id IS NULL AND suppressed = false
//
// while the enqueue selected on that PLUS the tier gate, PLUS send-eligibility, PLUS the
// live-job filter, and then applied a trigger guard that can refuse the whole batch. Two
// predicates for one number, kept in step by hand.
//
// MEASURED ON PRODUCTION 2026-09-02: the button read "Research 21 prospects". The enqueue
// selected 17. Of those 17, ZERO were eligible: 13 unresolved catch-all addresses, 3 never
// verified, 1 verified undeliverable. Clicking the button enqueued nothing and returned an
// error. The main workflow's primary control was dead, and it looked like a label bug.
//
// This module is the single answer to "what happens if I click it", and both the label and
// the action read it. Nothing here decides eligibility; it composes the functions that
// already do.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE CLIENT PASSED IN MUST BE SERVICE-ROLE. THIS IS NOT A STYLE PREFERENCE.
//
// Read back from production 2026-09-02, for the three tables this path touches:
//
//   prospects      RLS on, 3 policies, authenticated SELECT granted
//                  (operators_full_access_prospects, qual is_operator())
//   job_queue      RLS on, ZERO policies, authenticated SELECT *not granted*
//   system_flags   RLS on, ZERO policies, authenticated SELECT *not granted*
//
// So a session client can read prospects and cannot read the other two. Passing one here
// would fail on the flag read, or, if the grants ever softened, silently return an empty
// set from prospectsWithLiveResearchJob and OVER-REPORT what a click would do. See ADR-027.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isQueueEnabled } from '@/lib/queue/flags'
import {
  selectProspectsForResearch,
  describeResearchSelection,
  type ResearchScope,
  type ResearchEnqueueJobType,
} from '@/lib/queue/enqueue/research'

/**
 * Refused when the batch path is half-enabled: phase 1 buys sources and submits a batch
 * that nothing will ever read.
 *
 * ONE COPY, shared with the route that returns it as a 409, so the sentence the button
 * shows before a click and the sentence the API returns after one cannot drift. It was
 * written inline in the route; a second copy here would have been the same defect this
 * whole module exists to remove, one level down.
 */
export const HALF_ENABLED_BATCH_PATH_REFUSAL =
  'Refused: the batch research path is enabled (queue_research_sources) but its ' +
  'collection half is not (queue_research_collect). Phase 1 would buy sources and ' +
  'submit a batch that nothing would ever read, which spends money on work that ' +
  'cannot finish. Turn queue_research_collect on first, then retry.'

/** Which route a click would take. Named so the label and the log agree on one word. */
export type ResearchPath = 'inline' | 'queue:single-job' | 'queue:batch'

export interface ResearchVerdict {
  /**
   * The number the button shows, and the number a click acts on.
   *
   * Zero whenever anything blocks, so the label can never promise work the click refuses.
   */
  actionable: number
  /** Non-null when nothing can be enqueued. The full reason, already operator-readable. */
  blocked: string | null
  /** Counts by reason for prospects the spend filter passed over. Null when none were. */
  skippedBreakdown: string | null
  path: ResearchPath
}

/**
 * Which research path is live, and whether it is safely configured.
 *
 * READ ONCE PER REQUEST, NOT ONCE PER ORGANISATION. The flags are global; reading them
 * inside a per-organisation loop asked the same question three times per client for three
 * identical answers, and the pipeline screen renders every client at once.
 */
export interface ResearchPathState {
  path: ResearchPath
  /** Which job type an enqueue would create. Drives the wording of the in-progress refusal. */
  jobType: ResearchEnqueueJobType
  /** Non-null when the batch path is half-enabled, which blocks every organisation. */
  halfEnabledRefusal: string | null
}

/** Read the queue flags in the same order, and with the same meaning, as the route does. */
export async function readResearchPath(supabase: SupabaseClient): Promise<ResearchPathState> {
  const batched = await isQueueEnabled(supabase, 'research_sources')
  const queued = batched || await isQueueEnabled(supabase, 'research')
  const path: ResearchPath = batched ? 'queue:batch' : queued ? 'queue:single-job' : 'inline'
  const jobType: ResearchEnqueueJobType = batched ? 'research_sources' : 'research'

  if (batched && !(await isQueueEnabled(supabase, 'research_collect'))) {
    return { path, jobType, halfEnabledRefusal: HALF_ENABLED_BATCH_PATH_REFUSAL }
  }
  return { path, jobType, halfEnabledRefusal: null }
}

/**
 * Everything the research control needs, for one organisation.
 *
 * ── THE LIMIT OF THIS, STATED RATHER THAN LEFT TO BE DISCOVERED ──
 *
 * On the INLINE path (queue_research off) the selection predicates are the same ones
 * runResearchBatchForOrg applies, by construction: enqueue/research.ts carries that as its
 * stated contract and the guards moved together. What this does NOT model is the inline
 * path's ADMISSION CHECK, which refuses a batch it cannot finish inside 240 seconds
 * (RESEARCH_MAX_PROSPECTS, and about five prospects when every one needs fresh sources).
 * So on the inline path a large actionable count can still be refused at click time, with
 * a clear 400 the button renders.
 *
 * That gap is left open deliberately rather than guessed at: modelling it needs the stored
 * findings ages that estimateBatchSeconds reads, and queue_research is TRUE in production,
 * so it would be speculative work for a path that is off. If the inline path is ever made
 * the default again, this is the thing to close.
 */
export async function getResearchVerdict(
  supabase: SupabaseClient,
  organisationId: string,
  scope: ResearchScope = 'unresearched',
  /** Pre-read flags. Omit and they are read here, which is what a single-organisation caller wants. */
  pathState?: ResearchPathState,
): Promise<ResearchVerdict> {
  const { path, jobType, halfEnabledRefusal } = pathState ?? await readResearchPath(supabase)

  if (halfEnabledRefusal !== null) {
    return { actionable: 0, blocked: halfEnabledRefusal, skippedBreakdown: null, path }
  }

  const read = await selectProspectsForResearch(supabase, organisationId, scope)

  // A failed read is reported as a block, not as a zero. Zero would render as "nothing
  // left to research", which is a statement about the data; this is a statement about
  // our ability to see it, and the two must not look the same on screen.
  if (!read.ok) {
    return { actionable: 0, blocked: read.error, skippedBreakdown: null, path }
  }

  const verdict = describeResearchSelection(read.selection, jobType)

  return {
    actionable: verdict.actionable,
    blocked: verdict.blocked,
    skippedBreakdown: verdict.skippedBreakdown,
    path,
  }
}
