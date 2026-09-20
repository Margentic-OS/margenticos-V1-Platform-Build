// WHAT IS MOVING RIGHT NOW, for one organisation.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Three long-running steps on the pipeline screen reported their progress ONLY through
// React state in the button that started them:
//
//   verification   nothing at all. No stage, no backlog, no last-completed time. A cron
//                  sweep has owned this since 2026-08-25 and no screen has ever named it,
//                  so a prospect waiting its turn and a prospect nothing will ever touch
//                  looked identical: both simply absent from everything downstream.
//   enrichment     "Enriching..." and then "Complete". No numerator, no denominator.
//   research       a queued message, then nothing until the very end.
//
// TWO CONSEQUENCES, and the second is the one that cost time.
//
// 1. A REFRESH ERASED IT. The state lived in the component, so reloading the page during a
//    step that takes a quarter of an hour showed the screen as it looks before the step
//    starts. Nothing was wrong and the screen said nothing was happening.
//
// 2. THE BATCH RESEARCH PATH HAS A WINDOW WITH NO JOB ROW IN IT AT ALL. Phase 1 fetches
//    sources and marks its job done; phase 2's job is not created until the sweep sees
//    results come back. Measured on production 2026-09-17: phase 1 ended 19:48:31, phase 2
//    was created 20:03:03. For 14 minutes 32 seconds, 62 prospects were mid-flight with no
//    queue row anywhere, and the only marker the pipeline reads (research_ran_at) is written
//    at the very end. An operator watching that concludes it has stalled, because every
//    other stage announces itself through the queue and this one cannot.
//
// So progress is DERIVED FROM DURABLE STATE rather than remembered in a component: the job
// queue, the batch tables, and the prospect columns the sweeps write. A reload re-reads it,
// a second operator sees the same thing, and the fifteen-minute wait has a name.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE CLIENT MUST BE SERVICE-ROLE. job_queue, system_flags, synthesis_batches,
// synthesis_batch_entries and cron_heartbeats all have RLS on with zero policies and no
// authenticated grant. See ADR-027 and the header of research-verdict.ts.
//
// ═════════════════════════════════════════════════════════════════════════════
// NO RAW PROVIDER STATUS CODES LEAVE THIS MODULE, and that is a Rule Zero point rather
// than a styling one. See describeVerificationHold below.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  countPendingVerification,
  type VerificationThresholds,
} from '@/lib/sourcing/pending-verification'
import {
  OPEN_BATCH_STATES,
  AWAITING_MODEL_ENTRY_STATES,
} from '@/lib/agents/research/types'

/** Job states that mean the queue still owes this work. Claimed is running; queued is next. */
const LIVE_JOB_STATES = ['queued', 'claimed'] as const

// ═════════════════════════════════════════════════════════════════════════════
// VERIFICATION

export interface VerificationProgress {
  /** Prospects the sweep would pick up next. Counted by the sweep's OWN filter. */
  waiting: number
  /**
   * Prospects locked by a run that is working on them right now.
   *
   * THE ONLY EVIDENCE THAT VERIFICATION IS RUNNING rather than merely scheduled.
   * verification_locked_at is written when a batch takes its rows and cleared when it
   * finishes with them, so a non-zero count here is a live run, not an intention.
   */
  inFlight: number
  /** The most recent verdict written for this organisation, or null if none ever was. */
  lastCompletedAt: string | null
  /**
   * When the sweep last ran AT ALL, across every organisation.
   *
   * ORGANISATION-WIDE ON PURPOSE, unlike every other number here. The sweep does one
   * organisation per invocation, oldest backlog first, so "it has not reached you yet" and
   * "it has stopped running" are different states and only this tells them apart. A screen
   * that showed a per-organisation time would report a healthy sweep as dead whenever
   * another client was ahead in the queue.
   */
  sweepLastRanAt: string | null
}

// ═════════════════════════════════════════════════════════════════════════════
// ENRICHMENT

export interface EnrichmentProgress {
  /** Approved prospects already enriched. The numerator. */
  done: number
  /** Approved prospects still waiting. Same predicate as the Enriching card. */
  waiting: number
  /** Enrichment jobs the queue is holding, when the queued path is on. */
  inFlight: number
}

// ═════════════════════════════════════════════════════════════════════════════
// RESEARCH

/**
 * Which stage currently holds work, named the way an operator would describe it.
 *
 * 'idle' means no research is in flight. It does NOT mean none has ever run.
 */
export type ResearchStage =
  | 'idle'
  | 'fetching_sources'
  | 'awaiting_model'
  | 'collecting'

export interface ResearchProgress {
  stage: ResearchStage
  /** research_sources jobs queued or claimed. */
  fetchingSources: number
  /**
   * Prospects whose synthesis is with the model and which have NO queue row.
   *
   * This is the fifteen-minute window. It is counted from synthesis_batch_entries because
   * that is the only place it exists.
   */
  awaitingModel: number
  /** research_collect jobs queued or claimed. */
  collecting: number
  /**
   * Prospects finished inside the waves still open, and how many those waves hold in total.
   *
   * SCOPED TO THE OPEN WAVES, not to all time. An all-time "researched" number answers a
   * different question and is already on the run list; what an operator watching a step
   * needs is how far THIS run has got. Both are null when nothing is open, because a
   * denominator of zero renders as "0 of 0 done", which reads as failure rather than as
   * nothing running.
   */
  waveDone: number | null
  waveTotal: number | null
  /**
   * When the oldest open batch was handed to the provider, so the screen can say how long
   * the wait has been rather than only that there is one.
   */
  oldestBatchSubmittedAt: string | null
}

export interface PipelineProgress {
  verification: VerificationProgress
  enrichment: EnrichmentProgress
  research: ResearchProgress
}

/** One `head: true` count against a table, scoped to an organisation. Throws on error. */
async function countScoped(
  supabase: SupabaseClient,
  table: string,
  organisationId: string,
  shape: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<number> {
  const { count, error } = await shape(
    supabase.from(table).select('id', { count: 'exact', head: true }).eq('organisation_id', organisationId),
  )

  // FAIL LOUD, matching countProspects in sourcing-metrics.ts. A stage count that returns 0
  // on error renders as "nothing in flight", which is exactly the reading this module exists
  // to stop an operator making by accident.
  if (error) {
    throw new Error(`Could not count ${table} for ${organisationId}: ${error.message}`)
  }
  return count ?? 0
}

/**
 * How far through each long-running step this organisation is.
 *
 * Every read is a head-only count or a single-row order-by, and they run in parallel. This
 * is called once per organisation per poll, alongside the counts in sourcing-metrics.ts.
 */
export async function getPipelineProgress(
  supabase: SupabaseClient,
  organisationId: string,
  thresholds: VerificationThresholds,
  /** Pre-read once per request, not once per organisation. The sweep is global. */
  sweepLastRanAt: string | null,
): Promise<PipelineProgress> {
  const [
    verificationWaiting,
    verificationInFlight,
    lastVerified,
    enrichmentDone,
    enrichmentWaiting,
    enrichmentInFlight,
    fetchingSources,
    collecting,
    openBatches,
  ] = await Promise.all([
    countPendingVerification(supabase, organisationId, thresholds),
    countScoped(supabase, 'prospects', organisationId, q =>
      q.not('verification_locked_at', 'is', null)),
    supabase
      .from('prospects')
      .select('independent_verified_at')
      .eq('organisation_id', organisationId)
      .not('independent_verified_at', 'is', null)
      .order('independent_verified_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    countScoped(supabase, 'prospects', organisationId, q =>
      q.eq('sourcing_review_status', 'approved').eq('enrichment_status', 'enriched')),
    // THE SAME PREDICATE AS THE "Enriching" CARD, including `tiering_reason IS NULL`. A
    // prospect the buyer gate rejected before enrichment is approved and unenriched and will
    // never be enriched, so counting it as waiting would make this denominator drift
    // permanently upward against a queue that is actually empty. See sourcing-metrics.ts.
    countScoped(supabase, 'prospects', organisationId, q =>
      q.eq('sourcing_review_status', 'approved')
        .is('enrichment_status', null)
        .is('tiering_reason', null)),
    countScoped(supabase, 'job_queue', organisationId, q =>
      q.eq('job_type', 'enrich').in('state', LIVE_JOB_STATES)),
    countScoped(supabase, 'job_queue', organisationId, q =>
      q.eq('job_type', 'research_sources').in('state', LIVE_JOB_STATES)),
    countScoped(supabase, 'job_queue', organisationId, q =>
      q.eq('job_type', 'research_collect').in('state', LIVE_JOB_STATES)),
    supabase
      .from('synthesis_batches')
      .select('id, request_count, submitted_at')
      .eq('organisation_id', organisationId)
      .in('state', OPEN_BATCH_STATES)
      .order('submitted_at', { ascending: true, nullsFirst: false }),
  ])

  if (lastVerified.error) {
    throw new Error(
      `Could not read the last verification time for ${organisationId}: ${lastVerified.error.message}`,
    )
  }
  if (openBatches.error) {
    throw new Error(
      `Could not read open synthesis batches for ${organisationId}: ${openBatches.error.message}`,
    )
  }

  const batches = (openBatches.data ?? []) as unknown as Array<{
    id: string
    request_count: number | null
    submitted_at: string | null
  }>

  // ── The wave, and the window with no job row in it ────────────────────────
  //
  // Counted from the ENTRIES of the open batches rather than from the job queue, because
  // during the wait there is no job to count. Two numbers come out of one read: how many are
  // still with the model, and how many of the wave have already come back.
  let awaitingModel = 0
  let waveDone: number | null = null
  let waveTotal: number | null = null

  if (batches.length > 0) {
    const batchIds = batches.map(b => b.id)

    const [awaiting, collected] = await Promise.all([
      supabase
        .from('synthesis_batch_entries')
        .select('id', { count: 'exact', head: true })
        .eq('organisation_id', organisationId)
        .in('batch_id', batchIds)
        .in('state', AWAITING_MODEL_ENTRY_STATES),
      supabase
        .from('synthesis_batch_entries')
        .select('id', { count: 'exact', head: true })
        .eq('organisation_id', organisationId)
        .in('batch_id', batchIds)
        .eq('state', 'collected'),
    ])

    if (awaiting.error) {
      throw new Error(`Could not count batch entries for ${organisationId}: ${awaiting.error.message}`)
    }
    if (collected.error) {
      throw new Error(`Could not count collected entries for ${organisationId}: ${collected.error.message}`)
    }

    awaitingModel = awaiting.count ?? 0
    waveDone = collected.count ?? 0
    // request_count is what the provider was ASKED for, so it is the denominator even when
    // some entries have not been written yet. A null one contributes nothing rather than
    // being guessed at.
    waveTotal = batches.reduce((sum, b) => sum + (b.request_count ?? 0), 0)
  }

  // ── Which stage to name ───────────────────────────────────────────────────
  //
  // FIRST NON-EMPTY IN PIPELINE ORDER, not the largest. Work flows sources -> model ->
  // collect, so the earliest stage still holding anything is the one the wave is actually
  // waiting on. Naming the biggest pile instead would jump the label backwards as a wave
  // drains, which reads as work going in reverse.
  const stage: ResearchStage =
    fetchingSources > 0 ? 'fetching_sources'
    : awaitingModel > 0 ? 'awaiting_model'
    : collecting > 0 ? 'collecting'
    : 'idle'

  return {
    verification: {
      waiting: verificationWaiting,
      inFlight: verificationInFlight,
      lastCompletedAt: (lastVerified.data as { independent_verified_at: string } | null)
        ?.independent_verified_at ?? null,
      sweepLastRanAt,
    },
    enrichment: {
      done: enrichmentDone,
      waiting: enrichmentWaiting,
      inFlight: enrichmentInFlight,
    },
    research: {
      stage,
      fetchingSources,
      awaitingModel,
      collecting,
      waveDone,
      waveTotal,
      oldestBatchSubmittedAt: batches.find(b => b.submitted_at !== null)?.submitted_at ?? null,
    },
  }
}

/**
 * When the verification sweep last ran, across every organisation.
 *
 * READ ONCE PER REQUEST. The sweep is global and the pipeline screen renders every client at
 * once, so reading this inside the per-organisation loop asked one question three times for
 * three identical answers. Same reasoning as readResearchPath in research-verdict.ts.
 *
 * A read failure is reported as NULL, not as an error, and this is the one place in this
 * module that swallows one. The heartbeat is a liveness HINT beside the real counts; failing
 * the whole metrics payload because a decorative timestamp could not be read would take the
 * counts off the screen too, and those are what the operator came for.
 */
export async function readVerificationSweepHeartbeat(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('cron_heartbeats')
    .select('ran_at')
    .eq('job_name', 'verify-pending')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return null
  return (data as { ran_at: string } | null)?.ran_at ?? null
}
