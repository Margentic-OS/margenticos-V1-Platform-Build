import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

describe('POST /api/cron/auto-approve', () => {
  const CRON_SECRET = 'test-secret-12345'

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    vi.clearAllMocks()
  })

  it('rejects request without CRON_SECRET header', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/auto-approve', {
      method: 'POST',
    })

    const response = await POST(request)
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized.')
  })

  it('rejects request with wrong CRON_SECRET', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/auto-approve', {
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
})

describe('Auto-approve window logic', () => {
  function evaluateApprovalWindow(
    createdAtMs: number,
    windowHours: number,
    nowMs: number
  ): boolean {
    const dueAt = createdAtMs + windowHours * 60 * 60 * 1000
    return dueAt <= nowMs
  }

  it('suggestion 72h old is due at 72h window', () => {
    const now = new Date('2026-07-10T12:00:00Z').getTime()
    const created = now - 72 * 60 * 60 * 1000
    const windowHours = 72

    const isDue = evaluateApprovalWindow(created, windowHours, now)
    expect(isDue).toBe(true)
  })

  it('suggestion 71h old is NOT due at 72h window', () => {
    const now = new Date('2026-07-10T12:00:00Z').getTime()
    const created = now - 71 * 60 * 60 * 1000
    const windowHours = 72

    const isDue = evaluateApprovalWindow(created, windowHours, now)
    expect(isDue).toBe(false)
  })
})
