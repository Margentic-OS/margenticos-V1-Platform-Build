// Callable entry point for prospect sourcing, shared by the operator dashboard route and
// the committed CLI.
//
// WHY THIS EXISTS: runSourcing had no production caller. Its only callers were three
// scripts/phase4-*.ts files, each hardcoded to one organisation and one batch size. A grep
// of src/app returned nothing, so a client could not be sourced without someone hand-running
// a script. This module is the production caller that was missing.
//
// It does NOT queue. The batch runs inside the calling function's timeout and the cap below
// refuses anything that would not finish in time.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { runSourcing } from '@/lib/sourcing/orchestrator'
import type { SourcingTriggerType } from '@/lib/sourcing/types'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { logger } from '@/lib/logger'

// ── Runtime budget ────────────────────────────────────────────────────────────
//
// Measured on production agent_runs across 15 completed runs at target_batch_size 25:
//
//   25 candidates, 0 written (all deduped) : 11.9s, 12.7s      -> about 12s fixed
//   25 candidates, 25 written              : 16.0s to 19.1s    -> about 0.22s per write
//
// The write loop is sequential, one round trip per prospect, which is what the marginal
// figure measures. Apollo returns 100 per page with a 300ms throttle between pages, so a
// request for more than 100 adds roughly 2.5s per extra page.
//
// Against the 240s usable budget (300s function ceiling less 60s for cold start, auth and a
// slow tail) the real limit is around 900 prospects. The cap is set well under that: nothing
// here needs 900, and the headroom absorbs a slow Apollo response without a killed request.
export const SOURCING_FIXED_SECONDS = 12
export const SOURCING_SECONDS_PER_PROSPECT = 0.22
export const SOURCING_SECONDS_PER_EXTRA_PAGE = 2.5
export const SOURCING_RUNTIME_BUDGET_SECONDS = 240
export const SOURCING_MAX_BATCH_SIZE = 500

export interface SourcingEntryInput {
  /** Service-role client. Supplied by the caller so the route and the CLI share one client. */
  // ServiceRoleClient: this path writes prospects and reads the dedupe tables.
  supabase: ServiceRoleClient
  organisation_id: string
  /** How many prospects to ask the sourcing handler for. */
  target_batch_size: number
  trigger_type?: SourcingTriggerType
  /**
   * The operator who clicked. Recorded on the run record.
   *
   * The route always had this and threw it away. Optional here because the CLI has no
   * operator, and a run with nobody to attribute it to is a real case rather than an error.
   */
  created_by?: string | null
}

export type SourcingEntryResult =
  | {
      ok: true
      candidates_sourced: number
      candidates_qualified: number
      run_timestamp: string
      estimated_seconds: number
      /** The batch this run created. NULL if the run record could not be written. */
      sourcing_run_id: string | null
    }
  | { ok: false; error: string }

const IN_FLIGHT_AGENT_NAME = 'sourcing_entry'

// Matches the reaper cron in /api/cron/reap-agent-runs.
const IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000

/**
 * Sources prospects for one organisation.
 *
 * Refuses, with an explicit error rather than a silent truncation, when:
 *   - the organisation does not exist or is archived
 *   - target_batch_size is not a positive integer, or exceeds the cap
 *   - a sourcing run is already in flight for this organisation
 */
export async function runSourcingForOrg({
  supabase,
  organisation_id,
  target_batch_size,
  trigger_type = 'operator_manual',
  created_by = null,
}: SourcingEntryInput): Promise<SourcingEntryResult> {
  // ── Validate the batch size ────────────────────────────────────────────────
  if (!Number.isInteger(target_batch_size) || target_batch_size < 1) {
    return { ok: false, error: `Batch size must be a whole number of 1 or more, got ${target_batch_size}.` }
  }

  if (target_batch_size > SOURCING_MAX_BATCH_SIZE) {
    return {
      ok: false,
      error:
        `Refused: ${target_batch_size} exceeds the ${SOURCING_MAX_BATCH_SIZE}-prospect ceiling for a single ` +
        'run. This entry point runs the batch inside one request and there is no job queue yet, so a ' +
        'larger batch risks being killed mid-run by the platform timeout, after Apollo credits have ' +
        'already been spent. Run it in smaller batches.',
    }
  }

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

  // ── In-flight guard ────────────────────────────────────────────────────────
  //
  // There is a unique index on (organisation_id, source_person_key), and the dedupe step
  // reads the database before either concurrent run writes. So two runs both pass dedupe,
  // then the second hits a unique violation partway through its sequential insert loop and
  // aborts part-written, having already spent Apollo credits on a batch it cannot keep.
  // A soft guard closes the operator-clicks-twice case, which is the one that happens.
  const inFlight = await findInFlightRun(supabase, organisation_id)
  if (inFlight) {
    return {
      ok: false,
      error:
        `Refused: a sourcing run for this organisation started at ${inFlight} and has not finished. ` +
        'Running two at once spends Apollo credits twice and the second run fails part-written on a ' +
        'duplicate key. Wait for it to finish, or wait 10 minutes for the reaper to clear it if it ' +
        'has died.',
    }
  }

  const estimatedSeconds =
    SOURCING_FIXED_SECONDS +
    target_batch_size * SOURCING_SECONDS_PER_PROSPECT +
    Math.max(0, Math.ceil(target_batch_size / 100) - 1) * SOURCING_SECONDS_PER_EXTRA_PAGE

  const run = await startAgentRun({ organisation_id, agent_name: IN_FLIGHT_AGENT_NAME })

  logger.info('sourcing-entry: starting', {
    organisation_id,
    run_id: run.run_id,
    trigger_type,
    target_batch_size,
    estimated_seconds: Math.round(estimatedSeconds),
  })

  try {
    // The agent_runs id is passed through so the two records stay tied together rather than
    // becoming rival histories of the same run.
    const result = await runSourcing(supabase, organisation_id, trigger_type, target_batch_size, {
      created_by,
      agent_run_id: run.run_id,
    })

    // runSourcing NEVER throws. Every failure path returns a zero-count result carrying an
    // error string, so a caller that only watches for an exception reads a total failure as
    // a successful run of nothing. This is the check that keeps that from happening.
    if (result.error) {
      await run.fail(result.error)
      logger.error('sourcing-entry: sourcing failed', {
        organisation_id,
        run_id: run.run_id,
        error: result.error,
      })
      return { ok: false, error: result.error }
    }

    await run.complete(
      `sourced ${result.candidates_sourced}, written ${result.candidates_qualified}, ` +
      `target ${target_batch_size}`
    )

    logger.info('sourcing-entry: finished', {
      organisation_id,
      run_id: run.run_id,
      candidates_sourced: result.candidates_sourced,
      candidates_qualified: result.candidates_qualified,
    })

    return {
      ok: true,
      candidates_sourced: result.candidates_sourced,
      candidates_qualified: result.candidates_qualified,
      run_timestamp: result.run_timestamp,
      estimated_seconds: Math.round(estimatedSeconds),
      sourcing_run_id: result.sourcing_run_id,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await run.fail(errorMsg)
    logger.error('sourcing-entry: run threw', {
      organisation_id,
      run_id: run.run_id,
      error: errorMsg,
    })
    return { ok: false, error: `Sourcing failed: ${errorMsg}` }
  }
}

/** The start time of a sourcing run still in flight for this organisation, if there is one. */
async function findInFlightRun(
  // ServiceRoleClient: this path writes prospects and reads the dedupe tables.
  supabase: ServiceRoleClient,
  organisation_id: string,
): Promise<string | null> {
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString()

  const { data, error } = await supabase
    .from('agent_runs')
    .select('started_at')
    .eq('organisation_id', organisation_id)
    .eq('agent_name', IN_FLIGHT_AGENT_NAME)
    .eq('status', 'running')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1)

  if (error) {
    logger.warn('sourcing-entry: in-flight check failed, proceeding', {
      organisation_id,
      error: error.message,
    })
    return null
  }

  return data && data.length > 0 ? (data[0].started_at as string) : null
}
