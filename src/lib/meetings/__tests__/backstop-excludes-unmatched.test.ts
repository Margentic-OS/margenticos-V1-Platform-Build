// A booking that could not be tied to a prospect is RECORDED (record-booking-event.ts), and
// it must NEVER become billable. Not by the backstop, not by anything.
//
// Billing is per qualified meeting, and qualification needs a prospect to judge. Without this
// exclusion, a stranger who found a booking link and booked would turn into a billable
// meeting at the end of the following month with nobody having decided anything.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE REPLACES auto-held-excludes-unmatched.test.ts, WHICH GUARDED A DELETED JOB.
//
// The 72-hour auto-held job is gone (ADR-057) and its test went with it. The guard did not:
// it moved here, onto the job that can now make a meeting billable without a click. Deleting
// the test along with the job would have quietly retired the rule as well as the code.
//
// THERE ARE NOW THREE INDEPENDENT GUARDS, and that is deliberate:
//   1. the read filter in the sweep      .not('prospect_id', 'is', null)
//   2. the same filter on the UPDATE     so a row changing mid-run cannot slip through
//   3. the database constraint           meetings_billable_needs_a_prospect
// Each holds alone. (3) was proved to bite on the live test database with a probe that
// cannot commit, quoted in the migration's status marker.
//
// MUTATION-PROVED on commit: removing the prospect filter from BOTH the read and the update
// leaves this green, because the strict fake does not enforce the CHECK constraint. That is
// stated rather than hidden: this file proves the application guards, and the constraint is
// proved against the real database instead.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStrictFakeDb, type StrictFakeDb } from './helpers/strict-fake-db'
import { sweepMeetingOutcomes } from '../outcome-sweep'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

// The client is never actually emailed in these tests. Reported as sent so the sweep proceeds
// exactly as it would in production.
const sendOutcomeConfirmation = vi.hoisted(() => vi.fn(async () => ({ sent: true as const })))
vi.mock('@/lib/notifications/send-outcome-confirmation', () => ({ sendOutcomeConfirmation }))

const NOW = new Date('2026-11-05T09:34:00.000Z')
// A meeting in September has until the end of October. Both of these are past that.
const SEPTEMBER_MEETING = '2026-09-20T14:00:00.000Z'
const DEADLINE_PASSED = '2026-10-31T23:59:59.999Z'

function meeting(id: string, prospectId: string | null) {
  return {
    id,
    organisation_id: 'org-a',
    prospect_id: prospectId,
    meeting_status: 'booked',
    held_decision_locked: false,
    is_billable: false,
    billable_basis: null,
    held_confirmed_by: null,
    scheduled_start_at: SEPTEMBER_MEETING,
    scheduled_end_at: '2026-09-20T14:30:00.000Z',
    bill_unconfirmed_after: DEADLINE_PASSED,
    // Asked, and never answered. This is the case the backstop is FOR.
    outcome_requested_at: '2026-09-20T15:00:00.000Z',
    confirmation_sent_at: '2026-09-20T15:00:00.000Z',
    last_reminded_at: null,
    reminder_count: 3,
  }
}

let db: StrictFakeDb
beforeEach(() => {
  vi.clearAllMocks()
  db = createStrictFakeDb({
    organisations: [{ id: 'org-a', name: 'Apex Consulting', founder_first_name: 'Alex', archived_at: null }],
    users: [{ id: 'u-1', organisation_id: 'org-a', role: 'client', email: 'alex@apexconsulting.test' }],
    prospects: [{ id: 'prospect-1', first_name: 'Jordan', company_name: 'Northwind' }],
    meetings: [meeting('matched', 'prospect-1'), meeting('unmatched', null)],
  })
})

describe('the monthly backstop never bills a meeting with no prospect', () => {
  it('bills the matched meeting and leaves the unmatched one untouched', async () => {
    const run = await sweepMeetingOutcomes(db.client, NOW)

    const matched = db.tables.meetings.find(m => m.id === 'matched')
    const unmatched = db.tables.meetings.find(m => m.id === 'unmatched')

    // POSITIVE CONTROL. Without this, a sweep that silently did nothing at all would satisfy
    // the assertion below and this test would prove only that nothing happened.
    expect(run.billed_unconfirmed).toBe(1)
    expect(matched).toMatchObject({
      is_billable: true,
      billable_basis: 'unconfirmed_backstop',
      held_decision_locked: true,
    })

    expect(unmatched).toMatchObject({
      is_billable: false,
      billable_basis: null,
      held_decision_locked: false,
      meeting_status: 'booked',
    })
  })

  it('does not claim the billed meeting was held, because nobody said it was', async () => {
    await sweepMeetingOutcomes(db.client, NOW)

    // Billing an unconfirmed meeting is a contractual consequence of silence. Writing 'held'
    // would put a fact in the record that no person established, and it would make the
    // billing view unable to tell a confirmed meeting from an unanswered one.
    expect(db.tables.meetings.find(m => m.id === 'matched')).toMatchObject({
      meeting_status: 'booked',
      held_confirmed_by: null,
    })
  })

  it('never asks the client about an unmatched booking either', async () => {
    // The client did not book it with a prospect we know, so there is nobody to ask about.
    // The operator hears about it through the unmatched-booking alert when it arrives.
    const calls = sendOutcomeConfirmation.mock.calls as unknown as Array<[{ meetingId: string }]>
    await sweepMeetingOutcomes(db.client, NOW)
    expect(calls.some(call => call[0].meetingId === 'unmatched')).toBe(false)
  })
})
