// The daily meeting-outcome sweep. It asks, it reminds, and it applies the monthly backstop.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT REPLACED WHAT
//
// The 72-hour auto-held job marked a meeting held and billable three days after its start,
// recorded as confirmed by 'auto', with no human involved. It was never part of the pricing
// decision of 2026-08-24 and it is gone: paused in the database (20260911210000) and its code
// deleted in this commit.
//
// What the 2026-08-24 decision actually says is here instead. A meeting in month M rolls
// unconfirmed onto the M+1 invoice, and if still unconfirmed at the END OF M+1 it bills
// automatically. That is a commercial term the client agrees to, so this job does bill
// without a click, but only at the real calendar deadline and only after the client was asked.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FOUR RULES THAT KEEP A MEETING FROM BILLING WITHOUT A HUMAN
//
// 1. NOTHING IS BILLED THAT NOBODY WAS ASKED ABOUT. The backstop requires
//    confirmation_sent_at. If the ask never went out, the meeting is reported to the operator
//    as never asked and is left alone. Billing someone we never emailed is indefensible, and
//    a missing JWT_SECRET or a bounced address would otherwise produce exactly that.
// 2. NOTHING IS BILLED BEFORE ITS DEADLINE. The deadline is a stored calendar date
//    (bill_unconfirmed_after), and this job only ever compares against it.
// 3. A HUMAN ANSWER AT ANY POINT WINS. Every query here requires
//    held_decision_locked = false, so a client confirmation or an operator decision taken a
//    minute before the deadline takes the meeting out of reach of the backstop.
// 4. NOTHING UNMATCHED IS BILLED, EVER. A booking with no prospect cannot be billed at all:
//    the database refuses it (meetings_billable_needs_a_prospect), and this job filters it
//    out as well, so neither alone is load-bearing.
//
// AND IT NEVER CLAIMS THE MEETING HAPPENED. The backstop sets is_billable with
// billable_basis 'unconfirmed_backstop' and leaves meeting_status alone. Billing an
// unconfirmed meeting is a contractual consequence of silence, not a finding that anybody
// attended, and writing 'held' would put a fact in the record that nobody established.

import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { OPERATOR_WARNING_DAYS, daysUntil, reminderDue } from './billing-deadline'
import { sendOutcomeConfirmation } from '@/lib/notifications/send-outcome-confirmation'

export interface DueUnconfirmed {
  meetingId: string
  organisationName: string
  prospectName: string | null
  scheduledStartAt: string | null
  deadline: string
  daysLeft: number
  /** True when the client was never successfully asked, so the backstop will NOT bill it. */
  neverAsked: boolean
}

export interface OutcomeSweepRun {
  /** Organisations read and walked. NOT the number that had work to do. */
  organisations_examined: number
  confirmations_sent: number
  reminders_sent: number
  billed_unconfirmed: number
  /** Past the deadline but never successfully asked, so deliberately NOT billed. */
  past_deadline_never_asked: number
  /** Within the operator warning window and still unconfirmed. */
  due_to_bill_unconfirmed: DueUnconfirmed[]
  /** Organisations whose read or write was refused. A non-zero value is never a healthy run. */
  organisations_failed: number
}

interface MeetingRow {
  id: string
  prospect_id: string | null
  scheduled_start_at: string | null
  scheduled_end_at: string | null
  bill_unconfirmed_after: string | null
  outcome_requested_at: string | null
  confirmation_sent_at: string | null
  reminder_count: number
}

/**
 * When the meeting finished, as best we know. The scheduled end when the booking tool gave
 * us one, otherwise the start, which is the conservative choice: it can only make the ask
 * EARLIER than the true end for a long meeting, and the client can answer either way.
 */
function finishedAt(meeting: MeetingRow): Date | null {
  const raw = meeting.scheduled_end_at ?? meeting.scheduled_start_at
  if (!raw) return null
  const when = new Date(raw)
  return Number.isNaN(when.getTime()) ? null : when
}

export async function sweepMeetingOutcomes(
  supabase: ServiceRoleClient,
  now: Date = new Date(),
): Promise<OutcomeSweepRun> {
  const run: OutcomeSweepRun = {
    organisations_examined: 0,
    confirmations_sent: 0,
    reminders_sent: 0,
    billed_unconfirmed: 0,
    past_deadline_never_asked: 0,
    due_to_bill_unconfirmed: [],
    organisations_failed: 0,
  }

  const { data: organisations, error: orgError } = await supabase
    .from('organisations')
    .select('id, name, founder_first_name')
    .is('archived_at', null)

  // A denied read is a failed run, not an empty one. Deliberately not caught: the caller
  // stamps ok=false on the strength of this throwing. resolve-auto-held reported 31
  // consecutive healthy runs over a read that was returning nothing, and this is the shape
  // that prevented it being reported that way again.
  if (orgError) {
    logger.error('meeting outcomes: organisations read failed', { error: orgError.message })
    Sentry.captureException(orgError, { extra: { action: 'outcome_sweep_orgs_read' } })
    throw new Error(`meeting outcomes: organisations read failed: ${orgError.message}`)
  }

  run.organisations_examined = organisations?.length ?? 0
  if (!organisations || organisations.length === 0) return run

  for (const organisation of organisations) {
    try {
      await sweepOneOrganisation(supabase, organisation, now, run)
    } catch (error) {
      run.organisations_failed++
      logger.error('meeting outcomes: organisation failed, continuing with the rest', {
        organisation_id: organisation.id,
        error: error instanceof Error ? error.message : String(error),
      })
      Sentry.captureException(error, { extra: { action: 'outcome_sweep_org', org_id: organisation.id } })
    }
  }

  return run
}

async function sweepOneOrganisation(
  supabase: ServiceRoleClient,
  organisation: { id: string; name: string; founder_first_name: string | null },
  now: Date,
  run: OutcomeSweepRun,
): Promise<void> {
  // Undecided, still booked, and tied to a prospect. Rule 4: an unmatched booking is not
  // chased and not billed, it goes to the operator through its own alert when it arrives.
  const { data: meetings, error } = await supabase
    .from('meetings')
    .select('id, prospect_id, scheduled_start_at, scheduled_end_at, bill_unconfirmed_after, outcome_requested_at, confirmation_sent_at, reminder_count')
    .eq('organisation_id', organisation.id)
    .eq('meeting_status', 'booked')
    .eq('held_decision_locked', false)
    .not('prospect_id', 'is', null)

  if (error) throw new Error(`meetings read failed: ${error.message}`)
  if (!meetings || meetings.length === 0) return

  // One lookup per organisation rather than per meeting.
  const clientEmail = await readClientEmail(supabase, organisation.id)

  for (const meeting of meetings as MeetingRow[]) {
    const deadlineRaw = meeting.bill_unconfirmed_after
    const deadline = deadlineRaw ? new Date(deadlineRaw) : null
    const finished = finishedAt(meeting)
    const prospectName = await readProspectFirstName(supabase, meeting.prospect_id)

    // ── Past the deadline: the backstop ──────────────────────────────────────
    if (deadline && !Number.isNaN(deadline.getTime()) && now.getTime() > deadline.getTime()) {
      if (!meeting.confirmation_sent_at) {
        // Rule 1. Never billed, and never silent about it.
        run.past_deadline_never_asked++
        run.due_to_bill_unconfirmed.push({
          meetingId: meeting.id,
          organisationName: organisation.name,
          prospectName,
          scheduledStartAt: meeting.scheduled_start_at,
          deadline: deadlineRaw as string,
          daysLeft: 0,
          neverAsked: true,
        })
        logger.warn('meeting outcomes: past its deadline but the client was never asked, so NOT billed', {
          organisation_id: organisation.id,
          meeting_id: meeting.id,
        })
        continue
      }
      await billUnconfirmed(supabase, organisation.id, meeting.id, run)
      continue
    }

    // ── Before the deadline: ask, then remind ────────────────────────────────
    if (!clientEmail || !deadline || Number.isNaN(deadline.getTime())) {
      if (!clientEmail) {
        logger.warn('meeting outcomes: no client address for this organisation, nobody can be asked', {
          organisation_id: organisation.id,
        })
      }
      continue
    }

    const askable = {
      supabase,
      organisationId: organisation.id,
      organisationName: organisation.name,
      clientFirstName: organisation.founder_first_name,
      clientEmail,
      meetingId: meeting.id,
      prospectName,
      scheduledStartAt: meeting.scheduled_start_at,
      deadline,
    }

    // The first ask goes out once the slot has passed. A meeting-ended notification may have
    // stamped outcome_requested_at already; either way the email is what starts the clock,
    // and confirmation_sent_at is the record of it.
    if (!meeting.confirmation_sent_at) {
      if (!finished || finished.getTime() > now.getTime()) continue

      const result = await sendOutcomeConfirmation({ ...askable, reminderIndex: null })
      if (!result.sent && result.reason !== 'already_sent') continue

      const { error: stampError } = await supabase
        .from('meetings')
        .update({
          confirmation_sent_at: now.toISOString(),
          outcome_requested_at: meeting.outcome_requested_at ?? now.toISOString(),
        })
        .eq('id', meeting.id)
        .eq('organisation_id', organisation.id)
      if (stampError) throw new Error(`confirmation stamp failed: ${stampError.message}`)
      run.confirmations_sent++
      continue
    }

    // Reminders, counted BACK from the real deadline rather than forward from the meeting.
    const due = reminderDue(deadline, now, meeting.reminder_count ?? 0)
    if (due) {
      const result = await sendOutcomeConfirmation({ ...askable, reminderIndex: due.index })
      if (result.sent || result.reason === 'already_sent') {
        const { error: remindError } = await supabase
          .from('meetings')
          .update({ last_reminded_at: now.toISOString(), reminder_count: due.index + 1 })
          .eq('id', meeting.id)
          .eq('organisation_id', organisation.id)
        if (remindError) throw new Error(`reminder stamp failed: ${remindError.message}`)
        if (result.sent) run.reminders_sent++
      }
    }

    // The operator's list: still unconfirmed, and close enough to the deadline that there is
    // time to chase the client by hand.
    const left = daysUntil(deadline, now)
    if (left <= OPERATOR_WARNING_DAYS) {
      run.due_to_bill_unconfirmed.push({
        meetingId: meeting.id,
        organisationName: organisation.name,
        prospectName,
        scheduledStartAt: meeting.scheduled_start_at,
        deadline: deadlineRaw as string,
        daysLeft: left,
        neverAsked: false,
      })
    }
  }
}

/**
 * Bills one meeting unconfirmed. Every filter that decides whether a meeting may be billed is
 * repeated ON THE UPDATE, so the decision does not depend on the row still looking the way it
 * did when it was read. A client who answers between the read and the write keeps their
 * answer, and this update simply touches nothing.
 */
async function billUnconfirmed(
  supabase: ServiceRoleClient,
  organisationId: string,
  meetingId: string,
  run: OutcomeSweepRun,
): Promise<void> {
  const { data: billed, error } = await supabase
    .from('meetings')
    .update({
      is_billable: true,
      billable_basis: 'unconfirmed_backstop',
      held_decision_locked: true,
    })
    .eq('id', meetingId)
    .eq('organisation_id', organisationId)
    .eq('meeting_status', 'booked')
    .eq('held_decision_locked', false)
    .not('prospect_id', 'is', null)
    .not('confirmation_sent_at', 'is', null)
    .select('id')

  if (error) throw new Error(`unconfirmed backstop update failed: ${error.message}`)
  if (!billed || billed.length === 0) {
    logger.info('meeting outcomes: backstop touched no row, the meeting was decided first', {
      organisation_id: organisationId,
      meeting_id: meetingId,
    })
    return
  }

  run.billed_unconfirmed++
  logger.info('meeting outcomes: billed unconfirmed at the end of the following month', {
    organisation_id: organisationId,
    meeting_id: meetingId,
    basis: 'unconfirmed_backstop',
  })
}

async function readClientEmail(
  supabase: ServiceRoleClient,
  organisationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('email')
    .eq('organisation_id', organisationId)
    .eq('role', 'client')
    .limit(1)
  if (error) throw new Error(`client address read failed: ${error.message}`)
  return data?.[0]?.email ?? null
}

async function readProspectFirstName(
  supabase: ServiceRoleClient,
  prospectId: string | null,
): Promise<string | null> {
  if (!prospectId) return null
  const { data, error } = await supabase
    .from('prospects')
    .select('first_name, company_name')
    .eq('id', prospectId)
    .maybeSingle()
  if (error) throw new Error(`prospect read failed: ${error.message}`)
  if (!data) return null
  return data.first_name ?? data.company_name ?? null
}
