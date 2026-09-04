// src/lib/suppression/carry.ts
//
// CARRYING A GLOBAL SUPPRESSION OUT TO THE SENDING PROVIDER, DURABLY.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE GAP THIS CLOSES
//
// A suppression that never reaches the provider stops nothing. Before this, the only
// thing that carried a global-list suppression out to the provider was the bounce
// poller, inline, in the loop iteration that detected the bounce.
//
// That made the carry depend on the poller RE-READING the bounced lead: the provider
// still returning it, in a campaign we still have registered, for an organisation we
// have not archived. When any of those stops being true the address sits on the global
// list and nothing carries it, ever. There was no path that said "this address is
// suppressed and was never carried, carry it now."
//
// Measured 2026-09-04, this was the state of the only bounce this system has ever seen:
// on the list since 2026-08-28, never carried, unreachable by any code path, because its
// campaign was unregistered and its organisation archived within the hour of the bounce.
//
// ═════════════════════════════════════════════════════════════════════════════
// ONE OWNER, TWO TRIGGERS
//
// carryOneSuppression is the ONLY place a global-list suppression is carried to the
// provider and the only place the carry columns and the signal's processed flag are
// written. It has two callers:
//
//   the bounce/unsubscribe poller   immediately, for the address it just recorded
//   carryPendingSuppressions        every run, for anything not yet carried
//
// The poller's call is for latency, not correctness. Deleting it would cost up to one
// poll interval and change nothing else, because the sweep would pick the row up.
//
// It replaced a direct suppressAddressAtProvider call in the poller. Keeping both would
// have meant two writers of the same carry state, which is the two-sources-of-truth
// shape CLAUDE.md records four times. The chokepoint argument is the same one
// findBlockedProspects makes for the read side.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS NOT
//
// It is not the instrument. It writes, and something that writes must never be the thing
// that reports on its own writes: a confident write would keep reporting success while
// the sequence ran. The reconciliation sweep asks the PROVIDER, separately, on its own
// cron, and MON-026 reads that. This module records what we DID; that one records what IS.

import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { suppressAddressAtProvider } from './provider-suppression'
import { normaliseEmail } from './suppression-list'

/**
 * A failed carry retries, but not on every run.
 *
 * This database already holds the case that motivates a backoff: a stored provider id of
 * 'mock-lead-0-1780586487684', written into a real prospect row by an upload made while
 * the provider flag was off. An id like that fails identically for ever. Without a
 * backoff the poller would spend a provider call on it every fifteen minutes.
 *
 * An hour is far shorter than the days a campaign step takes, and long enough that a
 * permanently broken row costs 24 calls a day rather than 96.
 */
export const CARRY_RETRY_BACKOFF_MINUTES = 60

/**
 * A ceiling on addresses carried per run, so one sweep cannot run away.
 *
 * Each carry is one address lookup plus a stop-and-read-back per lead found, so this is
 * a larger budget than it looks. Bounces arrive in single digits; 100 is far beyond any
 * real backlog and still bounded.
 */
export const CARRY_MAX_PER_RUN = 100

/** Mirrors the carry_status CHECK in 20260904200000_suppression_carry_columns.sql. */
export type CarryStatus = 'not_required' | 'confirmed' | 'failed'

export interface CarryOutcome {
  status: CarryStatus
  /** Provider leads confirmed stopped. Empty on not_required and on a total failure. */
  stoppedLeadIds: string[]
  /** Populated only when status is 'failed'. Never a silent empty string. */
  error: string | null
  /** True when this carry also cleared the originating signal's processed flag. */
  signalMarkedProcessed: boolean
}

/**
 * Carry ONE address's suppression to the provider, and record what happened.
 *
 * @param organisationId scopes the provider credential lookup, not the search. The global
 *                       list is global by policy and the provider's workspace is shared,
 *                       so an address suppressed under one organisation is stopped
 *                       wherever that workspace holds it.
 *
 * ORDER: the provider is called FIRST, then the row is stamped. If the process dies
 * between the two, the row keeps carry_status NULL and the sweep retries. A retry
 * re-stops leads that are already stopped, which is a no-op PATCH of the same value. The
 * other order would stamp a carry that had not happened, and that is the failure this
 * whole module exists to remove.
 */
export async function carryOneSuppression(
  supabase: ServiceRoleClient,
  params: { email: string; organisationId: string },
): Promise<CarryOutcome> {
  const email = normaliseEmail(params.email)

  if (email.length === 0) {
    return {
      status: 'failed',
      stoppedLeadIds: [],
      error: 'address is blank',
      signalMarkedProcessed: false,
    }
  }

  const result = await suppressAddressAtProvider(supabase, params.organisationId, email)

  // The CHECK constraint refuses a failure with no reason, so never hand it an empty
  // string. A failed carry an operator cannot act on is the same as no record at all.
  const carryError =
    result.status === 'failed'
      ? (result.error && result.error.trim().length > 0
          ? result.error
          : 'the provider call failed and returned no reason')
      : null

  const { data: rows, error } = await supabase
    .from('suppressed_emails')
    .update({
      carry_status: result.status,
      carry_attempted_at: new Date().toISOString(),
      carry_error: carryError,
    })
    .eq('email', email)
    .is('revoked_at', null)
    .select('id, source_signal_id')

  if (error) {
    // The provider may well have been told; we just cannot record it. Loud, because the
    // row stays NULL and will be retried, and a silent retry loop that keeps succeeding
    // at the provider while failing here would look like a provider problem.
    logger.error('suppression carry: the provider outcome could not be recorded', {
      organisation_id: params.organisationId,
      provider_status: result.status,
      error: error.message,
    })
    Sentry.captureException(
      new Error(`Suppression carry outcome not recorded (${result.status}): ${error.message}`),
      { level: 'warning', extra: { organisation_id: params.organisationId } },
    )
    return { ...result, signalMarkedProcessed: false }
  }

  if (result.status === 'failed') {
    logger.error('suppression carry: the provider was not told about a suppressed address', {
      organisation_id: params.organisationId,
      stopped: result.stoppedLeadIds.length,
      error: carryError,
    })
    return { ...result, error: carryError, signalMarkedProcessed: false }
  }

  // ── The originating signal is now genuinely handled ────────────────────────
  //
  // processed is stamped HERE and only here for bounce and unsubscribe signals, and only
  // once BOTH halves are done: the address is on the global list, and the provider has
  // been told (or holds nothing to tell). That is the same meaning the reply branch's
  // markSignalProcessed carries, which is the point — a column that means different
  // things per signal type is the next confusion, and this is the one flag an operator
  // reads to decide whether anything is stuck.
  //
  // LIMIT, STATED RATHER THAN HIDDEN: source_signal_id is nullable. writeSignal cannot
  // return an id when the idempotency constraint fires, so a suppression first recorded
  // against an already-present signal has no link back. Those signals keep
  // processed = false. It is a reporting gap, not an enforcement gap: the carry columns
  // above are what the monitor reads.
  const signalIds = (rows ?? [])
    .map(r => r.source_signal_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  let signalMarkedProcessed = false

  for (const signalId of signalIds) {
    const { error: signalError } = await supabase
      .from('signals')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', signalId)
      .eq('processed', false)

    if (signalError) {
      logger.error('suppression carry: failed to mark the originating signal processed', {
        signal_id: signalId,
        error: signalError.message,
      })
      continue
    }
    signalMarkedProcessed = true
  }

  logger.info('suppression carry: address carried to the provider', {
    organisation_id: params.organisationId,
    status: result.status,
    stopped_lead_count: result.stoppedLeadIds.length,
    signal_marked_processed: signalMarkedProcessed,
  })

  return { ...result, error: null, signalMarkedProcessed }
}

export interface CarryVerdict {
  /** Active, unrevoked suppressions. The denominator: a bare zero below is not a pass. */
  activeCount: number
  /** Of those, how many still needed carrying when this run started. */
  pendingCount: number
  /** Carried this run to a non-failed outcome. */
  carriedCount: number
  /** Attempted this run and failed. Retried after the backoff. */
  failedCount: number
  /** Skipped: no organisation context, so provider credentials cannot be resolved. */
  noOrgCount: number
  /** Skipped: a previous failure is still inside the retry backoff. */
  backoffCount: number
  /** True when the run did not cover its whole backlog, so no count is a total. */
  incomplete: boolean
  detail: string
}

interface PendingRow {
  id: string
  email: string
  source_org_id: string | null
  carry_status: string | null
  carry_attempted_at: string | null
}

/**
 * Carry every suppression that has not reached the provider yet.
 *
 * Idempotent and safe to repeat: a confirmed row is never selected again, and re-stopping
 * an already-stopped lead is a no-op at the provider.
 */
export async function carryPendingSuppressions(
  supabase: ServiceRoleClient,
): Promise<CarryVerdict> {
  const empty = {
    activeCount: 0,
    pendingCount: 0,
    carriedCount: 0,
    failedCount: 0,
    noOrgCount: 0,
    backoffCount: 0,
  }

  const { count: activeCount, error: countError } = await supabase
    .from('suppressed_emails')
    .select('id', { count: 'exact', head: true })
    .is('revoked_at', null)

  if (countError) {
    return {
      ...empty,
      incomplete: true,
      detail:
        `Could not carry suppressions: the active list could not be counted ` +
        `(${countError.message}). No count here is a statement about the provider.`,
    }
  }

  const { data, error } = await supabase
    .from('suppressed_emails')
    .select('id, email, source_org_id, carry_status, carry_attempted_at')
    .is('revoked_at', null)
    // NULL (never attempted) or a previous failure. A confirmed or not_required row is
    // done and is deliberately never re-read.
    .or('carry_status.is.null,carry_status.eq.failed')
    // Oldest attempt first, and nulls first, so a never-attempted row always outranks a
    // row that has already had a go.
    .order('carry_attempted_at', { ascending: true, nullsFirst: true })
    .limit(CARRY_MAX_PER_RUN + 1)

  if (error) {
    return {
      ...empty,
      activeCount: activeCount ?? 0,
      incomplete: true,
      detail:
        `Could not carry suppressions: the pending list could not be read ` +
        `(${error.message}). No count here is a statement about the provider.`,
    }
  }

  const all = (data ?? []) as PendingRow[]
  // One more than the cap was requested precisely so this can be known rather than
  // guessed. A run that silently stops at its ceiling reads as "covered everything".
  const hitCap = all.length > CARRY_MAX_PER_RUN
  const rows = all.slice(0, CARRY_MAX_PER_RUN)

  const now = Date.now()
  const backoffMs = CARRY_RETRY_BACKOFF_MINUTES * 60_000

  let carried = 0
  let failed = 0
  let noOrg = 0
  let backoff = 0

  for (const row of rows) {
    if (row.carry_status === 'failed' && row.carry_attempted_at) {
      const at = Date.parse(row.carry_attempted_at)
      if (!Number.isNaN(at) && now - at < backoffMs) {
        backoff++
        continue
      }
    }

    const organisationId = row.source_org_id ?? (await resolveOrgForAddress(supabase, row.email))

    if (!organisationId) {
      // Fails closed and says so, rather than guessing an organisation. Reachable by
      // design: source_org_id is ON DELETE SET NULL so that a suppression outlives the
      // organisation that found it, which is correct and leaves exactly this case.
      noOrg++
      logger.error('suppression carry: no organisation context for a suppressed address', {
        suppressed_email_id: row.id,
        consequence:
          'provider credentials cannot be resolved, so this address cannot be carried',
      })
      continue
    }

    const outcome = await carryOneSuppression(supabase, { email: row.email, organisationId })
    if (outcome.status === 'failed') failed++
    else carried++
  }

  const pendingCount = rows.length

  return {
    activeCount: activeCount ?? 0,
    pendingCount,
    carriedCount: carried,
    failedCount: failed,
    noOrgCount: noOrg,
    backoffCount: backoff,
    incomplete: hitCap,
    detail: buildCarryDetail({
      activeCount: activeCount ?? 0,
      pendingCount,
      carriedCount: carried,
      failedCount: failed,
      noOrgCount: noOrg,
      backoffCount: backoff,
      incomplete: hitCap,
      detail: '',
    }),
  }
}

/**
 * Last resort when a suppression row has lost its organisation.
 *
 * Any prospect row carrying this address will do: organisationId scopes only the
 * credential lookup, and the provider workspace is shared. Returns null rather than
 * guessing when nothing matches.
 */
async function resolveOrgForAddress(
  supabase: ServiceRoleClient,
  email: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('prospects')
    .select('organisation_id')
    .eq('email', email)
    .limit(1)

  if (error || !data || data.length === 0) return null
  return data[0].organisation_id ?? null
}

/** The sentence an operator reads. Always carries the denominator. */
function buildCarryDetail(v: CarryVerdict): string {
  const parts: string[] = []

  if (v.failedCount > 0) {
    parts.push(
      `${v.failedCount} suppressed address(es) could not be carried to the sending ` +
      `provider, so mail to them may still be in flight.`,
    )
  }

  if (v.noOrgCount > 0) {
    parts.push(
      `${v.noOrgCount} suppressed address(es) have no organisation context, so provider ` +
      `credentials cannot be resolved and they cannot be carried at all.`,
    )
  }

  if (v.carriedCount > 0) {
    parts.push(`${v.carriedCount} suppressed address(es) carried to the provider.`)
  }

  if (parts.length === 0) {
    parts.push(
      v.pendingCount === 0
        ? `Nothing to carry: all ${v.activeCount} active suppression(s) have already ` +
          `reached the provider.`
        : `${v.pendingCount} pending of ${v.activeCount} active suppression(s), none ` +
          `actioned this run.`,
    )
  }

  if (v.backoffCount > 0) {
    parts.push(
      `${v.backoffCount} previously failed and are inside the ` +
      `${CARRY_RETRY_BACKOFF_MINUTES}-minute retry backoff.`,
    )
  }

  if (v.incomplete) {
    parts.push(
      `The per-run ceiling of ${CARRY_MAX_PER_RUN} was reached, so this run did not cover ` +
      `the whole backlog and the counts above are a floor, not a total.`,
    )
  }

  return parts.join(' ')
}
