import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

// Mock dependencies
vi.mock('@/lib/meetings/auto-held-resolution', () => ({
  resolveAutoHeldMeetings: vi.fn(),
}))

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

import { resolveAutoHeldMeetings } from '@/lib/meetings/auto-held-resolution'

describe('POST /api/cron/resolve-auto-held', () => {
  const CRON_SECRET = 'test-secret-12345'

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
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

  it('accepts request with valid CRON_SECRET', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValueOnce([
      { resolved_count: 3, org_id: 'org-123' },
      { resolved_count: 1, org_id: 'org-456' },
    ])

    const request = new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
      },
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.results.organisations_processed).toBe(2)
    expect(body.results.meetings_resolved).toBe(4)
  })

  it('handles resolver returning empty results', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockResolvedValueOnce([])

    const request = new NextRequest('http://localhost:3000/api/cron/resolve-auto-held', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
      },
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.results.organisations_processed).toBe(0)
    expect(body.results.meetings_resolved).toBe(0)
  })

  it('returns 500 if resolver throws', async () => {
    vi.mocked(resolveAutoHeldMeetings).mockRejectedValueOnce(
      new Error('Database connection failed')
    )

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
    expect(body.detail).toContain('Database connection failed')
  })
})
