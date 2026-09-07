// The process-replies cron must report the outcome it actually had.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS CLOSES
//
// The route computed `heartbeatOk` from result.errors, wrote it correctly to
// cron_heartbeats, and then stamped the Sentry check-in with a hardcoded 'ok' and
// returned a hardcoded `ok: true`. So no Sentry alert could ever fire for a failing
// reply-processing run.
//
// instantly-poll carried the identical defect and fixed it. Its comment reads:
// "Previously the heartbeat used it and the other two were hardcoded to success, so a
// run that failed every call still read green." The fix was never applied here.
//
// It matters more than the duplicated heartbeat suggests. MON-003 reads only the LATEST
// heartbeat row, so a failing run reddens the board for one cycle and the next clean run
// clears it. Sentry is the instrument that persists across runs, and it was the one being
// handed a comfortable lie.
//
// MUTATION PROOF: put `status: 'ok'` back in the captureCheckIn call, or `ok: true` back
// in the response, and the correspondingly named test here goes red.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const processRepliesMock = vi.hoisted(() => vi.fn())
const heartbeatInserts = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'checkin-id'),
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/reply-handling/process-reply', () => ({
  processReplies: processRepliesMock,
}))

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
}))

vi.mock('@/lib/supabase/service-role', () => ({
  asServiceRoleClient: (c: unknown) => c,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'cron_heartbeats') {
        return {
          insert: (row: Record<string, unknown>) => {
            heartbeatInserts.push(row)
            return { throwOnError: () => Promise.resolve({ error: null }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import * as Sentry from '@sentry/nextjs'
import { POST } from './route'

function request(): Request {
  return new Request('https://example.com/api/cron/process-replies', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
  })
}

function checkInStatuses(): string[] {
  return vi.mocked(Sentry.captureCheckIn).mock.calls
    .map(call => (call[0] as { status: string }).status)
}

describe('process-replies reports its real outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    heartbeatInserts.length = 0
    vi.stubEnv('CRON_SECRET', 'test-secret')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('stamps the Sentry check-in ERROR when a run had errors', async () => {
    processRepliesMock.mockResolvedValue({ processed: 0, skipped: 0, errors: 3 })

    await POST(request() as never)

    // The first check-in is the in_progress one. The last carries the outcome.
    expect(checkInStatuses().at(-1)).toBe('error')
  })

  it('returns ok:false in the body when a run had errors', async () => {
    processRepliesMock.mockResolvedValue({ processed: 0, skipped: 0, errors: 3 })

    const response = await POST(request() as never)
    const body = await response.json()

    expect(body.ok).toBe(false)
  })

  it('raises a Sentry exception naming the error count', async () => {
    processRepliesMock.mockResolvedValue({ processed: 1, skipped: 0, errors: 2 })

    await POST(request() as never)

    const captured = vi.mocked(Sentry.captureException).mock.calls
    expect(captured).toHaveLength(1)
    expect((captured[0][0] as Error).message).toContain('2 error(s)')
  })

  it('still reports ok on a clean run, so the check is not simply always red', async () => {
    // The positive control. A guard that fails everything is an outage, not a control.
    processRepliesMock.mockResolvedValue({ processed: 5, skipped: 0, errors: 0 })

    const response = await POST(request() as never)
    const body = await response.json()

    expect(checkInStatuses().at(-1)).toBe('ok')
    expect(body.ok).toBe(true)
    expect(vi.mocked(Sentry.captureException).mock.calls).toHaveLength(0)
  })

  it('writes the same verdict to the database heartbeat', async () => {
    // The heartbeat was already correct. Asserted so a future change cannot fix one
    // instrument by breaking the other: the whole defect was two instruments disagreeing.
    processRepliesMock.mockResolvedValue({ processed: 0, skipped: 0, errors: 1 })

    await POST(request() as never)

    expect(heartbeatInserts).toHaveLength(1)
    expect(heartbeatInserts[0].ok).toBe(false)
    expect(heartbeatInserts[0].job_name).toBe('process-replies')
  })
})
