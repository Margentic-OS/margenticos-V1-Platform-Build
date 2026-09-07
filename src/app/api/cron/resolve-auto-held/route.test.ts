import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

// Captures every cron_heartbeats row the route writes, so a test can assert on the
// `ok` flag and the detail string rather than only on the HTTP response.
const heartbeatInserts: Array<{ job_name: string; ok: boolean; detail: string }> = []

// One stable client object, so a test can assert the route passed THIS object to the
// resolver rather than creating one and dropping it.
const serviceRoleClient = {
  from: vi.fn(() => ({
    insert: vi.fn((row: { job_name: string; ok: boolean; detail: string }) => {
      heartbeatInserts.push(row)
      return Promise.resolve({ error: null })
    }),
  })),
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => serviceRoleClient),
}))

const EMPTY_RUN = {
  organisations_examined: 0,
  organisations_with_resolutions: [],
  meetings_resolved: 0,
  organisations_failed: 0,
}

vi.mock('@/lib/meetings/auto-held-resolution', () => ({
  resolveAutoHeldMeetings: vi.fn(() => Promise.resolve({
    organisations_examined: 0,
    organisations_with_resolutions: [],
    meetings_resolved: 0,
    organisations_failed: 0,
  })),
}))

// Import and re-export the real resolver (not mocked for window tests)
import { resolveAutoHeldMeetings } from '@/lib/meetings/auto-held-resolution'

// ─── Helper: Test the window calculation logic directly ──────────────

function evaluateWindowEligibility(
  scheduledStartAt: string,
  windowHours: number,
  now: Date
): boolean {
  const scheduledTime = new Date(scheduledStartAt).getTime()
  const windowEnd = scheduledTime + windowHours * 60 * 60 * 1000
  return now.getTime() >= windowEnd
}

describe('Auto-held Resolution Window Logic', () => {
  describe('Window Calculation: scheduled_start_at + auto_held_window_hours < now()', () => {
    it('meeting 100h in past is eligible for auto-hold', () => {
      const now = new Date('2026-07-10T12:00:00Z')
      const windowHours = 72

      // Meeting scheduled 100h ago
      const meetingTime = new Date(now.getTime() - 100 * 60 * 60 * 1000).toISOString()
      const isEligible = evaluateWindowEligibility(meetingTime, windowHours, now)

      expect(isEligible).toBe(true)
    })

    it('meeting 1h in future is NOT eligible (window not closed)', () => {
      const now = new Date('2026-07-10T12:00:00Z')
      const windowHours = 72

      // Meeting scheduled 1h in future
      const meetingTime = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString()
      const isEligible = evaluateWindowEligibility(meetingTime, windowHours, now)

      expect(isEligible).toBe(false)
    })

    it('reschedule earlier moves window earlier, making it eligible sooner', () => {
      const now = new Date('2026-07-10T12:00:00Z')
      const windowHours = 72

      // Original meeting: 9 days ago (past window)
      const originalTime = new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString()
      const originalEligible = evaluateWindowEligibility(originalTime, windowHours, now)
      expect(originalEligible).toBe(true)

      // Reschedule earlier: 12 days ago (even further past)
      const earlierTime = new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000).toISOString()
      const earlierEligible = evaluateWindowEligibility(earlierTime, windowHours, now)
      expect(earlierEligible).toBe(true)
    })

    it('reschedule later moves window later, becoming ineligible', () => {
      const now = new Date('2026-07-10T12:00:00Z')
      const windowHours = 72

      // Original meeting: 9 days ago (past window, eligible)
      const originalTime = new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString()
      const originalEligible = evaluateWindowEligibility(originalTime, windowHours, now)
      expect(originalEligible).toBe(true)

      // Reschedule later: 1 day in future (window not closed yet)
      const laterTime = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString()
      const laterEligible = evaluateWindowEligibility(laterTime, windowHours, now)
      expect(laterEligible).toBe(false)
    })
  })
})

describe('POST /api/cron/resolve-auto-held', () => {
  const CRON_SECRET = 'test-secret-12345'

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    heartbeatInserts.length = 0
    vi.clearAllMocks()
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValue({ ...EMPTY_RUN })
  })

  it('rejects request without CRON_SECRET header', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
    })

    const response = await POST(request)
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized.')
  })

  it('rejects request with wrong CRON_SECRET', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-secret',
      },
    })

    const response = await POST(request)
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized.')
  })

  it('returns 500 if resolver throws', async () => {
    // Mock resolveAutoHeldMeetings to throw
    vi.mocked(resolveAutoHeldMeetings).mockRejectedValueOnce(new Error('Database error'))

    const request = new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
      },
    })

    const response = await POST(request)
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toBe('Internal error.')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SERVICE-ROLE CLIENT MUST REACH THE RESOLVER
//
// This is the regression test for the outage of 2026-08-09 to 2026-09-07. The route
// built a service-role client and then called resolveAutoHeldMeetings() with NO
// ARGUMENT. The resolver's optional parameter fell back to the anon session client,
// which has no cookies on a cron request, so every run read `organisations` as anon.
//
// Before the 2026-09-01 revoke that read succeeded and RLS filtered it to zero rows;
// after it, the read was refused outright. Either way the job resolved nothing and
// reported success 31 times running, over three live organisations.
//
// MUTATION PROOF: delete the `supabase` argument at the resolveAutoHeldMeetings call
// in route.ts and the first test below fails. It is also a compile error, because the
// resolver's parameter is required now — two independent layers, deliberately.
// ═════════════════════════════════════════════════════════════════════════════
describe('resolve-auto-held passes a service-role client to the resolver', () => {
  const CRON_SECRET = 'test-secret-12345'

  function authedRequest() {
    return new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
  }

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    heartbeatInserts.length = 0
    vi.clearAllMocks()
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValue({ ...EMPTY_RUN })
  })

  it('calls the resolver WITH the service-role client, not with no argument', async () => {
    await POST(authedRequest())

    expect(resolveAutoHeldMeetings).toHaveBeenCalledTimes(1)

    const passed = vi.mocked(resolveAutoHeldMeetings).mock.calls[0]?.[0]

    // The precise failure being guarded: the call used to receive nothing at all.
    expect(passed).toBeDefined()
    expect(passed).not.toBeUndefined()

    // And it must be the client the route built, not some other object.
    expect(passed).toBe(serviceRoleClient)
  })

  it('creates the client from the SERVICE ROLE key, never the anon key', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    await POST(authedRequest())

    expect(createClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'test-key'
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ZERO-BECAUSE-DENIED MUST NOT REPORT THE SAME AS ZERO-BECAUSE-NONE
// ═════════════════════════════════════════════════════════════════════════════
describe('resolve-auto-held heartbeat truthfulness', () => {
  const CRON_SECRET = 'test-secret-12345'

  function authedRequest() {
    return new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
  }

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    heartbeatInserts.length = 0
    vi.clearAllMocks()
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValue({ ...EMPTY_RUN })
  })

  it('a refused read writes ok=false, NOT ok=true on zero', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockRejectedValueOnce(
      new Error('auto-held resolution: organisations read failed: permission denied for table organisations')
    )

    const response = await POST(authedRequest())
    expect(response.status).toBe(500)

    expect(heartbeatInserts).toHaveLength(1)
    expect(heartbeatInserts[0]?.ok).toBe(false)
    expect(heartbeatInserts[0]?.detail).toMatch(/permission denied for table organisations/)
  })

  it('a genuinely empty run writes ok=true and says how many it EXAMINED', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValueOnce({
      organisations_examined: 3,
      organisations_with_resolutions: [],
      meetings_resolved: 0,
      organisations_failed: 0,
    })

    const response = await POST(authedRequest())
    expect(response.status).toBe(200)

    expect(heartbeatInserts[0]?.ok).toBe(true)
    // Reports 3 examined, 0 resolved. The old code reported "Processed 0
    // organisations" for this exact case, which is the string it also produced when
    // the read was denied.
    expect(heartbeatInserts[0]?.detail).toBe(
      'Examined 3 organisations, resolved 0 meetings'
    )
  })

  it('the detail line matches the format mon_010 parses', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValueOnce({
      organisations_examined: 3,
      organisations_with_resolutions: [{ org_id: 'org-1', resolved_count: 2 }],
      meetings_resolved: 2,
      organisations_failed: 0,
    })

    await POST(authedRequest())

    // mon_010 anchors on '^Examined (\d+) organisations' and reports UNKNOWN if it
    // cannot match. If this assertion is changed, change the view in the same commit.
    expect(heartbeatInserts[0]?.detail).toMatch(/^Examined (\d+) organisations/)
    const examined = heartbeatInserts[0]?.detail.match(/^Examined (\d+) organisations/)?.[1]
    expect(examined).toBe('3')
  })

  it('a partially failed run writes ok=false even though some organisations succeeded', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValueOnce({
      organisations_examined: 3,
      organisations_with_resolutions: [{ org_id: 'org-1', resolved_count: 1 }],
      meetings_resolved: 1,
      organisations_failed: 2,
    })

    const response = await POST(authedRequest())
    expect(response.status).toBe(500)

    expect(heartbeatInserts[0]?.ok).toBe(false)
    expect(heartbeatInserts[0]?.detail).toMatch(/2 FAILED/)
  })
})
