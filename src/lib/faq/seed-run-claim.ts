// The lock around a FAQ seed run.
//
// One seed run costs a real Opus call and writes 5 to 15 pending candidates for an
// operator to curate. Two runs at once would pay twice and double the queue, so the
// claim below is the chokepoint every run passes through.
//
// It is NOT a check-then-act. `faq_seed_runs_one_live_per_org` is a partial unique
// index, so the INSERT either wins the claim or raises 23505. Two requests arriving
// in the same millisecond cannot both win.

import type { SupabaseClient } from '@supabase/supabase-js'

// A run whose route was killed mid-flight (Vercel stops at maxDuration = 300s) leaves a
// 'running' row nothing will ever finish, and that row would lock the organisation out
// of seeding for ever. After this long a live claim is treated as abandoned and taken
// over. 10 minutes matches the threshold reap-agent-runs already uses for the same
// reason, which is a safe margin over the 300s route ceiling.
export const STALE_CLAIM_MS = 10 * 60 * 1000

const UNIQUE_VIOLATION = '23505'

export type SeedRunClaim =
  | { kind: 'claimed'; runId: string; tookOverStaleClaim: boolean }
  | { kind: 'already_running'; startedAt: string | null }

export interface SeedRunOutcome {
  state: 'completed' | 'failed'
  candidatesCreated?: number
  errorMessage?: string
}

/**
 * Take the organisation's seed-run lock, or report who holds it.
 *
 * Returns 'already_running' only when a genuinely live claim exists. A claim older than
 * STALE_CLAIM_MS is taken over instead: the takeover is a single conditional UPDATE, so
 * two requests racing to adopt the same abandoned claim cannot both succeed. Postgres
 * re-checks the WHERE clause against the updated row under READ COMMITTED, and the loser
 * sees `started_at < cutoff` fail and matches nothing.
 */
export async function claimSeedRun(
  supabase: SupabaseClient,
  organisationId: string,
  startedByUserId: string | null,
): Promise<SeedRunClaim> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error: insertError } = await (supabase as any)
    .from('faq_seed_runs')
    .insert({
      organisation_id: organisationId,
      state: 'running',
      started_by_user_id: startedByUserId,
    })
    .select('id')
    .single()

  if (!insertError && inserted) {
    return { kind: 'claimed', runId: inserted.id, tookOverStaleClaim: false }
  }

  // Anything other than the unique index firing is a real database fault, not a busy lock.
  if (!insertError || insertError.code !== UNIQUE_VIOLATION) {
    throw new Error(
      `faq seed run: could not claim the run lock — ${insertError?.message ?? 'insert returned no row'}`,
    )
  }

  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: takenOver, error: takeoverError } = await (supabase as any)
    .from('faq_seed_runs')
    .update({
      started_at: new Date().toISOString(),
      started_by_user_id: startedByUserId,
      error_message: null,
    })
    .eq('organisation_id', organisationId)
    .eq('state', 'running')
    .lt('started_at', cutoff)
    .select('id')

  if (takeoverError) {
    throw new Error(`faq seed run: could not adopt the stale run lock — ${takeoverError.message}`)
  }

  if (Array.isArray(takenOver) && takenOver.length === 1) {
    return { kind: 'claimed', runId: takenOver[0].id, tookOverStaleClaim: true }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: holder } = await (supabase as any)
    .from('faq_seed_runs')
    .select('started_at')
    .eq('organisation_id', organisationId)
    .eq('state', 'running')
    .maybeSingle()

  return { kind: 'already_running', startedAt: holder?.started_at ?? null }
}

/** Close a claim that actually ran, so it stops holding the lock and becomes history. */
export async function releaseSeedRun(
  supabase: SupabaseClient,
  runId: string,
  outcome: SeedRunOutcome,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('faq_seed_runs')
    .update({
      state: outcome.state,
      finished_at: new Date().toISOString(),
      candidates_created: outcome.candidatesCreated ?? null,
      error_message: outcome.errorMessage ?? null,
    })
    .eq('id', runId)

  if (error) {
    // Leaving the row 'running' is recoverable: the stale takeover above frees it after
    // STALE_CLAIM_MS. Losing the whole response over a bookkeeping write is not worth it.
    throw new Error(`faq seed run: could not release the run lock — ${error.message}`)
  }
}

/**
 * Drop a claim that never ran.
 *
 * A request refused before the agent was called spent nothing, so recording it as a run
 * would put a phantom entry in front of the operator under "last run". Deleting the row
 * keeps that line honest: it only ever names runs that actually happened.
 */
export async function abandonSeedRun(supabase: SupabaseClient, runId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from('faq_seed_runs').delete().eq('id', runId)
}
