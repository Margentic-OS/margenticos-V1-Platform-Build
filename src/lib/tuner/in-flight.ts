// The in-flight guard, shared with sourcing.
//
// ─── WHY THE TUNER REGISTERS AT ALL, WHEN IT WRITES NOTHING ──────────────────
//
// The tuner does not write a spec, a document or a prospect, so it cannot corrupt a
// sourcing run's data. What it CAN do is spend the shared resource: both talk to the same
// provider under one account and one rate limit of 600 requests an hour. A sourcing run
// paginating a large batch and a tuner differencing every item of a search can exhaust that
// between them, and the failure lands on whichever one asks next, which will usually be the
// one that did nothing wrong.
//
// So both register under the SAME table with names each other can see, and each refuses
// while the other is in flight.
//
// ─── WHAT THE GUARD IS, PLAINLY, AND WHAT IT LEAVES OPEN ─────────────────────
//
// It is CHECK-THEN-ACT WITH NO LOCK. It reads agent_runs for a running row, and if there is
// none it inserts one. There is no unique constraint, no advisory lock and no transaction
// spanning the two steps: measured on this database, `pg_advisory` appears nowhere at all.
//
// So two requests arriving close enough together both read "nothing running" before either
// inserts, and both proceed. The window is the round trip of the read plus the insert.
//
// WHAT THAT LEAVES OPEN, stated rather than implied:
//
//   - Two tuning runs for one organisation can run concurrently. Neither corrupts the
//     other's record — they are separate rows — but they double the provider calls and can
//     between them reach the rate limit that neither would have hit alone.
//   - A tuning run and a sourcing run can overlap the same way, with the same consequence.
//   - A run whose process dies leaves a 'running' row behind. The existing reaper clears
//     those after ten minutes, and the window below matches it, so a dead run blocks for at
//     most that long rather than forever.
//
// WHAT IT DOES CLOSE is the case that actually happens: an operator clicking twice, or
// clicking tune while a sourcing run they started is still going. Closing the concurrent-
// request race properly needs a unique partial index on (organisation_id) where status =
// 'running', which is a migration on a table sourcing already depends on, and it is not
// this change.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/** The tuner's own name in agent_runs. */
export const TUNER_AGENT_NAME = 'sourcing_tuner'

/**
 * Names that block a tuning run, INCLUDING the tuner's own.
 *
 * ONE LIST, so the two directions cannot disagree. `sourcing_entry` is the name the sourcing
 * path already registers under; adding it here is what makes the two see each other rather
 * than each seeing only itself.
 */
export const BLOCKING_AGENT_NAMES = [TUNER_AGENT_NAME, 'sourcing_entry'] as const

/** Matches the reaper cron, so a dead run blocks for at most this long. */
export const IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000

export interface InFlightRun {
  agentName: string
  startedAt: string
}

/**
 * Is anything running for this organisation that the tuner must wait behind?
 *
 * A FAILED CHECK RETURNS NULL AND THE CALLER PROCEEDS, matching what sourcing already does.
 * That is a deliberate trade and it is worth naming: a database blip disables the guard
 * rather than blocking the operator. It is the right way round here because the guard
 * protects a shared rate limit rather than data integrity, and refusing every run whenever a
 * read fails would be a worse outage than the collision it prevents.
 */
export async function findInFlight(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<InFlightRun | null> {
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString()

  const { data, error } = await supabase
    .from('agent_runs')
    .select('agent_name, started_at')
    .eq('organisation_id', organisationId)
    .in('agent_name', BLOCKING_AGENT_NAMES as unknown as string[])
    .eq('status', 'running')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1)

  if (error) {
    logger.warn('tuner: in-flight check failed, proceeding', {
      organisation_id: organisationId,
      error: error.message,
    })
    return null
  }

  if (!data || data.length === 0) return null
  return { agentName: data[0].agent_name as string, startedAt: data[0].started_at as string }
}

export function describeInFlight(run: InFlightRun): string {
  const what = run.agentName === TUNER_AGENT_NAME ? 'A tuning run' : 'A sourcing run'
  return (
    `${what} for this organisation started at ${run.startedAt} and has not finished. Both talk ` +
    'to the same provider under one rate limit, so running them together can exhaust it for ' +
    'whichever asks next. Wait for it to finish, or wait ten minutes for the reaper to clear ' +
    'it if it has died.'
  )
}

// ─── Registering, which is the other half and was missing ────────────────────
//
// CHECKING IS NOT REGISTERING, and having one without the other is worse than having
// neither, because it reads as a working guard. A tuner that checks `agent_runs` and never
// writes a row can see sourcing, and sourcing cannot see it: the guard is one-directional
// while looking symmetric, and the direction it fails in is the one that spends money —
// sourcing is the path that paginates hard against the shared rate limit.
//
// It uses the CALLER'S client rather than constructing a service client of its own, so the
// whole module is driven by one injected client and a test does not have to reach the
// network to exercise the loop.

export interface TunerRunHandle {
  /** Null when the row could not be written. The run still proceeds; see below. */
  runId: string | null
  complete: (summary: string) => Promise<void>
  fail: (reason: string) => Promise<void>
}

/**
 * Announce this run, so a concurrent sourcing run refuses.
 *
 * FAILS SOFT. A run that could not write its announcement still does its work: this guard
 * protects a shared rate limit rather than data integrity, and refusing to tune because a
 * logging insert failed would be a worse outage than the collision it prevents. The failure
 * is logged and the handle becomes a no-op, which is the same shape startAgentRun uses.
 */
export async function registerTunerRun(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<TunerRunHandle> {
  const noop: TunerRunHandle = { runId: null, complete: async () => {}, fail: async () => {} }

  try {
    const { data, error } = await supabase
      .from('agent_runs')
      .insert({
        organisation_id: organisationId,
        agent_name: TUNER_AGENT_NAME,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error || !data) {
      logger.warn('tuner: could not announce this run; sourcing will not see it', {
        organisation_id: organisationId,
        error: error?.message,
      })
      return noop
    }

    const id = data.id as string
    const close = async (status: 'completed' | 'failed', text: string) => {
      const { error: closeError } = await supabase
        .from('agent_runs')
        .update({
          status,
          completed_at: new Date().toISOString(),
          ...(status === 'completed' ? { output_summary: text } : { error_message: text }),
        })
        .eq('id', id)
      if (closeError) {
        // A row left 'running' blocks this organisation until the reaper clears it, which is
        // ten minutes. Loud, because the symptom is a tuner that refuses for no visible reason.
        logger.error('tuner: could not close the run row; it will block until reaped', {
          run_id: id, error: closeError.message,
        })
      }
    }

    return {
      runId: id,
      complete: (summary: string) => close('completed', summary),
      fail: (reason: string) => close('failed', reason),
    }
  } catch (err) {
    logger.warn('tuner: announcing this run threw; sourcing will not see it', {
      organisation_id: organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return noop
  }
}
