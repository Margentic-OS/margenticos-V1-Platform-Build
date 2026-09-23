// Keep enriching until the backlog is clear, the request runs out of time, or a declared
// ceiling is reached.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS REPLACES, AND THE DECISION IT ENCODES
//
// One press of Enrich and tier ran enrichApprovedBatch ONCE, for at most
// ENRICHMENT_PER_PRESS_LIMIT (100) prospects, and left the rest untouched with nothing queued.
// An operator with 500 approved prospects pressed five times.
//
// ── WHY AUTO-CONTINUE AND NOT JUST A CLEARER MESSAGE ────────────────────────
//
// The screen ALREADY says it plainly. StageProgress renders "Enriching runs 100 at a time.
// Pressing once will enrich 100 and leave 400 waiting, so you will need to press it again, 5
// presses in total", built from planEnrichmentPresses. So "make the screen state it plainly"
// was already shipped, and choosing it again would have shipped nothing. What was missing is
// not being told; it is not having to.
//
// ── WHAT THIS COSTS, NAMED RATHER THAN DISCOVERED LATER ─────────────────────
//
// ENRICHMENT SPENDS ONE APOLLO CREDIT PER PROSPECT. So one press can now spend up to
// ENRICHMENT_MAX_PER_REQUEST credits instead of up to 100.
//
// It is the same money the operator was going to spend across five presses, in one press
// instead of five, on a backlog the screen already told them the size of. It is NOT new
// spend authority: nothing is enriched that would not have been enriched by pressing again,
// because the selection predicate is unchanged and every prospect it picks is one an operator
// already approved. The ceiling exists so that "press once and walk away" cannot become
// "press once and spend without limit" if a backlog is ever far larger than expected.
//
// The per-prospect idempotency guards are untouched and still carry the real protection
// against paying twice: enrichment_status, enrichment_credit_consumed_at and the 30-minute
// column lock. See enrichment-trigger.ts.
//
// ── THE TIMING, MEASURED ────────────────────────────────────────────────────
//
// From prospects.enrichment_credit_consumed_at grouped by enrichment_run_id, production,
// read 2026-09-23:
//
//   100 prospects   24,908 ms   2026-09-21     ~249 ms each
//   100 prospects   26,751 ms   2026-09-01     ~268 ms each
//    53 prospects   16,134 ms   2026-09-17     ~304 ms each
//    23 prospects    6,620 ms   2026-09-21     ~288 ms each
//    30 prospects   59,835 ms   2026-09-15   ~1,994 ms each
//
// So a press of 100 usually costs about 25 seconds and five of them fit inside the 240s
// budget several times over. The 2026-09-15 row is the same slow day that produced sourcing's
// 3,535 ms per candidate, and at that rate ONE press of 100 would cost about 200s and a second
// would not fit. That is exactly the case the shared budget decision exists for, and it is why
// this is not a fixed "loop five times".

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { enrichApprovedBatch, ENRICHMENT_PER_PRESS_LIMIT } from '@/lib/sourcing/enrichment-trigger'
import type { EnrichmentRun } from '@/lib/sourcing/handlers/adapter-apollo-enrichment'
import {
  planNextWindow,
  SOURCING_RUNTIME_BUDGET_MS,
  type SourcingStopReason,
} from '@/lib/sourcing/window-budget'

/**
 * The most prospects one press may enrich, however many are waiting.
 *
 * 500, because a 500-prospect sourcing run is the run this is for, and one press should clear
 * one run. It is a SPEND CEILING, not a performance limit: the runtime budget below stops a
 * slow press long before this binds, and the only thing this catches is a backlog far larger
 * than anyone expected.
 *
 * A backlog above it is not lost. The press enriches 500, reports how many remain, and another
 * press takes the next 500.
 */
export const ENRICHMENT_MAX_PER_REQUEST = 500

export interface EnrichmentContinuationResult {
  /** Every field of EnrichmentRun, summed over the presses this request made. */
  batch_size: number
  total_requested: number
  enriched: number
  missing: number
  credits_consumed: number
  /** How many calls to enrichApprovedBatch this request made. */
  presses: number
  /** Approved prospects still awaiting enrichment when this request stopped. */
  remaining: number
  /** Why it stopped. */
  stop_reason: SourcingStopReason
  /** The one sentence the operator reads. */
  stop_message: string
  /**
   * The first error any press reported, or null.
   *
   * THE FIRST, AND IT STOPS THE LOOP. A press that failed has usually failed for a reason the
   * next press would meet too (a provider outage, an exhausted credit balance), and continuing
   * would turn one failure into five while spending on each attempt.
   */
  error: string | null
}

/**
 * How many approved prospects are still waiting to be enriched.
 *
 * READ WITH THE SELECTION'S OWN PREDICATE, via a count, rather than inferred from what the last
 * press returned. A press that enriched 100 of 340 does not know 240 remain: prospects can be
 * approved by another session while this request runs, and a number derived by subtraction
 * would drift from what the next press will actually find.
 */
async function countWaiting(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', organisationId)
    .eq('sourcing_review_status', 'approved')
    .is('enrichment_status', null)
    .is('enrichment_credit_consumed_at', null)

  if (error) {
    // NULL, NOT ZERO. Zero would read as "the backlog is clear" and tell the operator the job
    // is done when the truth is that we could not find out.
    logger.warn('enrichment-continuation: could not count the remaining backlog', {
      organisation_id: organisationId,
      error: error.message,
    })
    return null
  }
  return count ?? 0
}

function describeEnrichmentStop(
  stop: SourcingStopReason,
  enriched: number,
  remaining: number | null,
  presses: number,
): string {
  if (remaining === 0) {
    return `Enriched ${enriched} prospect(s) over ${presses} pass(es). Nothing is left waiting.`
  }

  // ── AN UNREADABLE COUNT IS ITS OWN ANSWER, ON EVERY STOP REASON ───────────
  //
  // Checked before the switch, because the provider_exhausted branch below does not mention the
  // remainder at all and would have reported "the backlog is clear" off a FAILED READ. Saying
  // "we could not find out" is the only honest thing here, and it is the same discipline as the
  // sourcing cursor refusing to assume offset 0 when its read fails.
  if (remaining === null) {
    return (
      `Enriched ${enriched} prospect(s) over ${presses} pass(es), and then could not read how ` +
      'many are still waiting, so an unknown number may remain. Check the Enriching card, and ' +
      'press Enrich and tier again if it is not zero: nothing is charged twice.'
    )
  }
  const left = `${remaining}`

  switch (stop) {
    case 'provider_exhausted':
      // Nothing was selectable, which on this path means the backlog is clear or every
      // remaining prospect is locked by another run in progress.
      return (
        `Enriched ${enriched} prospect(s) over ${presses} pass(es). Nothing more could be ` +
        `selected, and ${left} still read as waiting: they are most likely locked by a run ` +
        'already in progress. The lock clears after 30 minutes.'
      )
    case 'budget_exhausted':
      return (
        `Enriched ${enriched} prospect(s) over ${presses} pass(es) before this request ran out ` +
        `of time. ${left} still waiting. Press Enrich and tier again to continue: nothing is ` +
        'lost and nothing is charged twice.'
      )
    case 'target_met':
      return (
        `Enriched ${enriched} prospect(s) over ${presses} pass(es), which is this request's ` +
        `ceiling of ${ENRICHMENT_MAX_PER_REQUEST}. ${left} still waiting. Press Enrich and tier ` +
        'again to continue.'
      )
    case 'ceiling_reached':
      // Not reachable on this path: ceilingReached is a provider paging limit and enrichment
      // does not page. Handled rather than left to fall through to undefined.
      return `Enriched ${enriched} prospect(s) over ${presses} pass(es). ${left} still waiting.`
  }
}

/**
 * Enrich approved prospects, pass after pass, until the backlog is clear or time runs out.
 *
 * `budgetMs` and `clock` exist for the same reason they do on the sourcing orchestrator: the
 * branch worth testing is what happens when the budget runs out, and a test that waited 240
 * real seconds for it would not be written.
 */
export async function enrichApprovedUntilDoneOrOutOfTime(
  supabase: SupabaseClient,
  organisationId: string,
  options: {
    budgetMs?: number
    clock?: () => number
    /** Injected in tests. Defaults to the real trigger. */
    runPass?: (max: number) => Promise<EnrichmentRun>
    maxPerRequest?: number
  } = {},
): Promise<EnrichmentContinuationResult> {
  const clock = options.clock ?? Date.now
  const budgetMs = options.budgetMs ?? SOURCING_RUNTIME_BUDGET_MS
  const maxPerRequest = options.maxPerRequest ?? ENRICHMENT_MAX_PER_REQUEST
  const runPass =
    options.runPass ?? ((max: number) => enrichApprovedBatch(supabase, organisationId, max))

  const startedMs = clock()
  const totals = {
    batch_size: 0,
    total_requested: 0,
    enriched: 0,
    missing: 0,
    credits_consumed: 0,
  }

  let presses = 0
  let processed = 0
  let lastPassMs: number | null = null
  let lastPassRecords: number | null = null
  let lastPassRequested: number | null = null
  let nothingLeftToSelect = false
  let stopReason: SourcingStopReason = 'target_met'
  let firstError: string | null = null

  // THE SAME DECISION AS SOURCING, DELIBERATELY THE SAME FUNCTION. Both are "work processed in
  // fixed units inside one request against a wall-clock budget, where the unit cost is measured
  // rather than assumed". Two copies of that arithmetic would be two things that have to agree,
  // which is the shape CLAUDE.md's parallel-arrays note is about.
  for (;;) {
    const decision = planNextWindow({
      targetBatchSize: maxPerRequest,
      recordsConsumed: processed,
      elapsedMs: clock() - startedMs,
      budgetMs,
      lastWindowMs: lastPassMs,
      lastWindowRecords: lastPassRecords,
      lastWindowRequested: lastPassRequested,
      ceilingReached: false,
      // "The provider ran out" means, here, that nothing could be selected.
      resultSetExhausted: nothingLeftToSelect,
    })

    if (!decision.proceed) {
      stopReason = decision.stop as SourcingStopReason
      break
    }

    // One PASS is one call to enrichApprovedBatch, capped at the same per-press limit the
    // screen has always named. That limit is not raised: what changed is how many passes one
    // request makes.
    const passSize = Math.min(ENRICHMENT_PER_PRESS_LIMIT, decision.windowRecords)
    const passStartedMs = clock()
    const run = await runPass(passSize)
    presses++

    totals.batch_size += run.batch_size
    totals.total_requested += run.total_requested_enrichments
    totals.enriched += run.unique_enriched_records
    totals.missing += run.missing_records
    totals.credits_consumed += run.credits_consumed

    logger.info('enrichment-continuation: pass complete', {
      organisation_id: organisationId,
      pass: presses,
      pass_size: passSize,
      batch_size: run.batch_size,
      enriched: run.unique_enriched_records,
      credits_consumed: run.credits_consumed,
      status: run.status,
      pass_ms: clock() - passStartedMs,
    })

    if (run.error_message) {
      // STOP, AND REPORT IT. See the note on `error` above: a failing press usually fails for a
      // reason the next one meets too, and continuing spends on each attempt.
      firstError = run.error_message
      stopReason = 'provider_exhausted'
      logger.error('enrichment-continuation: a pass failed, stopping', {
        organisation_id: organisationId,
        pass: presses,
        error: run.error_message,
      })
      break
    }

    // NOTHING SELECTABLE ENDS THE LOOP, and it is the ordinary ending. batch_size is what the
    // selection actually locked, so zero means there is nothing approved and unenriched left
    // that is not already locked by another run.
    if (run.batch_size === 0) {
      nothingLeftToSelect = true
      lastPassMs = clock() - passStartedMs
      lastPassRecords = 0
      lastPassRequested = passSize
      continue
    }

    processed += run.batch_size
    lastPassMs = clock() - passStartedMs
    lastPassRecords = run.batch_size
    lastPassRequested = passSize
  }

  const remaining = await countWaiting(supabase, organisationId)

  logger.info('enrichment-continuation: finished', {
    organisation_id: organisationId,
    presses,
    processed,
    enriched: totals.enriched,
    credits_consumed: totals.credits_consumed,
    remaining,
    stop_reason: stopReason,
    elapsed_ms: clock() - startedMs,
  })

  return {
    ...totals,
    presses,
    // -1 rather than 0 when the count could not be read, so a screen cannot render "0 waiting"
    // off a failed read. Callers check for a negative before printing a number.
    remaining: remaining ?? -1,
    stop_reason: stopReason,
    stop_message: describeEnrichmentStop(stopReason, totals.enriched, remaining, presses),
    error: firstError,
  }
}
