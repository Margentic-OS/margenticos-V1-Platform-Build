// F2a: the route sends one Sentry event per failure, each fingerprinted by where it happened.
//
// The worker's own tests prove the failures are classified. This proves the route turns each
// one into its own event. Before, one event carried every failure of the run, so they all
// landed in one issue. The planted run below has three different faults; the control run has
// none and must send nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'check-in-id'),
  flush: vi.fn(async () => true),
}))
const worker = vi.hoisted(() => ({ runWorker: vi.fn() }))

vi.mock('@sentry/nextjs', () => sentry)
vi.mock('@/lib/queue/run-worker', () => ({ runWorker: worker.runWorker }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ insert: () => ({ throwOnError: async () => ({}) }) }),
  }),
}))

import { POST } from '@/app/api/cron/queue-worker/route'

function request(): NextRequest {
  return new NextRequest('http://localhost/api/cron/queue-worker', {
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' },
  })
}

const PLANTED_FAILURES = [
  { step: 'flag_unreadable', jobType: 'research', message: 'Gateway Timeout', text: 'research: Gateway Timeout' },
  { step: 'job_type_pass', jobType: 'compose', message: 'executor could not be built', text: 'compose: executor could not be built' },
  { step: 'reclaim', jobType: null, message: 'lock timeout', text: 'reclaim failed: lock timeout' },
]

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'test-cron-secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')
  sentry.captureException.mockClear()
  worker.runWorker.mockReset()
})

describe('the route captures each failure under its own fingerprint', () => {
  it('a run with three different faults sends three events, one per fingerprint', async () => {
    worker.runWorker.mockResolvedValue({
      ok: false,
      workerId: 'w-test',
      elapsedSeconds: 1,
      reclaimed: 0,
      reclaimTerminated: 0,
      byJobType: {},
      failures: PLANTED_FAILURES,
      errors: PLANTED_FAILURES.map(failure => failure.text),
    })

    await POST(request())

    expect(sentry.captureException).toHaveBeenCalledTimes(3)
    const fingerprints = sentry.captureException.mock.calls.map(
      call => (call[1] as { fingerprint: string[] }).fingerprint,
    )
    expect(fingerprints).toEqual([
      ['queue-worker', 'flag_unreadable', 'research'],
      ['queue-worker', 'job_type_pass', 'compose'],
      ['queue-worker', 'reclaim', 'none'],
    ])
  })

  it('each event keeps its own message, so the issue title names the fault rather than the last one', async () => {
    worker.runWorker.mockResolvedValue({
      ok: false, workerId: 'w-test', elapsedSeconds: 1, reclaimed: 0, reclaimTerminated: 0,
      byJobType: {}, failures: PLANTED_FAILURES, errors: PLANTED_FAILURES.map(failure => failure.text),
    })

    await POST(request())

    const messages = sentry.captureException.mock.calls.map(call => (call[0] as Error).message)
    expect(messages).toEqual([
      'Queue worker flag_unreadable: research: Gateway Timeout',
      'Queue worker job_type_pass: compose: executor could not be built',
      'Queue worker reclaim: reclaim failed: lock timeout',
    ])
  })

  it('CONTROL: a clean run sends no failure event at all', async () => {
    worker.runWorker.mockResolvedValue({
      ok: true, workerId: 'w-test', elapsedSeconds: 1, reclaimed: 0, reclaimTerminated: 0,
      byJobType: {}, failures: [], errors: [],
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(sentry.captureException).not.toHaveBeenCalled()
  })
})
