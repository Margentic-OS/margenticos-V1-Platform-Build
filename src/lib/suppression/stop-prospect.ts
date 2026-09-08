// src/lib/suppression/stop-prospect.ts
//
// STOPPING ONE PROSPECT, ON PURPOSE, FROM INSIDE THE PRODUCT.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE GAP THIS CLOSES
//
// Every mechanism that could stop a person was reachable only by something happening TO
// us: they replied "stop", their address bounced, the research agent disqualified them.
// There was no way for an operator to decide it.
//
// Measured 2026-08-26: two prospects kept receiving mail after being marked ineligible,
// with emails 3 and 4 still scheduled. Stopping them was a manual click in the vendor UI.
// The plumbing to stop them through the product shipped on 2026-09-04. The caller did not.
// This is the caller.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS WRITES suppressed, AND WHY THAT IS THE WHOLE POINT
//
// The obvious implementation is to write ONLY the hold columns: send_hold_at is the
// purpose-built, durable, operator-owned field, and it survives re-verification, which is
// exactly what a hand-written UPDATE did not.
//
// That implementation would be INVISIBLE TO THE MONITOR, and the monitor is the only
// reason any of this can be trusted.
//
// MON-026 reconciles against the provider, per lead, for the prospects that
// findBlockedProspects says must not be mailed. That predicate reads prospects.suppressed
// and client_review_status. IT DOES NOT READ send_hold_at. So a hold-only stop would:
//
//   - block the next upload (applySendGate requires suppressed = false), and
//   - never be reconciled against the provider, because the sweep would not select it, and
//   - report OK for ever, because a monitor that cannot select a row cannot fail on it.
//
// That is the precise shape this codebase keeps rediscovering: the monitor sweep whose loop
// was bounded by the shorter of two arrays, the audit that filtered relkind = 'r' and could
// not see a view, the grep that never ran. In each, the check reported success about
// something it never reached.
//
// So the suppressed write is not bookkeeping and it is not redundancy. It is the thing that
// puts this person inside the monitor's field of view. Removing it must fail a test.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT ALSO WRITES THE HOLD
//
// suppressed alone is not durable in the way that matters. email_send_eligible is a
// MATERIALISED verdict (ADR-034), recomputed from scratch at every verification, and both
// writers of it honour send_hold_at. Without the hold, a re-verification recomputes the row
// to eligible and logs nothing, because from the resolver's point of view it is simply
// computing the right answer from the evidence.
//
// The two writes answer two different questions and neither substitutes for the other:
//   suppressed     is this person visible to the gate and to the monitor?
//   send_hold_at   does this decision survive the next verification run?
//
// ═════════════════════════════════════════════════════════════════════════════
// ORDER OF OPERATIONS, AND THE DIRECTION OF FAILURE
//
// DATABASE FIRST, PROVIDER SECOND. Always. suppressProspectAtProvider's own doc comment
// requires it, and the reason is which way the system breaks when half of it fails:
//
//   database first, provider fails   the row says stopped, the provider is still sending,
//                                    the row is inside findBlockedProspects, so MON-026
//                                    reads the lead back, sees it sending, and goes RED.
//                                    LOUD.
//   provider first, database fails   the provider is stopped, our record says mailable.
//                                    Nothing is wrong today and nothing says anything.
//                                    SILENT, and the person may be re-uploaded later.
//
// Both are failures. Only one of them tells anybody.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS DELIBERATELY DOES NOT DO
//
// NOT client_review_status. A Locked decision (2026-09-07) makes the client's prospect list
// a permanent record: "nothing disappears", and a current-sendability filter "would erase
// the evidence that we mailed them". buildRosterGroups drops rejected prospects, which is
// correct for someone the client removed BEFORE we contacted them and wrong for someone
// already mailed. Writing rejection here would delete a contacted person from the client's
// own record of who was contacted. A stop must not rewrite history.
//
// NOT the provider's blocklist. getInstantlyApiKey ignores its organisationId and returns
// one workspace-wide key, so a blocklist entry would block that address out of every other
// client's campaigns, and entries accept whole domains.
//
// NOT a delete. Irreversible, and reply history is the record.
//
// NOT a resume. A Locked decision (2026-09-07) puts pause and resume with the provider:
// "anything we build that also decides when a sequence restarts is a second scheduler
// competing with one that already works." This stop is one-way. Undoing it is a deliberate
// separate act, not a scheduled one.
//
// NOT A BATCH. One prospect, one operator, one recorded reason. The batch and whole-client
// cases need a decision about their trigger before they need code, and shipping this does
// not foreclose either.

import { logger } from '@/lib/logger'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import {
  suppressProspectAtProvider,
  type ProviderSuppressionResult,
} from './provider-suppression'

/**
 * What prospects.suppression_reason records for a stop made through this path.
 *
 * A fixed machine-readable value, deliberately separate from the operator's free-text
 * reason. The column already carries values from four other writers and a future reader
 * has to be able to tell which wrote a given row. The operator's own words go to
 * send_hold_reason, which exists for exactly that and is CHECK-constrained to be present
 * whenever a hold is.
 */
export const OPERATOR_STOP_SUPPRESSION_REASON = 'operator_stop'

/** The prospect this module needs. Deliberately not the whole row. */
export interface StopSubject {
  id: string
  organisation_id: string
  email: string | null
  outbound_lead_id: string | null
}

export interface StopProspectParams {
  subject: StopSubject
  /** The operator placing the stop. Recorded on the row, never inferred. */
  operatorId: string
  /**
   * Why. REQUIRED, and not defaulted.
   *
   * A hold with no reason is indistinguishable from a bug: that is the exact defect the
   * send_hold columns were added to remove, after three rows were found holding a value
   * with no rule behind it and no record of who set it. An optional reason here would let
   * a caller omit it and recreate the state this was built to end.
   */
  reason: string
}

export type StopProspectResult =
  | {
      ok: true
      /**
       * What the provider carry did. 'not_required' when the prospect was never uploaded,
       * so there is no lead to stop.
       *
       * NOTE THE ASYMMETRY, it is deliberate: ok:true here means THE DATABASE STOP IS IN
       * PLACE, which is what makes the person visible to the gate and the monitor. It does
       * NOT mean the provider confirmed. Read carry.status for that, and read MON-026 for
       * whether the sequence actually stopped. Collapsing the two would let a failed
       * provider call read as a failed stop, and the operator would retry a stop that is
       * already correctly recorded.
       */
      carry: ProviderSuppressionResult
    }
  | { ok: false; error: string }

/**
 * Stop contacting one prospect.
 *
 * Writes the stop, then tells the provider. Returns ok:false ONLY when the database write
 * failed, because that is the only outcome in which nothing was stopped and nothing is
 * watching.
 */
export async function stopProspect(
  supabase: ServiceRoleClient,
  params: StopProspectParams,
): Promise<StopProspectResult> {
  const { subject, operatorId, reason } = params

  const trimmedReason = reason.trim()
  if (trimmedReason.length === 0) {
    // Refused rather than defaulted. See StopProspectParams.reason.
    return { ok: false, error: 'a stop requires a reason' }
  }

  const now = new Date().toISOString()

  // ── One statement, so the pairing cannot half-land ──────────────────────────
  //
  // suppressed and send_hold are written together. The CHECK constraint
  // prospects_send_hold_complete already refuses a hold with no reason; writing these in
  // two statements would open a window in which the row is suppressed without being
  // durable, or held without being visible to the monitor.
  //
  // Scoped by organisation_id as well as id. Per CLAUDE.md every query carries the
  // client_id filter, and here it also means a wrong organisation matches zero rows rather
  // than stopping somebody else's prospect.
  const { data, error } = await supabase
    .from('prospects')
    .update({
      // The half that makes this visible to findBlockedProspects, and therefore to MON-026.
      suppressed: true,
      suppressed_at: now,
      suppression_reason: OPERATOR_STOP_SUPPRESSION_REASON,
      // The half that survives re-verification.
      send_hold_at: now,
      send_hold_by: operatorId,
      send_hold_reason: trimmedReason,
      updated_at: now,
    })
    .eq('id', subject.id)
    .eq('organisation_id', subject.organisation_id)
    .select('id')

  if (error) {
    logger.error('stop prospect: the stop was not recorded', {
      prospect_id: subject.id,
      organisation_id: subject.organisation_id,
      error: error.message,
    })
    return { ok: false, error: `stop not recorded: ${error.message}` }
  }

  if (!data || data.length === 0) {
    // No row matched. Reported as a failure rather than as a successful no-op: an UPDATE
    // that changed nothing and returns ok is how a caller comes to believe somebody was
    // stopped who was not.
    return {
      ok: false,
      error: 'stop not recorded: no prospect matched that id in that organisation',
    }
  }

  logger.info('stop prospect: recorded, carrying to the provider', {
    prospect_id: subject.id,
    organisation_id: subject.organisation_id,
    operator_id: operatorId,
    // The reason is the operator's free text and is not logged: it is on the row, and a log
    // line is the wrong place for prose that may name a person.
    has_lead: subject.outbound_lead_id !== null,
  })

  // ── Then the provider ───────────────────────────────────────────────────────
  //
  // Never throws for an ordinary provider failure: it returns 'failed', records the reason
  // on the row, and reports it to Sentry itself. A failed carry does not undo the stop, and
  // must not, because the database half is what keeps this person blocked and watched.
  const carry = await suppressProspectAtProvider(supabase, {
    id: subject.id,
    organisation_id: subject.organisation_id,
    email: subject.email,
    outbound_lead_id: subject.outbound_lead_id,
  })

  return { ok: true, carry }
}
