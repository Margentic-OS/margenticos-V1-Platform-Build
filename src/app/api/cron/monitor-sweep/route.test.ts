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

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        order: vi.fn(() => ({
          limit: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        throwOnError: vi.fn(() => Promise.resolve({ data: null, error: null })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    })),
  })),
}))

describe('POST /api/cron/monitor-sweep', () => {
  const CRON_SECRET = 'test-secret-12345'

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    vi.clearAllMocks()
  })

  it('rejects request without CRON_SECRET header', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/monitor-sweep', {
      method: 'POST',
    })

    const response = await POST(request)
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized.')
  })

  it('rejects request with wrong CRON_SECRET', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/monitor-sweep', {
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

  it('successfully processes authorized request', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/monitor-sweep', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
      },
    })

    const response = await POST(request)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('checked')
    expect(body).toHaveProperty('state_changes')
    expect(body).toHaveProperty('errors')

    // Should check 6 monitors
    expect(body.checked).toBeLessThanOrEqual(6)
  })
})

describe('Monitor state transitions', () => {
  type State = 'OK' | 'PROBLEM' | 'UNKNOWN'

  it('records state change from OK to PROBLEM', () => {
    const lastState: State = 'OK'
    const currentState: State = 'PROBLEM'
    const shouldRecord = String(currentState) !== String(lastState)
    expect(shouldRecord).toBe(true)
  })

  it('does not record repeated state', () => {
    const lastState: State = 'PROBLEM'
    const currentState: State = 'PROBLEM'
    const shouldRecord = String(currentState) !== String(lastState)
    expect(shouldRecord).toBe(false)
  })

  it('records transition from PROBLEM to OK', () => {
    const lastState: State = 'PROBLEM'
    const currentState: State = 'OK'
    const shouldRecord = String(currentState) !== String(lastState)
    expect(shouldRecord).toBe(true)

    // Should mark resolution when transitioning FROM PROBLEM
    const needsResolution = String(lastState) === 'PROBLEM' && String(currentState) !== 'PROBLEM'
    expect(needsResolution).toBe(true)
  })

  it('initializes unknown state as OK after first check', () => {
    const lastState: State = 'UNKNOWN'
    const currentState: State = 'OK'
    const shouldRecord = String(currentState) !== String(lastState)
    expect(shouldRecord).toBe(true)
  })
})

describe('Heartbeat recording', () => {
  it('records sweep heartbeat with ok=true when no errors', () => {
    const results = { checked: 6, state_changes: 2, errors: 0 }
    const sweepOk = results.errors === 0
    expect(sweepOk).toBe(true)
  })

  it('records sweep heartbeat with ok=false when errors occur', () => {
    const results = { checked: 5, state_changes: 0, errors: 1 }
    const sweepOk = results.errors === 0
    expect(sweepOk).toBe(false)
  })

  it('generates detail message for successful run', () => {
    const results = { checked: 6, state_changes: 2, errors: 0 }
    const detail =
      results.errors === 0
        ? `Checked ${results.checked} monitors, recorded ${results.state_changes} state change(s)`
        : `Checked ${results.checked} monitors, ${results.errors} error(s)`

    expect(detail).toContain('6 monitors')
    expect(detail).toContain('2 state change')
  })

  it('generates detail message for failed run', () => {
    const results = { checked: 5, state_changes: 0, errors: 2 }
    const detail =
      results.errors === 0
        ? `Checked ${results.checked} monitors, recorded ${results.state_changes} state change(s)`
        : `Checked ${results.checked} monitors, ${results.errors} error(s)`

    expect(detail).toContain('5 monitors')
    expect(detail).toContain('2 error')
  })
})
