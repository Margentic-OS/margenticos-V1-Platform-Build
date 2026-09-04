// src/lib/suppression/provider-suppression.ts
//
// THE ONE PLACE a suppression in this system is carried out to the sending provider.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE GAP THIS CLOSES
//
// Marking a prospect suppressed changed nothing about what the provider had already
// queued. Measured live on 2026-09-04: a prospect uploaded 2026-08-21 and suppressed in
// our database was still Active at the provider, had been sent email 3 on 2026-08-31, and
// had email 4 queued behind a seven-day delay.
//
// Three of the four suppression write sites made no provider call at all. The fourth, the
// opt-out reply path, did, and its prospects are correctly stopped. So this is not a new
// mechanism; it is the existing one, moved behind a capability and made to run on every
// path instead of one.
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO ENTRY POINTS, BECAUSE THERE ARE TWO SUPPRESSION STORES
//
//   prospects.suppressed   per row, per organisation, and the row already carries a
//                          provider lead id from upload. Four distinct meanings write it:
//                          client rejection, research disqualification, opt-out reply, and
//                          a hand-written UPDATE.
//   suppressed_emails      global, cross-client, keyed by ADDRESS ONLY. Written by the
//                          bounce and unsubscribe poller. No lead id exists, so the
//                          provider has to be asked which leads it holds for the address.
//
// Covering only one leaves half of suppression one-way. The bounce half looks redundant
// (the provider told US about the bounce, so it stopped its own lead) and stops being
// redundant the moment the same address is a lead in a second client's campaign, because
// that list is global and the provider's stop was per lead.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT 'confirmed' MEANS, AND WHAT IT DOES NOT
//
// confirmed = the provider was called AND the lead was read back carrying the value we
// wrote. A 200 alone never earns it.
//
// It does NOT mean the sequence has stopped. Only the provider can settle that, and the
// reconciliation sweep is what asks. This module records what WE did; the sweep records
// what IS. Keeping those separate is the point: if they were the same instrument, a
// confident write would keep reporting success while the sequence ran.

import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import {
  resolveSuppressContactHandler,
  type SuppressContactHandler,
} from '@/lib/integrations/capabilities/suppress-contact'
import { normaliseEmail } from './suppression-list'

/**
 * The three values prospects.outbound_suppression_status may hold, mirroring the CHECK
 * constraint in 20260904100000_provider_suppression_columns.sql. Changing one means
 * changing the other in the same commit.
 */
export const OUTBOUND_SUPPRESSION_STATUSES = ['not_required', 'confirmed', 'failed'] as const
export type OutboundSuppressionStatus = (typeof OUTBOUND_SUPPRESSION_STATUSES)[number]

export interface ProviderSuppressionResult {
  status: OutboundSuppressionStatus
  /** Provider leads confirmed stopped. Empty on not_required, and on a total failure. */
  stoppedLeadIds: string[]
  /** Populated only when status is 'failed'. Never a silent empty string. */
  error: string | null
}

/** A prospect, in the shape this module needs. Deliberately not the whole row. */
export interface SuppressionSubject {
  id: string
  organisation_id: string
  email: string | null
  outbound_lead_id: string | null
}

function failure(error: string): ProviderSuppressionResult {
  return { status: 'failed', stoppedLeadIds: [], error }
}

/**
 * Stop a set of provider leads, and fold the outcomes into one verdict.
 *
 * ALL of them must succeed. A partial success is recorded as a failure, carrying which
 * ones stopped and which did not, because "some of this person's leads were stopped" is
 * not a state anybody can act on and reporting it as success is how the address fallback
 * used to leave duplicates sending.
 */
async function stopAll(
  handler: SuppressContactHandler,
  leadIds: readonly string[],
  organisationId: string,
): Promise<ProviderSuppressionResult> {
  if (leadIds.length === 0) {
    return { status: 'not_required', stoppedLeadIds: [], error: null }
  }

  const stopped: string[] = []
  const failures: string[] = []

  for (const leadId of leadIds) {
    const outcome = await handler.stopLead(leadId, organisationId)
    if (outcome.ok) stopped.push(leadId)
    else failures.push(`${leadId}: ${outcome.error}`)
  }

  if (failures.length > 0) {
    return {
      status: 'failed',
      stoppedLeadIds: stopped,
      error:
        `${failures.length} of ${leadIds.length} provider lead(s) were not stopped. ` +
        failures.join(' | '),
    }
  }

  return { status: 'confirmed', stoppedLeadIds: stopped, error: null }
}

/**
 * Every provider lead for this prospect: the one recorded at upload, plus every other lead
 * the provider holds for the same address.
 *
 * BOTH, not either. The stored id is the authoritative one for the campaign we uploaded
 * into, and the address sweep is what catches a duplicate created outside our uploads. An
 * opt-out that stops one of a person's two leads is not an honoured opt-out.
 *
 * An address lookup FAILURE is propagated, never swallowed. "We could not ask" and "there
 * are no others" are different answers and only one of them is safe to record as success.
 */
async function collectLeadIds(
  handler: SuppressContactHandler,
  subject: SuppressionSubject,
): Promise<{ ok: true; leadIds: string[] } | { ok: false; error: string }> {
  const ids = new Set<string>()
  if (subject.outbound_lead_id) ids.add(subject.outbound_lead_id)

  const email = subject.email ? normaliseEmail(subject.email) : ''

  if (email.length === 0) {
    // No address to sweep. The stored id, if any, is all there is.
    return { ok: true, leadIds: [...ids] }
  }

  const found = await handler.findLeadIds(email, subject.organisation_id)
  if (!found.ok) return { ok: false, error: `address lookup failed: ${found.error}` }

  for (const id of found.leadIds) ids.add(id)
  return { ok: true, leadIds: [...ids] }
}

/**
 * Write the outcome onto the prospect row.
 *
 * Separate from the call so that a failed DB write cannot be mistaken for a failed provider
 * call, and so the caller's own suppression UPDATE and this one never race for the same
 * fields. The suppression columns are written here and nowhere else.
 */
async function recordOutcome(
  supabase: ServiceRoleClient,
  prospectId: string,
  organisationId: string,
  result: ProviderSuppressionResult,
): Promise<void> {
  const { error } = await supabase
    .from('prospects')
    .update({
      outbound_suppression_status: result.status,
      outbound_suppression_at: new Date().toISOString(),
      // The CHECK constraint allows an error only on a failed row, so this must be null on
      // every other status rather than an empty string.
      outbound_suppression_error: result.status === 'failed' ? (result.error ?? 'unknown').slice(0, 1000) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (error) {
    // Loud. If this write fails the row claims suppressed with no statement about the
    // provider, which is exactly the silent state these columns exist to remove.
    logger.error('provider suppression: failed to record the outcome on the prospect', {
      prospect_id: prospectId,
      organisation_id: organisationId,
      outcome: result.status,
      error: error.message,
    })
    Sentry.captureException(
      new Error(`Provider suppression outcome not recorded (${result.status}): ${error.message}`),
      { level: 'warning', extra: { prospect_id: prospectId, organisation_id: organisationId } },
    )
  }
}

/**
 * Carry a prospect's suppression out to the sending provider, and record whether it landed.
 *
 * Never throws for an ordinary provider failure: it returns status 'failed' with a reason,
 * writes that reason to the row, and lets the caller decide what to do. A suppression whose
 * database half succeeded is still worth keeping.
 *
 * Call this AFTER writing prospects.suppressed. If the provider call is made first and the
 * database write then fails, the person is stopped at the provider while our record says
 * they may be mailed, which is the failure in the safe direction but still a disagreement.
 */
export async function suppressProspectAtProvider(
  supabase: ServiceRoleClient,
  subject: SuppressionSubject,
): Promise<ProviderSuppressionResult> {
  // The resolve is inside a try for the same reason the calls below are: a database client
  // that THROWS rather than returning an error must become a recorded failure here, not an
  // exception escaping into whatever suppression path called this. An escaping throw would
  // abandon the caller's own bookkeeping half-done, and the caller has already written the
  // database suppression by the time it gets here.
  let resolved: Awaited<ReturnType<typeof resolveSuppressContactHandler>>
  try {
    resolved = await resolveSuppressContactHandler(supabase)
  } catch (err) {
    resolved = { ok: false, error: `capability resolution threw: ${String(err)}` }
  }

  if (!resolved.ok) {
    const result = failure(resolved.error)
    await recordOutcome(supabase, subject.id, subject.organisation_id, result)
    return result
  }

  let leadIds: string[]
  try {
    const collected = await collectLeadIds(resolved.handler, subject)
    if (!collected.ok) {
      const result = failure(collected.error)
      await recordOutcome(supabase, subject.id, subject.organisation_id, result)
      return result
    }
    leadIds = collected.leadIds
  } catch (err) {
    // The handlers throw on a flag misconfiguration. That is a real failure and must not
    // become an exception that escapes a suppression path and abandons the DB write.
    const result = failure(`provider lookup threw: ${String(err)}`)
    await recordOutcome(supabase, subject.id, subject.organisation_id, result)
    return result
  }

  let result: ProviderSuppressionResult
  try {
    result = await stopAll(resolved.handler, leadIds, subject.organisation_id)
  } catch (err) {
    result = failure(`provider suppression threw: ${String(err)}`)
  }

  if (result.status === 'failed') {
    logger.error('provider suppression: the provider was not told', {
      prospect_id: subject.id,
      organisation_id: subject.organisation_id,
      stopped: result.stoppedLeadIds.length,
      error: result.error,
    })
    Sentry.captureException(
      new Error(`Provider suppression failed for prospect ${subject.id}: ${result.error}`),
      { level: 'warning', extra: { prospect_id: subject.id, organisation_id: subject.organisation_id } },
    )
  }

  await recordOutcome(supabase, subject.id, subject.organisation_id, result)
  return result
}

/**
 * Carry an ADDRESS suppression out to the provider. The entry point for the global list.
 *
 * There is no lead id here and there may be no prospect row at all, so every lead is found
 * by address. Where prospect rows for that address do exist, each one's outcome columns are
 * written too, so the two stores leave the same evidence behind.
 *
 * organisationId scopes the credential lookup, not the search. The global list is global
 * on purpose (see suppression-list.ts) and the provider's workspace is shared, so an
 * address suppressed for one organisation is stopped wherever that workspace holds it.
 */
export async function suppressAddressAtProvider(
  supabase: ServiceRoleClient,
  organisationId: string,
  email: string,
): Promise<ProviderSuppressionResult> {
  const normalised = normaliseEmail(email)

  if (normalised.length === 0) return failure('address is blank')

  // Inside a try for the same reason as the prospect path above.
  let resolved: Awaited<ReturnType<typeof resolveSuppressContactHandler>>
  try {
    resolved = await resolveSuppressContactHandler(supabase)
  } catch (err) {
    resolved = { ok: false, error: `capability resolution threw: ${String(err)}` }
  }
  if (!resolved.ok) return failure(resolved.error)
  const handler = resolved.handler

  let result: ProviderSuppressionResult
  try {
    const found = await handler.findLeadIds(normalised, organisationId)
    result = found.ok
      ? await stopAll(handler, found.leadIds, organisationId)
      : failure(`address lookup failed: ${found.error}`)
  } catch (err) {
    result = failure(`provider suppression threw: ${String(err)}`)
  }

  if (result.status === 'failed') {
    logger.error('provider suppression: the provider was not told about a suppressed address', {
      organisation_id: organisationId,
      stopped: result.stoppedLeadIds.length,
      error: result.error,
    })
    Sentry.captureException(
      new Error(`Provider suppression failed for a suppressed address: ${result.error}`),
      { level: 'warning', extra: { organisation_id: organisationId } },
    )
  }

  // Leave the same evidence on any prospect rows carrying this address, so a reader looking
  // at a prospect never has to know which store suppressed it. Address matching is correct
  // here and only here: the global store has no other key.
  //
  // AN EXACT MATCH, and the limit is deliberate. prospects.email has no normalising CHECK
  // constraint (suppressed_emails does), so a row stored in mixed case would be missed. All
  // 137 addresses are normalised today, measured 2026-09-04. The alternative, a
  // case-insensitive LIKE, treats the underscore in an address as a wildcard and can match
  // a DIFFERENT prospect, and suppressing the wrong person is far worse than missing a
  // diagnostic column. Under-matching is the safe direction here because these columns are
  // evidence, not enforcement: the leads were found and stopped by address at the provider
  // above, and the reconciliation sweep reads the provider rather than this column.
  try {
    const { data: rows, error } = await supabase
      .from('prospects')
      .select('id, organisation_id')
      .eq('email', normalised)

    if (error) {
      logger.warn('provider suppression: could not find prospect rows for a suppressed address', {
        organisation_id: organisationId,
        error: error.message,
      })
      return result
    }

    for (const row of rows ?? []) {
      await recordOutcome(supabase, row.id, row.organisation_id, result)
    }
  } catch (err) {
    // Evidence, not enforcement. The leads were already found and stopped above, so failing
    // to annotate the prospect rows must not turn a successful suppression into a thrown
    // error in the bounce poller that called it.
    logger.warn('provider suppression: could not annotate prospect rows for a suppressed address', {
      organisation_id: organisationId,
      error: String(err),
    })
  }

  return result
}
