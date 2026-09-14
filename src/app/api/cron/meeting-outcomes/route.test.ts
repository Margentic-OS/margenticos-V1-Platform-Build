// POST /api/cron/meeting-outcomes: the auth gate, and the two things about this route that
// are load-bearing beyond its own return value.
//
//   1. THE HEARTBEAT DETAIL FORMAT. mon_010 parses the organisation count out of
//      "Examined N organisations" and compares it against the organisations that existed at
//      run time, so a job reporting success over work it did not do is a PROBLEM whatever it
//      says about itself. Change the prefix and the monitor goes UNKNOWN. That contract is
//      asserted here because nothing else in the repository can see it.
//
//   2. ok IS FALSE WHEN A MEETING PASSED ITS DEADLINE UNASKED. That meeting will never bill
//      and nobody has chased it. A run that quietly reports success over it is the same shape
//      as resolve-auto-held reporting 31 healthy runs over a denied read.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'check-in-id'),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
}))

const sweepMeetingOutcomes = vi.hoisted(() => vi.fn())
vi.mock('@/lib/meetings/outcome-sweep', () => ({ sweepMeetingOutcomes }))

const sendDueToBillNotification = vi.hoisted(() => vi.fn(async () => ({ sent: true })))
vi.mock('@/lib/notifications/send-due-to-bill-notification', () => ({ sendDueToBillNotification }))

// Captures what the route writes to cron_heartbeats, which is the only durable record of a run.
const heartbeats = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createServiceRoleClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service-role', () => ({ createServiceRoleClient }))

import { POST } from './route'

const EMPTY_RUN = {
  organisations_examined: 0,
  confirmations_sent: 0,
  reminders_sent: 0,
  billed_unconfirmed: 0,
  past_deadline_never_asked: 0,
  due_to_bill_unconfirmed: [],
  organisations_failed: 0,
}

function request(token: string | null = 'right-secret'): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/meeting-outcomes', {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  heartbeats.length = 0
  process.env.CRON_SECRET = 'right-secret'
  createServiceRoleClient.mockResolvedValue({
    from: (table: string) => {
      if (table !== 'cron_heartbeats') throw new Error(`unexpected table ${table}`)
      return { insert: async (row: Record<string, unknown>) => { heartbeats.push(row); return { error: null } } }
    },
  })
  sweepMeetingOutcomes.mockResolvedValue({ ...EMPTY_RUN })
})

describe('the auth gate', () => {
  it('refuses a request with no token, and does not sweep', async () => {
    expect((await POST(request(null))).status).toBe(401)
    expect(sweepMeetingOutcomes).not.toHaveBeenCalled()
  })

  it('refuses a wrong token', async () => {
    expect((await POST(request('wrong-secret'))).status).toBe(401)
    expect(sweepMeetingOutcomes).not.toHaveBeenCalled()
  })

  it('refuses everything when no secret is configured, rather than letting anyone in', async () => {
    delete process.env.CRON_SECRET
    expect((await POST(request('anything'))).status).toBe(401)
    expect(sweepMeetingOutcomes).not.toHaveBeenCalled()
  })
})

describe('the heartbeat detail mon_010 has to parse', () => {
  it('starts with "Examined N organisations", which is the monitor contract', async () => {
    sweepMeetingOutcomes.mockResolvedValue({ ...EMPTY_RUN, organisations_examined: 3, confirmations_sent: 2 })

    await POST(request())

    expect(heartbeats).toHaveLength(1)
    expect(heartbeats[0].job_name).toBe('meeting-outcomes')
    expect(String(heartbeats[0].detail)).toMatch(/^Examined 3 organisations/)
  })

  it('names the counts a person needs, not just the organisation count', async () => {
    sweepMeetingOutcomes.mockResolvedValue({
      ...EMPTY_RUN, organisations_examined: 2, confirmations_sent: 1, reminders_sent: 4, billed_unconfirmed: 2,
    })

    await POST(request())

    const detail = String(heartbeats[0].detail)
    expect(detail).toContain('asked 1')
    expect(detail).toContain('reminded 4')
    expect(detail).toContain('billed unconfirmed 2')
  })

  it('records a failed run as failed, with the reason in the detail', async () => {
    sweepMeetingOutcomes.mockResolvedValue({ ...EMPTY_RUN, organisations_examined: 2, organisations_failed: 1 })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(heartbeats[0].ok).toBe(false)
    expect(String(heartbeats[0].detail)).toContain('1 FAILED')
  })

  it('still writes a heartbeat when the sweep throws, so a crash is not silence', async () => {
    sweepMeetingOutcomes.mockRejectedValueOnce(new Error('organisations read failed: permission denied'))

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(heartbeats[0]).toMatchObject({ job_name: 'meeting-outcomes', ok: false })
    expect(String(heartbeats[0].detail)).toContain('permission denied')
  })
})

describe('a meeting that passed its deadline unasked is not a healthy run', () => {
  it('reports ok false and says so in the detail', async () => {
    sweepMeetingOutcomes.mockResolvedValue({
      ...EMPTY_RUN, organisations_examined: 1, past_deadline_never_asked: 2,
    })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.ok).toBe(false)
    expect(heartbeats[0].ok).toBe(false)
    expect(String(heartbeats[0].detail)).toContain('2 PAST DEADLINE NEVER ASKED, not billed')
  })
})

describe('telling the operator', () => {
  it('emails the due-to-bill list when there is one', async () => {
    const rows = [{
      meetingId: 'm-1', organisationName: 'Apex Consulting', prospectName: 'Jordan Reid',
      scheduledStartAt: '2026-09-20T14:00:00.000Z', deadline: '2026-10-31T23:59:59.999Z',
      daysLeft: 5, neverAsked: false,
    }]
    sweepMeetingOutcomes.mockResolvedValue({ ...EMPTY_RUN, organisations_examined: 1, due_to_bill_unconfirmed: rows })

    await POST(request())

    expect(sendDueToBillNotification).toHaveBeenCalledWith(rows)
  })

  it('sends nothing when nothing is near its deadline', async () => {
    await POST(request())
    expect(sendDueToBillNotification).not.toHaveBeenCalled()
  })
})
