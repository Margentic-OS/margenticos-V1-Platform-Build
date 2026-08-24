// Running a claimed batch of enrichment jobs.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SHAPE OF THIS FILE IS DICTATED BY APOLLO, NOT BY PREFERENCE
//
// people/bulk_match takes TEN people per HTTP call and returns ONE credits_consumed
// figure for the whole call. It never says which individual record was billed. So:
//
//   ONE Apollo call covers the whole claimed batch, up to ten prospects.
//   SPEND IS STAMPED ON EVERY JOB IN THE BATCH the instant that call returns.
//
// The second line is the important one. Because Apollo cannot attribute credits per
// record, marking all of them is the only safe reading: over-marking costs a prospect an
// explicit re-enrichment later, while under-marking spends money twice. That is the same
// judgement recordBatchSpend already makes at the prospect level, and it is written down
// in adapter-apollo-enrichment.ts.
//
// ── WHAT THIS DOES AND DOES NOT ISOLATE ──
//
//   ISOLATED     a per-prospect verdict. No match, unverified email, dedupe hit. Each
//                is written to its own job row and its own prospect row.
//   NOT ISOLATED a transport-level failure of the shared call. All the jobs in the batch
//                fail together, because there was one call and it did not return.
//
// That trade-off is deliberate and was accepted when p_limit was added to claim_jobs.
// The alternative is one call per prospect: ten times the requests against a 600/hour
// ceiling, for identical cost in credits, and still no per-record attribution.
//
// ── WHY A "HELD" VERDICT IS A SUCCESSFUL JOB ──
//
// held_duplicate, held_unverified, held_no_email and held_missing are ANSWERS, not
// failures. The job's purpose is "reach a verdict for this prospect", and it did. Marking
// them failed would inflate MON-018, invite retries of work that is finished, and
// eventually terminate a prospect that was correctly held. Only a thrown error is a
// failure here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { classifyError, describeError, isAccountExhaustion } from '../error-classification'
import { decideExecution } from '../execute-job'
import type { JobOutcome } from '../execute-job'
import { completeJob, failJob, recordJobSpend } from '../job-queue'
import type { JobRow } from '../types'
import { enrichProspectsForOrganisation } from '@/lib/sourcing/handlers/adapter-apollo-enrichment'

const APOLLO_KEY_PREFIX = 'apollo:'

export async function enrichBatchExecutor(
  supabase: SupabaseClient,
  jobs: JobRow[],
  workerId: string,
): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = []
  if (jobs.length === 0) return outcomes

  // ── The spend gate, per job, BEFORE anything is called ──────────────────────
  //
  // A reclaimed job that already carries a stamp is excluded from the Apollo call
  // entirely and terminated. Leaving it in the batch would re-buy that contact, which is
  // the exact bug the stamp exists to prevent.
  const runnable: JobRow[] = []
  for (const job of jobs) {
    const decision = decideExecution(job)
    if (decision.action === 'terminate') {
      logger.error('enrich-executor: excluding a job that was already paid for', {
        job_id: job.id, prospect_id: job.prospect_id, spend_recorded_at: job.spend_recorded_at,
      })
      await safeFail(supabase, job, workerId, decision.reason, 'permanent', true)
      outcomes.push({
        status: 'failed', jobId: job.id, error: decision.reason,
        errorClass: 'permanent', terminatedForSpend: true, accountExhausted: false,
      })
      continue
    }
    runnable.push(job)
  }
  if (runnable.length === 0) return outcomes

  // Every job in a claimed batch belongs to one organisation, because claim_jobs is
  // scoped to a single organisation_id. Asserted rather than assumed: enriching one
  // client's prospect under another client's run is the most serious error this system
  // can make.
  const organisationId = runnable[0].organisation_id
  const foreign = runnable.filter(j => j.organisation_id !== organisationId)
  if (foreign.length > 0) {
    const msg =
      `Refusing to enrich: claimed batch spans ${foreign.length + 1} organisations. ` +
      'claim_jobs is scoped to one organisation, so this should be impossible.'
    logger.error('enrich-executor: batch spans multiple organisations', {
      organisation_id: organisationId, foreign_job_ids: foreign.map(j => j.id),
    })
    for (const job of runnable) {
      await safeFail(supabase, job, workerId, msg, 'permanent', false)
      outcomes.push({
        status: 'failed', jobId: job.id, error: msg,
        errorClass: 'permanent', terminatedForSpend: false, accountExhausted: false,
      })
    }
    return outcomes
  }

  // ── Resolve the prospects ───────────────────────────────────────────────────
  const prospectIds = runnable.map(j => j.prospect_id)
  const { data: prospectRows, error: prospectError } = await supabase
    .from('prospects')
    .select('id, source_person_key')
    .eq('organisation_id', organisationId)   // isolation, enforced on the query too
    .in('id', prospectIds)

  if (prospectError) {
    const msg = `Could not load prospects for the claimed batch: ${prospectError.message}`
    for (const job of runnable) {
      await safeFail(supabase, job, workerId, msg, 'transient', false)
      outcomes.push({
        status: 'failed', jobId: job.id, error: msg,
        errorClass: 'transient', terminatedForSpend: false, accountExhausted: false,
      })
    }
    return outcomes
  }

  const keyByProspect = new Map<string, string>()
  for (const row of prospectRows ?? []) {
    keyByProspect.set(row.id as string, row.source_person_key as string)
  }

  // A prospect whose source_person_key is missing or not an Apollo key cannot be
  // enriched by this handler, ever. Terminal and excluded from the paid call, so a
  // malformed row cannot spend money or consume retries.
  const callable: JobRow[] = []
  const apolloIds: string[] = []
  for (const job of runnable) {
    const key = keyByProspect.get(job.prospect_id)
    if (!key || !key.startsWith(APOLLO_KEY_PREFIX)) {
      const msg =
        `Prospect ${job.prospect_id} has ${key ? `source_person_key "${key}"` : 'no source_person_key'}, ` +
        'which this handler cannot enrich. Apollo enrichment needs a key of the form "apollo:<id>".'
      await safeFail(supabase, job, workerId, msg, 'permanent', false)
      outcomes.push({
        status: 'failed', jobId: job.id, error: msg,
        errorClass: 'permanent', terminatedForSpend: false, accountExhausted: false,
      })
      continue
    }
    callable.push(job)
    apolloIds.push(key.slice(APOLLO_KEY_PREFIX.length))
  }
  if (callable.length === 0) return outcomes

  // ── The paid call ───────────────────────────────────────────────────────────
  //
  // maxRunBatchSize is apolloIds.length so the handler issues EXACTLY ONE bulk_match
  // call. The queue has already decided how much work to do; letting the adapter batch
  // internally as well would make the claimed batch and the billed batch different
  // things, and the spend stamp below assumes they are the same.
  let run: Awaited<ReturnType<typeof enrichProspectsForOrganisation>>
  try {
    run = await enrichProspectsForOrganisation(
      supabase as never, organisationId, apolloIds, apolloIds.length,
    )
  } catch (err) {
    // THE UNAVOIDABLE WINDOW. Apollo may have received and billed this request even
    // though we never saw the response. Nothing is stamped, so a retry may pay again.
    // See the KNOWN LIMITATION block in execute-job.ts for why stamping before the call
    // would be worse: it would make every 429 and connection refusal look paid.
    const errorClass = classifyError(err)
    const errorText = describeError(err)
    const exhausted = isAccountExhaustion(err)

    logger.error('enrich-executor: the Apollo call failed for the whole batch', {
      organisation_id: organisationId, batch_size: callable.length,
      error_class: errorClass, account_exhausted: exhausted, error: errorText,
    })

    for (const job of callable) {
      await safeFail(supabase, job, workerId, errorText, errorClass, false)
      outcomes.push({
        status: 'failed', jobId: job.id, error: errorText,
        errorClass, terminatedForSpend: false, accountExhausted: exhausted,
      })
    }
    return outcomes
  }

  // ── THE MONEY IS GONE AS OF THE LINE ABOVE ──────────────────────────────────
  //
  // Stamp every job before anything that can throw. Not inside a try: recordJobSpend
  // already swallows its own errors, and wrapping it would only hide that.
  const spendDetail = {
    label: 'apollo.bulk_match',
    credits_consumed: run.credits_consumed,
    batch_size: callable.length,
    enriched: run.unique_enriched_records,
    missing: run.missing_records,
    status: run.status,
  }
  for (const job of callable) {
    await recordJobSpend(supabase, job.id, spendDetail)
  }

  logger.info('enrich-executor: batch call complete, spend recorded on every job', {
    organisation_id: organisationId, batch_size: callable.length,
    credits_consumed: run.credits_consumed, status: run.status,
  })

  // ── Per-job verdicts ────────────────────────────────────────────────────────
  //
  // enrichProspectsForOrganisation has already written each prospect's enrichment_status.
  // Read it back rather than inferring from the run summary, which is per batch and
  // cannot say what happened to an individual prospect.
  const { data: verdictRows } = await supabase
    .from('prospects')
    .select('id, enrichment_status')
    .eq('organisation_id', organisationId)
    .in('id', callable.map(j => j.prospect_id))

  const statusByProspect = new Map<string, string | null>()
  for (const row of verdictRows ?? []) {
    statusByProspect.set(row.id as string, (row.enrichment_status as string | null) ?? null)
  }

  for (const job of callable) {
    const status = statusByProspect.get(job.prospect_id) ?? 'unknown'
    // A held verdict is an answer, not a failure. See the header.
    const summary = `apollo enrichment: ${status} (batch of ${callable.length}, ${run.credits_consumed} credit(s))`

    try {
      const completed = await completeJob(supabase, job.id, workerId, summary)
      if (completed === null) {
        logger.error('enrich-executor: work finished but the lease had been reclaimed', {
          job_id: job.id, prospect_id: job.prospect_id, worker: workerId,
        })
        outcomes.push({ status: 'lease_lost', jobId: job.id, summary })
        continue
      }
      outcomes.push({ status: 'done', jobId: job.id, summary })
    } catch (err) {
      // Bookkeeping failure, not a work failure. The prospect IS enriched and the credit
      // IS spent, so this job must not be marked failed. The lease lapses, reclaim
      // requeues, and the spend gate terminates that attempt without calling Apollo again.
      logger.error('enrich-executor: enrichment succeeded but the completion write failed', {
        job_id: job.id, prospect_id: job.prospect_id,
        error: err instanceof Error ? err.message : String(err),
      })
      outcomes.push({ status: 'completion_write_failed', jobId: job.id, summary })
    }
  }

  return outcomes
}

/** failJob that cannot throw. Mirrors safeFail in execute-job.ts. */
async function safeFail(
  supabase: SupabaseClient,
  job: JobRow,
  workerId: string,
  errorText: string,
  errorClass: 'transient' | 'permanent',
  forceTerminal: boolean,
): Promise<void> {
  try {
    await failJob(supabase, job.id, workerId, errorText, errorClass, forceTerminal)
  } catch (err) {
    logger.error('enrich-executor: could not write the failure, leaving the lease to lapse', {
      job_id: job.id, original_error: errorText,
      write_error: err instanceof Error ? err.message : String(err),
    })
  }
}
