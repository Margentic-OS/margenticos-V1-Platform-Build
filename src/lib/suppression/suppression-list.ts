// src/lib/suppression/suppression-list.ts
//
// The global do-not-contact list: read, write, and revoke.
//
// Backed by the suppressed_emails table (20260821172500_create_suppressed_emails.sql).
// Service-role client only — that table has RLS enabled with zero policies, so an
// authenticated client cannot reach it at all.
//
// This is NOT prospects.suppressed. That column is per-row, per-organisation, and
// already carries four unrelated meanings (client rejection, research disqualification,
// opt-out reply, sourcing dedupe block). Both gates are checked together in
// findBlockedProspects() in ./send-gate.ts, which is the one chokepoint.

import * as Sentry from '@sentry/nextjs'
import { SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'

type SupabaseServiceClient = SupabaseClient<Database>

// The two reasons an address lands on the list. Mirrors the reason CHECK constraint
// in the migration; changing one means changing the other in the same commit.
export type SuppressionReason = 'bounced' | 'unsubscribed'

// Supabase .in() builds a query string, so a batch of thousands would blow the URL
// length limit. Real upload batches are tens of prospects; 200 leaves a wide margin.
const LOOKUP_BATCH_SIZE = 200

// ── Normalisation ─────────────────────────────────────────────────────────────

// Normalisation is load-bearing, not cosmetic. If Bob@X.com and bob@x.com can both
// exist, the same person escapes suppression by capitalisation.
//
// Applied on write AND on every lookup, and backstopped by a CHECK constraint in the
// database so a hand-written INSERT cannot create an un-normalised row either.
//
// Deliberately conservative: lowercase and trim only. No Gmail dot-stripping, no
// plus-address folding. Those are provider-specific guesses, and guessing wrong here
// means suppressing a mailbox that never bounced.
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ── Read ──────────────────────────────────────────────────────────────────────

export type SuppressionLookupResult =
  | { ok: true; suppressed: Set<string> }
  | { ok: false; error: string }

/**
 * THE single query that reads the suppression list.
 *
 * The "suppression is global" policy is hardcoded here and NOWHERE else. Every other
 * caller asks this function and gets an answer; none of them assume what the answer
 * is based on. To narrow the policy later to "bounces global, unsubscribes per-client",
 * change the filter below and pass the sending organisation in. That is a code change
 * to one function, not a migration: reason and source_org_id are already on every row.
 *
 *     .or(`reason.eq.bounced,source_org_id.eq.${sendingOrgId}`)
 *
 * Returns the set of NORMALISED addresses that are currently suppressed. Callers must
 * normalise before comparing against it, or use the helper on the returned set.
 *
 * Fails closed: on a query error this returns ok:false and the caller must abort the
 * send rather than treating an unknown list as an empty one.
 */
export async function lookupSuppressedEmails(
  supabase: SupabaseServiceClient,
  emails: readonly string[]
): Promise<SuppressionLookupResult> {
  const normalised = Array.from(
    new Set(emails.map(normaliseEmail).filter(e => e.length > 0))
  )

  if (normalised.length === 0) return { ok: true, suppressed: new Set() }

  const suppressed = new Set<string>()

  for (let i = 0; i < normalised.length; i += LOOKUP_BATCH_SIZE) {
    const batch = normalised.slice(i, i + LOOKUP_BATCH_SIZE)

    const { data, error } = await supabase
      .from('suppressed_emails')
      .select('email')
      .in('email', batch)
      // A revoked entry stops suppressing. The row stays for history; this filter is
      // what makes revocation take effect.
      .is('revoked_at', null)

    if (error) {
      logger.error('suppression list: lookup failed', {
        batch_size: batch.length,
        error: error.message,
      })
      return { ok: false, error: error.message }
    }

    for (const row of data ?? []) {
      // Rows are stored normalised (CHECK constraint), so no re-normalisation needed.
      if (row.email) suppressed.add(row.email)
    }
  }

  return { ok: true, suppressed }
}

// Convenience for callers holding a raw address and a result set from the above.
// Exists so no call site is tempted to compare an un-normalised address directly.
export function isSuppressed(suppressedSet: ReadonlySet<string>, email: string): boolean {
  return suppressedSet.has(normaliseEmail(email))
}

// ── Write ─────────────────────────────────────────────────────────────────────

export type SuppressionRecordOutcome = 'recorded' | 'already_suppressed' | 'error'

/**
 * Add an address to the list. Idempotent by the partial unique index on
 * (email) WHERE revoked_at IS NULL — the same bounce signal arriving twice returns
 * 'already_suppressed' rather than erroring or duplicating.
 *
 * Note what idempotency does NOT cover, on purpose: if an entry was revoked and the
 * address bounces again, the insert succeeds and creates a NEW active row. The revoked
 * row stays as history. A re-bounce after a revoke should re-suppress.
 */
export async function recordSuppression(
  supabase: SupabaseServiceClient,
  params: {
    email: string
    reason: SuppressionReason
    source_org_id: string | null
    source_signal_id: string | null
  }
): Promise<SuppressionRecordOutcome> {
  const email = normaliseEmail(params.email)

  if (email.length === 0) {
    logger.warn('suppression list: refusing to record a blank address', {
      reason: params.reason,
      source_org_id: params.source_org_id,
    })
    return 'error'
  }

  const { error } = await supabase.from('suppressed_emails').insert({
    email,
    reason: params.reason,
    source_org_id: params.source_org_id,
    source_signal_id: params.source_signal_id,
  })

  if (!error) {
    logger.info('suppression list: address suppressed', {
      reason: params.reason,
      source_org_id: params.source_org_id,
      source_signal_id: params.source_signal_id,
    })
    return 'recorded'
  }

  // Unique violation = the partial index fired = already on the list. Normal, not an error.
  if (error.code === '23505') return 'already_suppressed'

  // Error code in the message so Sentry deduplicates CHECK violations (23514) and FK
  // violations (23503) as distinct issues, matching writeSignal's convention.
  Sentry.captureException(
    new Error(`Suppression write failed [${params.reason}] (${error.code}): ${error.message}`),
    {
      level: 'warning',
      extra: {
        reason: params.reason,
        source_org_id: params.source_org_id,
        source_signal_id: params.source_signal_id,
        code: error.code,
      },
    }
  )
  logger.error('suppression list: failed to record suppression', {
    reason: params.reason,
    source_org_id: params.source_org_id,
    error: error.message,
  })
  return 'error'
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export type SuppressionRevokeResult =
  | { ok: true; revoked: number }
  | { ok: false; error: string }

/**
 * Lift a suppression. Sets revoked_at, never deletes the row: the history stays, so
 * "was this address ever suppressed, and why" always has an answer.
 *
 * revokedReason is required, not optional. A revocation without a stated reason is an
 * unexplained lift of a compliance record, and the database rejects it too
 * (suppressed_emails_revocation_complete).
 *
 * Returns how many active entries were lifted. Zero means the address was not
 * suppressed, which is not an error.
 *
 * Equivalent by hand, if you are working in SQL:
 *
 *   UPDATE suppressed_emails
 *      SET revoked_at = now(), revoked_reason = 'why this is safe to contact again'
 *    WHERE email = lower(btrim('Bob@X.com')) AND revoked_at IS NULL;
 */
export async function revokeSuppression(
  supabase: SupabaseServiceClient,
  email: string,
  revokedReason: string
): Promise<SuppressionRevokeResult> {
  const normalised = normaliseEmail(email)

  if (normalised.length === 0) return { ok: false, error: 'email is blank' }
  if (revokedReason.trim().length === 0) return { ok: false, error: 'revoked_reason is required' }

  const { data, error } = await supabase
    .from('suppressed_emails')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: revokedReason,
    })
    .eq('email', normalised)
    .is('revoked_at', null)
    .select('id')

  if (error) {
    logger.error('suppression list: revoke failed', { error: error.message })
    return { ok: false, error: error.message }
  }

  const revoked = data?.length ?? 0
  logger.info('suppression list: revocation applied', { revoked_count: revoked })
  return { ok: true, revoked }
}
