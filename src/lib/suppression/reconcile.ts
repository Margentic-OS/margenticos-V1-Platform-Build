// src/lib/suppression/reconcile.ts
//
// THE HALF THAT MATTERS.
//
// Reads the sending provider's own answer for every prospect our database says must not be
// mailed, and reports anyone the provider is still sending to.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL
//
// The failure on 2026-09-04 was not a missing API call. It was that NOTHING WOULD HAVE SAID
// SO. A prospect uploaded 2026-08-21 and suppressed in our database was Active at the
// provider, had been sent email 3, and had email 4 queued, and every instrument in the
// platform read green.
//
// Fixing the write paths cannot close that, because two of the four suppression write sites
// are code and the one that actually bit was a HAND-WRITTEN UPDATE. No amount of care on a
// code path catches a person typing UPDATE prospects SET suppressed = true. Neither does
// outbound_suppression_status: a hand UPDATE leaves it NULL, and trusting our own columns to
// audit our own writes is the shape CLAUDE.md names repeatedly, where a check reports
// success about a thing it never reached.
//
// So this sweep does not read our suppression columns to decide anything. It asks the
// PROVIDER, per lead, and compares the answer against the send gate.
//
// ═════════════════════════════════════════════════════════════════════════════
// IT REUSES THE SEND GATE RATHER THAN RESTATING IT
//
// "Who must not be mailed" is defined in exactly one place, findBlockedProspects, which
// checks prospects.suppressed, client_review_status and the global suppressed_emails list
// together. This sweep calls it.
//
// Writing the predicate again here would create a second definition of suppression that
// could drift from the first, and a reconciliation check that disagrees with the gate it
// is auditing is worse than none: it would go green over exactly the prospects the gate
// blocks and the sweep forgot.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SETTLE WINDOW
//
// The provider applies a suppression asynchronously. Measured 2026-09-04: the lead carried
// our write immediately and did not move to Completed for about 43 seconds, reading Active
// the whole time.
//
// Without a settle window this sweep would report every freshly suppressed prospect as
// still sending, the monitor would flicker red on normal operation, and an alarm that cries
// wolf is an alarm that gets ignored on the day it matters. Ten minutes is far beyond the
// measured lag and far inside the sweep's own cadence.
//
// A prospect whose outbound_suppression_at is NULL is NEVER inside the window, because there
// is nothing settling: nobody told the provider at all. That is exactly the hand-UPDATE case
// and it must never be skipped.

import { logger } from '@/lib/logger'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import {
  resolveSuppressContactHandler,
  isStillSending,
  type SuppressContactHandler,
} from '@/lib/integrations/capabilities/suppress-contact'
import { findBlockedProspects } from './send-gate'

/** Beyond the measured provider lag, well inside the sweep cadence. See the header. */
export const SETTLE_WINDOW_MINUTES = 10

/** A ceiling on provider reads per run, so one sweep cannot run away. */
export const MAX_LEADS_PER_RUN = 500

export interface ReconciliationVerdict {
  /** Every prospect the provider could still hold. The non-vacuity denominator. */
  uploadedCount: number
  /** Of those, how many the send gate says must not be mailed. */
  blockedCount: number
  /** Blocked prospects whose provider lead was actually read back this run. */
  checkedCount: number
  /** Blocked prospects the provider says it is STILL SENDING to. Expect zero. */
  unreconciledCount: number
  /** Blocked prospects whose provider lead could not be read. Not a pass. */
  unreachableCount: number
  /** Skipped because their suppression is still settling at the provider. */
  settlingCount: number
  /** Uploaded prospects with no provider lead id. The invariant, asserted not assumed. */
  invariantBreachCount: number
  /** Identifiers for the operator, capped so the detail line stays readable. */
  unreconciledProspectIds: string[]
  /** True when the sweep could not complete, so no count below it can be trusted. */
  incomplete: boolean
  detail: string
}

interface Candidate {
  id: string
  organisation_id: string
  email: string | null
  outbound_lead_id: string | null
  outbound_suppression_at: string | null
}

const MAX_IDS_IN_DETAIL = 10

/**
 * Every prospect the provider might still hold, per organisation.
 *
 * Keyed on outbound_upload_status rather than on the lead id, deliberately. A row that says
 * uploaded and carries no lead id is the invariant breach this sweep has to be able to
 * report, and selecting on the lead id would filter that row out and report zero for ever.
 */
async function loadUploadedProspects(
  supabase: ServiceRoleClient,
): Promise<{ ok: true; rows: Candidate[] } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, organisation_id, email, outbound_lead_id, outbound_suppression_at')
    .eq('outbound_upload_status', 'uploaded')

  if (error) return { ok: false, error: `could not read uploaded prospects: ${error.message}` }
  return { ok: true, rows: (data ?? []) as Candidate[] }
}

function isSettling(row: Candidate, now: number): boolean {
  // NULL is never settling. Nothing was ever sent to the provider, so there is nothing in
  // flight to wait for, and this is precisely the hand-UPDATE case.
  if (!row.outbound_suppression_at) return false
  const at = Date.parse(row.outbound_suppression_at)
  if (Number.isNaN(at)) return false
  return now - at < SETTLE_WINDOW_MINUTES * 60_000
}

/**
 * Compare our must-not-mail set against the provider's live state.
 *
 * Never throws for a provider failure: an unreadable lead is counted as unreachable and the
 * verdict says so. Unreachable is NOT a pass, because "we could not tell" and "it is fine"
 * are different answers and only one of them is safe to render green.
 */
export async function reconcileSuppression(
  supabase: ServiceRoleClient,
): Promise<ReconciliationVerdict> {
  const empty = {
    uploadedCount: 0,
    blockedCount: 0,
    checkedCount: 0,
    unreconciledCount: 0,
    unreachableCount: 0,
    settlingCount: 0,
    invariantBreachCount: 0,
    unreconciledProspectIds: [] as string[],
  }

  const resolved = await resolveSuppressContactHandler(supabase)
  if (!resolved.ok) {
    return {
      ...empty,
      incomplete: true,
      detail:
        `Could not reconcile: no usable suppression capability. ${resolved.error}. ` +
        `No count here is a statement about the provider.`,
    }
  }

  const loaded = await loadUploadedProspects(supabase)
  if (!loaded.ok) {
    return {
      ...empty,
      incomplete: true,
      detail: `Could not reconcile: ${loaded.error}. No count here is a statement about the provider.`,
    }
  }

  const uploaded = loaded.rows
  const uploadedCount = uploaded.length

  // THE INVARIANT, ASSERTED RATHER THAN ASSUMED.
  //
  // uploaded implies outbound_lead_id present. It held on all 26 rows on 2026-09-04, and it
  // holds because the upload handler marks a prospect 'failed' rather than 'uploaded' when
  // the provider does not return a created lead. If it ever stops holding, this sweep loses
  // its handle on those prospects and would otherwise report zero unreconciled while being
  // structurally unable to check them.
  const invariantBreaches = uploaded.filter(r => !r.outbound_lead_id)

  // ── Who must not be mailed, per organisation, via the ONE chokepoint ────────
  const byOrg = new Map<string, Candidate[]>()
  for (const row of uploaded) {
    const list = byOrg.get(row.organisation_id) ?? []
    list.push(row)
    byOrg.set(row.organisation_id, list)
  }

  const blocked: Candidate[] = []

  for (const [orgId, rows] of byOrg) {
    const gate = await findBlockedProspects(
      supabase,
      orgId,
      rows.map(r => ({ id: r.id, email: r.email })),
    )

    if (!gate.ok) {
      // The gate fails closed and so does this. An unknown must-not-mail set cannot be
      // compared against anything, and reporting zero unreconciled from it would be a
      // green light derived from a failure.
      return {
        ...empty,
        uploadedCount,
        invariantBreachCount: invariantBreaches.length,
        incomplete: true,
        detail:
          `Could not reconcile: the send gate failed for one organisation (${gate.error}). ` +
          `No count here is a statement about the provider.`,
      }
    }

    for (const row of rows) if (gate.blocked.has(row.id)) blocked.push(row)
  }

  // ── Ask the provider ───────────────────────────────────────────────────────
  const now = Date.now()
  let checked = 0
  let unreachable = 0
  let settling = 0
  const stillSending: string[] = []
  let hitCap = false

  for (const row of blocked) {
    if (isSettling(row, now)) {
      settling++
      continue
    }

    if (!row.outbound_lead_id) {
      // Blocked, uploaded, and no lead id: already counted as an invariant breach above.
      // Not counted as unreachable too, or one row would be reported twice.
      continue
    }

    if (checked + unreachable >= MAX_LEADS_PER_RUN) {
      hitCap = true
      break
    }

    let verdict: LeadVerdict
    try {
      verdict = await judgeProspect(resolved.handler, row)
    } catch (err) {
      unreachable++
      logger.error('suppression reconcile: provider read threw', {
        prospect_id: row.id,
        error: String(err),
      })
      continue
    }

    if (verdict.kind === 'unreachable') {
      unreachable++
      logger.error('suppression reconcile: could not establish whether a suppressed prospect is still being sent to', {
        prospect_id: row.id,
        organisation_id: row.organisation_id,
        error: verdict.error,
      })
      continue
    }

    checked++

    if (verdict.kind === 'sending') {
      stillSending.push(row.id)
      logger.error('suppression reconcile: our record says do not mail and the provider is still sending', {
        prospect_id: row.id,
        organisation_id: row.organisation_id,
        provider_status: verdict.status,
      })
    }
  }

  const detail = buildDetail({
    uploadedCount,
    blockedCount: blocked.length,
    checkedCount: checked,
    unreconciledCount: stillSending.length,
    unreachableCount: unreachable,
    settlingCount: settling,
    invariantBreachCount: invariantBreaches.length,
    unreconciledProspectIds: stillSending.slice(0, MAX_IDS_IN_DETAIL),
    incomplete: hitCap,
    detail: '',
  }, hitCap)

  return {
    uploadedCount,
    blockedCount: blocked.length,
    checkedCount: checked,
    unreconciledCount: stillSending.length,
    unreachableCount: unreachable,
    settlingCount: settling,
    invariantBreachCount: invariantBreaches.length,
    unreconciledProspectIds: stillSending.slice(0, MAX_IDS_IN_DETAIL),
    incomplete: hitCap,
    detail,
  }
}

type LeadVerdict =
  | { kind: 'sending'; status: number | null }
  | { kind: 'stopped' }
  | { kind: 'unreachable'; error: string }

/**
 * Is the provider still sending to this prospect?
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THE STORED LEAD ID IS NOT THE END OF THE QUESTION
 *
 * The first version of this read the stored outbound_lead_id and counted any failure as
 * unreachable. Run against live data it reported 2 unreachable out of 6, and NEITHER was a
 * provider that could not be reached:
 *
 *   404  the lead was deleted along with its campaign, deliberately, in August. There is no
 *        lead, so nothing can be sent to it.
 *   400  the stored id was 'mock-lead-0-1780586487684'. A MOCK id, written into a real
 *        prospect row by an upload made while the provider flag was off. It is not a valid
 *        id and never will be, so re-reading it will fail identically for ever.
 *
 * Both would have left MON-026 permanently red on artefacts, which teaches an operator to
 * ignore the board, and neither told us the thing the sweep is for.
 *
 * THE ID IS A SHORTCUT, THE ADDRESS IS THE QUESTION. So when the stored id does not answer,
 * this asks the provider what it holds for the ADDRESS. That is the same lookup the
 * suppression path itself uses, and it is authoritative in a way a stored id is not: a
 * provider holding no lead for an address cannot be sending to it, whatever our column says.
 *
 * Only when the address lookup ALSO fails is this unreachable, and then it genuinely is:
 * two independent questions both went unanswered.
 */
async function judgeProspect(
  handler: SuppressContactHandler,
  row: Candidate,
): Promise<LeadVerdict> {
  let firstError: string | null = null

  if (row.outbound_lead_id) {
    const direct = await handler.readLead(row.outbound_lead_id, row.organisation_id)
    if (direct.ok) {
      return isStillSending(direct.state)
        ? { kind: 'sending', status: direct.state.status }
        : { kind: 'stopped' }
    }
    firstError = direct.error
  }

  const email = row.email?.trim().toLowerCase() ?? ''
  if (email.length === 0) {
    return { kind: 'unreachable', error: firstError ?? 'no provider lead id and no address' }
  }

  const found = await handler.findLeadIds(email, row.organisation_id)
  if (!found.ok) {
    return {
      kind: 'unreachable',
      error: `${firstError ? firstError + '; ' : ''}address lookup also failed: ${found.error}`,
    }
  }

  // The provider holds nothing for this address. It cannot be sending to them.
  if (found.leadIds.length === 0) return { kind: 'stopped' }

  // EVERY lead, not the first. One stopped lead beside one running lead is not stopped, and
  // this is the same duplicate case the suppression path exists to handle.
  for (const leadId of found.leadIds) {
    const state = await handler.readLead(leadId, row.organisation_id)
    if (!state.ok) {
      return {
        kind: 'unreachable',
        error: `${firstError ? firstError + '; ' : ''}lead ${leadId} could not be read: ${state.error}`,
      }
    }
    if (isStillSending(state.state)) return { kind: 'sending', status: state.state.status }
  }

  return { kind: 'stopped' }
}

/**
 * The sentence an operator reads.
 *
 * Always carries the denominator. A bare "0 unreconciled" is indistinguishable from a sweep
 * that examined nothing, which is the reading this codebase has been misled by before.
 */
function buildDetail(v: ReconciliationVerdict, hitCap: boolean): string {
  const parts: string[] = []

  if (v.unreconciledCount > 0) {
    parts.push(
      `${v.unreconciledCount} prospect(s) our database says must not be mailed are still ` +
      `being sent to by the provider: ${v.unreconciledProspectIds.join(', ')}` +
      (v.unreconciledCount > v.unreconciledProspectIds.length
        ? ` and ${v.unreconciledCount - v.unreconciledProspectIds.length} more.`
        : '.'),
    )
  }

  if (v.invariantBreachCount > 0) {
    parts.push(
      `${v.invariantBreachCount} prospect(s) are marked uploaded with no provider lead id, ` +
      `so this sweep cannot check them at all.`,
    )
  }

  if (v.unreachableCount > 0) {
    parts.push(
      `${v.unreachableCount} suppressed lead(s) could not be read back from the provider, ` +
      `so their state is unknown rather than fine.`,
    )
  }

  if (hitCap) {
    parts.push(
      `The per-run ceiling of ${MAX_LEADS_PER_RUN} provider reads was reached, so this run ` +
      `did not cover everything and the counts above are a floor, not a total.`,
    )
  }

  if (parts.length === 0) {
    parts.push(
      v.blockedCount === 0
        ? `No prospect the provider holds is suppressed, across ${v.uploadedCount} uploaded ` +
          `prospect(s). Nothing to reconcile, and the upload invariant was checked over all ` +
          `${v.uploadedCount}.`
        : `All ${v.checkedCount} suppressed prospect(s) read back from the provider have ` +
          `stopped, out of ${v.blockedCount} suppressed and ${v.uploadedCount} uploaded.`,
    )
  }

  if (v.settlingCount > 0) {
    parts.push(
      `${v.settlingCount} suppressed within the last ${SETTLE_WINDOW_MINUTES} minutes and ` +
      `not yet judged, because the provider applies a stop asynchronously.`,
    )
  }

  return parts.join(' ')
}

/**
 * Write the verdict where the monitor can read it.
 *
 * A single row, rewritten every run, following sending_health_snapshot: one statement means
 * the counts and the sentence can never disagree with each other because a second write
 * landed between two reads.
 */
export async function writeReconciliationSnapshot(
  supabase: ServiceRoleClient,
  verdict: ReconciliationVerdict,
): Promise<void> {
  const { error } = await supabase
    .from('suppression_reconciliation_snapshot')
    .upsert({
      id: 1,
      uploaded_count: verdict.uploadedCount,
      blocked_count: verdict.blockedCount,
      checked_count: verdict.checkedCount,
      unreconciled_count: verdict.unreconciledCount,
      unreachable_count: verdict.unreachableCount,
      settling_count: verdict.settlingCount,
      invariant_breach_count: verdict.invariantBreachCount,
      incomplete: verdict.incomplete,
      unreconciled_prospect_ids: verdict.unreconciledProspectIds,
      detail: verdict.detail.slice(0, 2000),
      computed_at: new Date().toISOString(),
    })

  if (error) {
    // Loud, and NOT swallowed into a successful run. If the verdict is not stored, the
    // monitor reads the previous one, goes stale, and correctly turns red.
    logger.error('suppression reconcile: failed to store the verdict', { error: error.message })
    throw new Error(`could not store the reconciliation verdict: ${error.message}`)
  }
}
