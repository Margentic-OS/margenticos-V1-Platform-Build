// A booking that could not be tied to a prospect is RECORDED (record-booking-event.ts), and
// it must NEVER be billed by the auto-held job.
//
// Billing is per qualified meeting, and qualification needs a prospect to judge. Without
// this exclusion, a stranger who found a booking link and booked would become a billable
// meeting once the window closed, with nobody having decided anything.
//
// Uses the STRICT fake, which applies every filter it offers and throws on any it does not.
// The existing auto-held tests use a fake whose .not() returns the chain untouched, so they
// could never have noticed this filter being removed.
//
// MUTATION-PROVED on commit: removing the prospect_id filter from BOTH the read and the
// update turns this red. Removing it from only one of the two keeps it green, deliberately:
// each is a full guard on its own, and that is recorded rather than hidden.

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createStrictFakeDb } from './helpers/strict-fake-db'
import { resolveAutoHeldMeetings } from '../auto-held-resolution'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

const WELL_PAST_THE_WINDOW = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString()

function meeting(id: string, prospectId: string | null) {
  return {
    id,
    organisation_id: 'org-a',
    prospect_id: prospectId,
    meeting_status: 'booked',
    held_decision_locked: false,
    is_billable: false,
    held_confirmed_by: null,
    scheduled_start_at: WELL_PAST_THE_WINDOW,
  }
}

describe('auto-held never bills a meeting with no prospect', () => {
  it('bills the matched meeting and leaves the unmatched one booked and unbillable', async () => {
    const db = createStrictFakeDb({
      organisations: [{ id: 'org-a', auto_held_window_hours: 72, archived_at: null }],
      meetings: [meeting('matched', 'prospect-1'), meeting('unmatched', null)],
    })

    await resolveAutoHeldMeetings(db.client as unknown as SupabaseClient)

    const matched = db.tables.meetings.find(m => m.id === 'matched')
    const unmatched = db.tables.meetings.find(m => m.id === 'unmatched')

    // Positive control: the job ran and billed what it should. Without this, a job that
    // silently did nothing would pass the assertion below.
    expect(matched).toMatchObject({ meeting_status: 'held', is_billable: true, held_confirmed_by: 'auto' })

    expect(unmatched).toMatchObject({ meeting_status: 'booked', is_billable: false, held_decision_locked: false })
  })
})
