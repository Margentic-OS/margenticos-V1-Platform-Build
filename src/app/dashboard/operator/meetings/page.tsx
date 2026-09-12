// The operator's meeting outcome screen.
//
// Held versus no-show is a human judgement, permanently (ADR-057), so this is the screen
// where that judgement gets made. It answers three questions:
//
//   1. Which meetings are waiting on an answer?
//   2. Which will bill unconfirmed soon, while there is still time to chase the client?
//   3. What is billable, and HOW did each one become billable?
//
// The third is a requirement, not a nicety. A client billed for a meeting they never
// confirmed must be able to see exactly which one, so the basis travels with every billable
// meeting and is shown in words here.
//
// TWO CLIENTS, per ADR-027: the session client answers "who is asking" and the service-role
// client reads the data, because this screen is deliberately cross-organisation and RLS would
// scope it to the operator's own organisation.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { MeetingOutcomesBoard, type OutcomeRow } from './components/MeetingOutcomesBoard'
import { OPERATOR_WARNING_DAYS, daysUntil } from '@/lib/meetings/billing-deadline'

// Enough to see everything that matters without paging. If this screen ever runs against
// hundreds of open meetings, the limit is the thing to revisit, and a truncated list says so
// rather than pretending to be complete.
const ROW_LIMIT = 200

export default async function OperatorMeetingsPage() {
  const session = await createClient()

  const { data: { user } } = await session.auth.getUser()
  if (!user) redirect('/login')

  // Belt and braces: the layout verifies the role, and every operator page does its own
  // check per CLAUDE.md.
  const { data: userRow } = await session
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const db = await createServiceRoleClient()

  // Everything undecided, plus everything already billable. Read as one set and split below,
  // so the counts on this screen cannot disagree with each other.
  const { data: meetings, error } = await db
    .from('meetings')
    .select('id, organisation_id, prospect_id, meeting_status, held_decision_locked, held_confirmed_by, is_billable, billable_basis, scheduled_start_at, scheduled_end_at, bill_unconfirmed_after, confirmation_sent_at, reminder_count, prospect_match')
    .order('scheduled_start_at', { ascending: false })
    .limit(ROW_LIMIT)

  // A failed read must not render as "no meetings". That is the shape that let a job report
  // 31 healthy runs over a denied query.
  if (error) {
    return (
      <>
        <OperatorTopbar
          eyebrow="Operator view"
          title="Meetings"
          subtitle="Outcomes and billing basis"
          userEmail={user.email}
        />
        <div className="px-7 py-6">
          <p className="text-[13px] text-red-700">
            The meetings could not be read, so this screen is showing nothing rather than
            claiming there is nothing. The error was: {error.message}
          </p>
        </div>
      </>
    )
  }

  const rows = meetings ?? []
  const organisationIds = [...new Set(rows.map(row => row.organisation_id))]
  const prospectIds = [...new Set(rows.map(row => row.prospect_id).filter((id): id is string => Boolean(id)))]

  // Separate reads rather than a nested select, so a missing relationship cannot turn the
  // whole page into an error and the types stay obvious.
  const [{ data: organisations }, { data: prospects }] = await Promise.all([
    organisationIds.length > 0
      ? db.from('organisations').select('id, name').in('id', organisationIds)
      : Promise.resolve({ data: [], error: null }),
    prospectIds.length > 0
      ? db.from('prospects').select('id, first_name, company_name').in('id', prospectIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  const organisationName = new Map((organisations ?? []).map(org => [org.id, org.name]))
  const prospectLabel = new Map(
    (prospects ?? []).map(prospect => [
      prospect.id,
      [prospect.first_name, prospect.company_name].filter(Boolean).join(', ') || null,
    ]),
  )

  const now = new Date()
  const outcomeRows: OutcomeRow[] = rows.map(row => {
    const deadline = row.bill_unconfirmed_after ? new Date(row.bill_unconfirmed_after) : null
    const deadlineUsable = deadline && !Number.isNaN(deadline.getTime()) ? deadline : null
    return {
      id: row.id,
      organisationName: organisationName.get(row.organisation_id) ?? 'Unknown client',
      prospectLabel: row.prospect_id ? prospectLabel.get(row.prospect_id) ?? null : null,
      unmatched: !row.prospect_id,
      meetingStatus: row.meeting_status,
      decided: row.held_decision_locked,
      decidedBy: row.held_confirmed_by,
      isBillable: row.is_billable,
      billableBasis: row.billable_basis,
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      deadline: row.bill_unconfirmed_after,
      daysLeft: deadlineUsable ? daysUntil(deadlineUsable, now) : null,
      asked: Boolean(row.confirmation_sent_at),
      remindersSent: row.reminder_count ?? 0,
    }
  })

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Meetings"
        subtitle="Outcomes and billing basis"
        userEmail={user.email}
      />
      <WarningsRail />
      <MeetingOutcomesBoard
        rows={outcomeRows}
        warningDays={OPERATOR_WARNING_DAYS}
        truncated={rows.length >= ROW_LIMIT}
      />
    </>
  )
}
