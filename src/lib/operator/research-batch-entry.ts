// Callable entry point for prospect research, shared by the operator dashboard route and
// the committed CLI. Everything an operator-triggered research batch must decide before it
// spends money lives here, so both surfaces decide it identically.
//
// WHY THIS EXISTS: runProspectResearchAgentV2Batch had exactly one caller in the repo, a
// script hardcoded to a stale organisation. The live 15-prospect batch was not reproducible
// from the application, and the throwaway-script habit that forced cost 22 USD in redundant
// research on 2026-08-20. This module is the production caller that was missing.
//
// It does NOT queue. A batch runs inside the calling function's timeout, and the admission
// check below refuses anything that would not finish in time. The durable queue is a
// separate build, tracked in BACKLOG.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  runProspectResearchAgentV2Batch,
  STORED_FINDINGS_MAX_AGE_DAYS,
} from '@/lib/agents/prospect-research-agent-v2'
import type { ResearchBatchSummary } from '@/lib/agents/research/types'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { logger } from '@/lib/logger'
import {
  checkResearchEligibility,
  summariseIneligible,
  type IneligibleReason,
} from '@/lib/sourcing/send-eligibility-policy'

// ── Runtime budget ────────────────────────────────────────────────────────────
//
// Measured on production agent_runs, 2026-08-20, at concurrency 5. These are WALL CLOCK
// seconds per prospect for the whole batch, not per-prospect durations, so they add up
// directly. Both are the worst observed rate, not the average, because an admission check
// that uses the average admits a batch that then times out half the time.
//
//   stored findings reused : 12 to 13 prospects in 35.7s to 61.5s  -> 5.1s worst
//   every source fetched   : 13 prospects in 406s to 609s          -> 46.8s worst
//
// If these numbers drift, re-measure with:
//   select count(*), max(completed_at) - min(started_at) from agent_runs
//   where agent_name = 'prospect-research-v2' ...
export const STORED_SECONDS_PER_PROSPECT = 5.1
export const FRESH_SECONDS_PER_PROSPECT = 46.8

// The surface this runs on is a Vercel function capped at 300s (maxDuration = 300, the
// Hobby ceiling and this repo's convention for every long route). 60s is held back for
// cold start, the auth round trips, and a slow tail, leaving 240s of usable work.
export const RUNTIME_BUDGET_SECONDS = 240

// Absolute backstop, independent of the estimate. The estimate reads how many prospects
// have stored findings on file; if that read is wrong in the optimistic direction, this is
// what stops a 300-prospect batch being admitted on a bad guess.
export const RESEARCH_MAX_PROSPECTS = 40

export type ResearchScope = 'unresearched' | 'researched'

export interface ResearchBatchEntryInput {
  /** Service-role client. Supplied by the caller so the route and the CLI share one client. */
  supabase: SupabaseClient
  organisation_id: string
  /**
   * Which prospects to run. 'unresearched' selects prospects that have never produced a
   * research result. 'researched' re-runs prospects that already have one. Ignored when
   * prospect_ids is supplied.
   */
  scope: ResearchScope
  /** Explicit prospect ids. Every id is verified to belong to organisation_id before use. */
  prospect_ids?: string[]
  /**
   * Reuse findings already on file instead of fetching all four sources. DEFAULTS TO TRUE,
   * which is the safe value: a fresh fetch is the expensive half of a run and re-fetching a
   * prospect that already has good findings must be a deliberate choice, never a default.
   */
  use_stored_findings?: boolean
  /**
   * Permit the run to overwrite personalisation_trigger and personalisation_question on
   * prospects that already have one. DEFAULTS TO FALSE and there is no dashboard control
   * that sets it. See the guard below for why.
   */
  allow_overwrite_trigger?: boolean
  concurrency?: number
}

export type ResearchBatchEntryResult =
  | {
      ok: true
      summary: ResearchBatchSummary
      use_stored_findings: boolean
      prospects_selected: number
      estimated_seconds: number
    }
  | { ok: false; error: string }

/** agent_runs rows that mean a research batch is already in flight for this organisation. */
const IN_FLIGHT_AGENT_NAMES = ['research_batch_entry', 'prospect-research-v2']

// Matches the reaper cron in /api/cron/reap-agent-runs, which marks any run still 'running'
// after 10 minutes as failed. A window shorter than the reaper's would call a live run
// stale; a longer one would keep refusing after the reaper had already cleared it.
const IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000

interface SelectedProspect {
  id: string
  has_trigger: boolean
}

/**
 * Runs a research batch for one organisation.
 *
 * Refuses, with an explicit error rather than a silent truncation, when:
 *   - the organisation does not exist or is archived
 *   - nothing matches the requested scope
 *   - a research batch is already in flight for this organisation
 *   - any selected prospect already holds a personalisation trigger and the caller has not
 *     explicitly allowed overwriting
 *   - the batch would not finish inside the runtime budget
 */
export async function runResearchBatchForOrg({
  supabase,
  organisation_id,
  scope,
  prospect_ids,
  use_stored_findings = true,
  allow_overwrite_trigger = false,
  concurrency = 5,
}: ResearchBatchEntryInput): Promise<ResearchBatchEntryResult> {
  // ── Organisation must exist and be active ──────────────────────────────────
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', organisation_id)
    .is('archived_at', null)
    .single()

  if (orgError || !org) {
    return { ok: false, error: `Organisation not found or archived: ${organisation_id}` }
  }

  // ── Select prospects ───────────────────────────────────────────────────────
  const selected = await selectProspects(supabase, organisation_id, scope, prospect_ids)
  if (!selected.ok) return selected

  const prospects = selected.prospects
  if (prospects.length === 0) {
    // Eligibility takes precedence in the message: it is the actionable reason, and the
    // generic ones below would otherwise hide it.
    if (selected.skippedIneligible > 0) {
      return {
        ok: false,
        error:
          `Nothing to research. ${selected.skippedIneligible} prospect(s) were filtered out as ` +
          `not worth researching: ${selected.skippedBreakdown}. Research costs roughly 60 times ` +
          'what composition costs per prospect, so it does not run on addresses we already know ' +
          'we cannot email. Verify them, or revisit the catch-all policy in ' +
          'src/lib/sourcing/send-eligibility-policy.ts.',
      }
    }
    const what = prospect_ids
      ? 'None of the supplied prospect ids belong to this organisation, or all of them are suppressed.'
      : scope === 'unresearched'
        ? 'Every prospect in this organisation has already been researched.'
        : 'No prospect in this organisation has been researched yet, so there is nothing to re-run.'
    return { ok: false, error: `Nothing to research. ${what}` }
  }

  // ── GUARD: never silently rewrite an opening that already exists ───────────
  //
  // updateProspect writes personalisation_trigger and personalisation_question on EVERY
  // run. It is not an append and it is not conditional:
  //
  //     personalisation_trigger:  opening.written_won ? opening.opening : null
  //
  // On a SEND verdict the stored opening is replaced with newly generated words. On a HOLD
  // verdict it is set to NULL, destroying the existing one outright. The judge holds often
  // enough for this to matter: of the 15 researched prospects in the client-zero
  // organisation on 2026-08-20, 12 hold a trigger and 3 hold NULL.
  //
  // A prospect with a trigger is a prospect whose copy is finished, and in most cases has
  // already shipped. Regenerating it is a legitimate thing to want and a catastrophic thing
  // to do by accident, so it requires saying so. The dashboard never sets this flag and
  // exposes no control that could: only the CLI can pass it, behind an explicit argument.
  const withTrigger = prospects.filter(p => p.has_trigger)
  if (withTrigger.length > 0 && !allow_overwrite_trigger) {
    return {
      ok: false,
      error:
        `Refused: ${withTrigger.length} of ${prospects.length} selected prospects already have a ` +
        'personalisation trigger, and researching them again overwrites it with new wording, or ' +
        'clears it entirely if the judge holds. Re-running finished copy has to be asked for ' +
        'explicitly. It is not available from the dashboard. Use the CLI with ' +
        '--allow-overwrite-trigger if that is genuinely what you want.',
    }
  }

  // ── Admission check: refuse what cannot finish in time ─────────────────────
  if (prospects.length > RESEARCH_MAX_PROSPECTS) {
    return {
      ok: false,
      error:
        `Refused: ${prospects.length} prospects exceeds the ${RESEARCH_MAX_PROSPECTS}-prospect ceiling for a ` +
        'single run. This entry point runs the batch inside one request and there is no job queue yet, ' +
        'so a larger batch would be killed mid-run by the platform timeout. Run it in smaller batches.',
    }
  }

  const estimate = await estimateSeconds(supabase, organisation_id, prospects, use_stored_findings)

  if (estimate.seconds > RUNTIME_BUDGET_SECONDS) {
    const admissible = maxAdmissible(estimate.freshCount, prospects.length)
    return {
      ok: false,
      error:
        `Refused: ${prospects.length} prospects would take about ${Math.round(estimate.seconds)}s ` +
        `(${estimate.storedCount} reusing stored findings, ${estimate.freshCount} fetching every source), ` +
        `over the ${RUNTIME_BUDGET_SECONDS}s budget for a single request. ` +
        `At this mix the limit is about ${admissible} prospects. ` +
        (estimate.freshCount > 0 && !use_stored_findings
          ? 'Fetching every source is what costs the time. Leave stored findings enabled to reuse what is on file.'
          : 'Run it in smaller batches.'),
    }
  }

  // ── In-flight guard ────────────────────────────────────────────────────────
  //
  // There is no database-level lock on a prospect row (BACKLOG carries SELECT FOR UPDATE
  // SKIP LOCKED as phase 2). Two concurrent batches for the same organisation research the
  // same prospects twice at full price, and worse, the FrameRegistry and
  // BatchUniquenessRegistry that guarantee no two prospects ship the same bridge or closing
  // question are per-batch and in-process, so neither batch can see the other's copy and
  // duplicate wording ships with no collision reported. This is a soft guard, not a lock:
  // it closes the operator-clicks-twice case, which is the one that actually happens.
  const inFlight = await findInFlightRun(supabase, organisation_id)
  if (inFlight) {
    return {
      ok: false,
      error:
        `Refused: a research run for this organisation started at ${inFlight} and has not finished. ` +
        'Running two at once researches the same prospects twice and breaks the check that stops two ' +
        'prospects being sent the same wording. Wait for it to finish, or wait 10 minutes for the ' +
        'reaper to clear it if it has died.',
    }
  }

  // ── Run ────────────────────────────────────────────────────────────────────
  const run = await startAgentRun({ organisation_id, agent_name: 'research_batch_entry' })

  logger.info('research-batch-entry: starting', {
    organisation_id,
    run_id: run.run_id,
    scope,
    prospect_count: prospects.length,
    use_stored_findings,
    allow_overwrite_trigger,
    stored_count: estimate.storedCount,
    fresh_count: estimate.freshCount,
    estimated_seconds: Math.round(estimate.seconds),
  })

  try {
    const summary = await runProspectResearchAgentV2Batch({
      prospect_ids: prospects.map(p => p.id),
      client_id: organisation_id,
      use_stored_findings,
      concurrency,
      // The selection above already decided what to run. skip_existing would re-apply that
      // decision with different logic and silently drop the whole 'researched' scope.
      skip_existing: false,
      // NEVER true here. At 10 or more prospects the batch prints a cost estimate and then
      // opens a readline on stdin. On a serverless surface stdin never answers and the
      // request hangs until the platform kills it.
      confirm_before_run: false,
    })

    await run.complete(
      `scope ${scope}, ${summary.completed} completed, ${summary.failed} failed, ` +
      `${summary.skipped} skipped, stored_findings ${use_stored_findings}`
    )

    logger.info('research-batch-entry: finished', {
      organisation_id,
      run_id: run.run_id,
      completed: summary.completed,
      failed: summary.failed,
      skipped: summary.skipped,
    })

    return {
      ok: true,
      summary,
      use_stored_findings,
      prospects_selected: prospects.length,
      estimated_seconds: Math.round(estimate.seconds),
    }
  } catch (err) {
    // The batch throws FatalApiError when a provider credit balance runs out, which aborts
    // the remaining prospects rather than writing a proxy over good data on each one. That
    // is a real failure and must not be reported as a completed batch.
    const errorMsg = err instanceof Error ? err.message : String(err)
    await run.fail(errorMsg)
    logger.error('research-batch-entry: run failed', {
      organisation_id,
      run_id: run.run_id,
      error: errorMsg,
    })
    return { ok: false, error: `Research batch failed: ${errorMsg}` }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type SelectResult =
  | { ok: true; prospects: SelectedProspect[]; skippedIneligible: number; skippedBreakdown: string | null }
  | { ok: false; error: string }

async function selectProspects(
  supabase: SupabaseClient,
  organisation_id: string,
  scope: ResearchScope,
  prospect_ids: string[] | undefined,
): Promise<SelectResult> {
  // Suppressed prospects are excluded everywhere. They are opted out or disqualified and
  // researching them spends money on copy that can never be sent.
  let query = supabase
    .from('prospects')
    // Raw verification columns, not email_send_eligible. See send-eligibility-policy.ts for
    // why the materialised column is the wrong input here.
    .select('id, personalisation_trigger, independent_verified_at, independent_email_status, email_send_ineligible_reason')
    .eq('organisation_id', organisation_id)
    .eq('suppressed', false)

  if (prospect_ids && prospect_ids.length > 0) {
    // The organisation_id filter above is what enforces isolation: an id belonging to
    // another client simply does not come back, rather than being researched under the
    // wrong client's positioning.
    query = query.in('id', prospect_ids)
  } else if (scope === 'unresearched') {
    query = query.is('current_research_result_id', null)
  } else {
    query = query.not('current_research_result_id', 'is', null)
  }

  const { data, error } = await query

  if (error) {
    return { ok: false, error: `Could not read prospects: ${error.message}` }
  }

  // ── SEND-ELIGIBILITY GATE ──────────────────────────────────────────────────
  //
  // Identical policy to the queue path (src/lib/queue/enqueue/research.ts), from the same
  // module, applied in the same commit. That file's header states the standing rule: a
  // prospect must be eligible under ONE definition, or flipping queue_research changes
  // WHICH prospects get researched rather than only how. Two copies of this rule would
  // recreate exactly that divergence.
  //
  // NOTE this applies even when explicit prospect_ids are supplied. An operator naming ids
  // by hand is the case where a quiet re-spend on a dead address is MOST likely, not least.
  const prospects: SelectedProspect[] = []
  const skippedReasons: IneligibleReason[] = []
  for (const row of data ?? []) {
    const verdict = checkResearchEligibility({
      independent_verified_at:      (row.independent_verified_at as string | null) ?? null,
      independent_email_status:     (row.independent_email_status as string | null) ?? null,
      email_send_ineligible_reason: (row.email_send_ineligible_reason as string | null) ?? null,
    })
    if (!verdict.eligible) { skippedReasons.push(verdict.reason); continue }
    prospects.push({
      id: row.id as string,
      has_trigger: (row.personalisation_trigger as string | null) != null,
    })
  }

  return {
    ok: true,
    prospects,
    skippedIneligible: skippedReasons.length,
    skippedBreakdown: skippedReasons.length > 0 ? summariseIneligible(skippedReasons) : null,
  }
}

interface Estimate {
  seconds: number
  storedCount: number
  freshCount: number
}

/**
 * How long this batch will take, from how many of its prospects can actually reuse stored
 * findings.
 *
 * use_stored_findings TRUE does NOT mean every prospect skips its sources. A prospect with
 * nothing usable on file falls back to a full fetching run, silently and correctly. So a
 * 40-prospect batch of never-researched prospects with the flag on is 40 fetching runs and
 * roughly 30 minutes, not 3 minutes. Counting the mix is the only way to tell those apart.
 *
 * Fails PESSIMISTIC: if the lookup errors, every prospect is counted as a fetching run, so
 * a database fault produces a refusal rather than an admitted batch that times out.
 */
async function estimateSeconds(
  supabase: SupabaseClient,
  organisation_id: string,
  prospects: SelectedProspect[],
  use_stored_findings: boolean,
): Promise<Estimate> {
  const total = prospects.length

  if (!use_stored_findings) {
    return { seconds: total * FRESH_SECONDS_PER_PROSPECT, storedCount: 0, freshCount: total }
  }

  const cutoff = new Date(
    Date.now() - STORED_FINDINGS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  // Only prospect_id is selected. The candidates payload is large and is not needed to
  // answer "does this prospect have anything usable on file".
  const { data, error } = await supabase
    .from('prospect_research_results')
    .select('prospect_id')
    .eq('organisation_id', organisation_id)
    .in('prospect_id', prospects.map(p => p.id))
    .gte('created_at', cutoff)
    .not('candidates', 'is', null)
    .neq('candidates', '[]')

  if (error) {
    logger.warn('research-batch-entry: stored-findings count failed, assuming every prospect fetches', {
      organisation_id,
      error: error.message,
    })
    return { seconds: total * FRESH_SECONDS_PER_PROSPECT, storedCount: 0, freshCount: total }
  }

  const storedIds = new Set((data ?? []).map(row => row.prospect_id as string))
  const storedCount = prospects.filter(p => storedIds.has(p.id)).length
  const freshCount = total - storedCount

  return {
    seconds: storedCount * STORED_SECONDS_PER_PROSPECT + freshCount * FRESH_SECONDS_PER_PROSPECT,
    storedCount,
    freshCount,
  }
}

/** How many prospects fit the budget at the mix this batch actually has. */
function maxAdmissible(freshCount: number, total: number): number {
  const freshShare = total > 0 ? freshCount / total : 1
  const perProspect =
    freshShare * FRESH_SECONDS_PER_PROSPECT + (1 - freshShare) * STORED_SECONDS_PER_PROSPECT
  return Math.max(1, Math.floor(RUNTIME_BUDGET_SECONDS / perProspect))
}

/** The start time of a research run still in flight for this organisation, if there is one. */
async function findInFlightRun(
  supabase: SupabaseClient,
  organisation_id: string,
): Promise<string | null> {
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString()

  const { data, error } = await supabase
    .from('agent_runs')
    .select('started_at')
    .eq('organisation_id', organisation_id)
    .in('agent_name', IN_FLIGHT_AGENT_NAMES)
    .eq('status', 'running')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1)

  if (error) {
    // A guard that cannot read is not a reason to block work. The failure is logged and the
    // run proceeds, which is the behaviour before this guard existed.
    logger.warn('research-batch-entry: in-flight check failed, proceeding', {
      organisation_id,
      error: error.message,
    })
    return null
  }

  return data && data.length > 0 ? (data[0].started_at as string) : null
}
