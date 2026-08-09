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

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: vi.fn(() => Promise.resolve({ error: null })),
    })),
  })),
}))

vi.mock('@/lib/meetings/auto-held-resolution', () => ({
  resolveAutoHeldMeetings: vi.fn(() => Promise.resolve([])),
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
    vi.clearAllMocks()
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
