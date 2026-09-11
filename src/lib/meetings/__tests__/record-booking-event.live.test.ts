// recordBookingEvent against the REAL test database.
//
// The route test proves the logic against a strict fake. This file proves what a fake
// cannot: that the real constraints accept what the code writes ('webhook' in the source
// CHECK, 'link' / 'email' / 'none' in prospect_match), and that the real UNIQUE keys on
// meetings.booking_uid and unattributed_bookings do make a repeated delivery a no-op.
//
// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/meetings/__tests__/record-booking-event.live.test.ts
//
// Cleans up by ownership only: the organisation it created, and quarantine rows whose uid
// carries this run's marker. Never a broad sweep.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import { recordBookingEvent } from '../record-booking-event'
import type { BookedDetails } from '../booking-event'

vi.mock('@/lib/notifications/send-first-meeting-email', () => ({
  sendFirstMeetingEmail: vi.fn(async () => ({ sent: false })),
}))
vi.mock('@/lib/notifications/send-unmatched-booking-notification', () => ({
  sendUnmatchedBookingNotification: vi.fn(async () => ({ sent: false })),
}))

const CONTEXT = 'record-booking-event.live.test.ts'
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const HOST = `host-${RUN}@example.test`
const PROVIDER = 'test_provider'

let supabase: SupabaseClient<Database>
let organisationId: string
let prospectId: string

const uid = (name: string) => `live-${RUN}-${name}`

function details(overrides: Partial<BookedDetails>): BookedDetails {
  return {
    bookingUid: uid('default'),
    startTime: '2026-09-15T09:30:00Z',
    hostRef: HOST,
    attendeeEmail: `booker.${RUN}@example.test`,
    attendeeName: 'Live Test Booker',
    prospectRef: null,
    ...overrides,
  }
}

async function meetingsWithUid(bookingUid: string) {
  const { data, error } = await supabase
    .from('meetings')
    .select('id, prospect_id, prospect_match, source, meeting_status, is_billable, booking_uid, scheduled_start_at')
    .eq('booking_uid', bookingUid)
  if (error) throw new Error(error.message)
  return data ?? []
}

beforeAll(async () => {
  supabase = createTestServiceClient(CONTEXT)

  const org = await supabase
    .from('organisations')
    .insert({ name: `ZZ booking live test ${RUN}`, slug: `zz-booking-live-${RUN}`, booking_host_ref: HOST })
    .select('id')
    .single()
  if (org.error || !org.data) throw new Error(`could not create test organisation: ${org.error?.message}`)
  organisationId = org.data.id

  const prospect = await supabase
    .from('prospects')
    .insert({ organisation_id: organisationId, email: `Booker.${RUN}@Example.test`, first_name: 'Live' })
    .select('id')
    .single()
  if (prospect.error || !prospect.data) throw new Error(`could not create test prospect: ${prospect.error?.message}`)
  prospectId = prospect.data.id
})

afterAll(async () => {
  if (!supabase) return
  const { error } = await supabase.from('unattributed_bookings').delete().like('provider_booking_uid', `live-${RUN}-%`)
  if (error) throw new Error(`[test-cleanup] ${CONTEXT}: unattributed_bookings: ${error.message}`)
  await deleteTestOrganisations(supabase, [organisationId], CONTEXT)
})

// Each call to the shared test database takes one to five seconds, measured on 2026-09-11,
// so the 5-second default timed out a test that was otherwise correct.
describe('recordBookingEvent on the real database', { timeout: 30_000 }, () => {
  it('records a linked booking, and the real constraints accept every value written', async () => {
    const client = asServiceRoleClient(supabase)
    const outcome = await recordBookingEvent(client, { kind: 'created', ...details({ bookingUid: uid('link'), prospectRef: prospectId }) }, PROVIDER)

    expect(outcome).toMatchObject({ outcome: 'recorded', prospectMatch: 'link' })
    const rows = await meetingsWithUid(uid('link'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ prospect_id: prospectId, prospect_match: 'link', source: 'webhook', is_billable: false })
  })

  it('the real UNIQUE key makes a repeated delivery a no-op', async () => {
    const client = asServiceRoleClient(supabase)
    const event = { kind: 'created' as const, ...details({ bookingUid: uid('twice'), prospectRef: prospectId }) }

    await recordBookingEvent(client, event, PROVIDER)
    const second = await recordBookingEvent(client, event, PROVIDER)

    expect(second).toEqual({ outcome: 'duplicate' })
    expect(await meetingsWithUid(uid('twice'))).toHaveLength(1)
  })

  it('matches by email, case-insensitively, when no reference came back', async () => {
    const client = asServiceRoleClient(supabase)
    const outcome = await recordBookingEvent(client, { kind: 'created', ...details({ bookingUid: uid('email'), attendeeEmail: `BOOKER.${RUN}@example.TEST` }) }, PROVIDER)

    expect(outcome).toMatchObject({ outcome: 'recorded', prospectMatch: 'email' })
    expect((await meetingsWithUid(uid('email')))[0]).toMatchObject({ prospect_id: prospectId })
  })

  it('records an unmatched booking with no prospect, rather than discarding it', async () => {
    const client = asServiceRoleClient(supabase)
    const outcome = await recordBookingEvent(client, { kind: 'created', ...details({ bookingUid: uid('none'), attendeeEmail: `stranger.${RUN}@example.test` }) }, PROVIDER)

    expect(outcome).toMatchObject({ outcome: 'recorded', prospectMatch: 'none' })
    expect((await meetingsWithUid(uid('none')))[0]).toMatchObject({ prospect_id: null, prospect_match: 'none', is_billable: false })
  })

  it('quarantines a booking from an unknown calendar once, however often it arrives', async () => {
    const client = asServiceRoleClient(supabase)
    const event = { kind: 'created' as const, ...details({ bookingUid: uid('quarantine'), hostRef: `nobody-${RUN}@example.test` }) }

    expect(await recordBookingEvent(client, event, PROVIDER)).toEqual({ outcome: 'quarantined' })
    expect(await recordBookingEvent(client, event, PROVIDER)).toEqual({ outcome: 'duplicate' })

    const { data, error } = await supabase
      .from('unattributed_bookings')
      .select('id')
      .eq('provider', PROVIDER)
      .eq('provider_booking_uid', uid('quarantine'))
    if (error) throw new Error(error.message)
    expect(data).toHaveLength(1)
    expect(await meetingsWithUid(uid('quarantine'))).toHaveLength(0)
  })

  it('cancels, then a reschedule moves the same meeting onto the new uid without a second row', async () => {
    const client = asServiceRoleClient(supabase)
    await recordBookingEvent(client, { kind: 'created', ...details({ bookingUid: uid('move-1'), prospectRef: prospectId }) }, PROVIDER)

    expect(await recordBookingEvent(client, { kind: 'cancelled', bookingUid: uid('move-1') }, PROVIDER))
      .toMatchObject({ outcome: 'cancelled' })
    expect((await meetingsWithUid(uid('move-1')))[0]).toMatchObject({ meeting_status: 'canceled', is_billable: false })

    const moved = await recordBookingEvent(client, {
      kind: 'rescheduled',
      previousBookingUid: uid('move-1'),
      ...details({ bookingUid: uid('move-2'), prospectRef: prospectId, startTime: '2026-09-18T14:00:00Z' }),
    }, PROVIDER)

    expect(moved).toMatchObject({ outcome: 'rescheduled' })
    expect(await meetingsWithUid(uid('move-1'))).toHaveLength(0)
    const rows = await meetingsWithUid(uid('move-2'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ meeting_status: 'booked', scheduled_start_at: '2026-09-18T14:00:00+00:00' })
  })
})
