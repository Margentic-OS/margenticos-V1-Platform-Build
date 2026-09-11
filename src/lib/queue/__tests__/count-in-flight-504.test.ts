// THE BLANK ERROR, reproduced through the real client rather than a fake.
//
// countInFlight is a HEAD request. When Supabase's gateway cuts one with a 504 the response
// has no body, postgrest-js builds error.message from the body, and the thrown error read
// "countInFlight failed: " with nothing after the colon. Measured 2026-09-11: 14 of the 32
// events in Sentry MARGENTICOS-15 were that blank message.
//
// A hand-written fake cannot prove this, because the blank message is produced INSIDE
// postgrest-js. So this builds a real supabase-js client whose fetch answers every request
// with an empty 504, and runs the production function against it.

import { describe, it, expect, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { countInFlight } from '../job-queue'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function clientAnsweringEmpty504() {
  const calls: { method: string; url: string }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input) })
    return new Response(null, { status: 504, statusText: 'Gateway Timeout' })
  })
  const client = createClient('https://example.supabase.co', 'test-anon-key', {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return { client, calls }
}

describe('countInFlight against a real client and an empty 504', () => {
  it('CONTROL: the library really does hand back a blank message for this request', async () => {
    // If this ever stops being true, the test below is no longer testing the defect.
    const { client, calls } = clientAnsweringEmpty504()
    const result = await client
      .from('job_queue')
      .select('id', { count: 'exact', head: true })
      .eq('job_type', 'research')
      .eq('state', 'claimed')

    expect(calls[0]?.method).toBe('HEAD')
    expect(result.status).toBe(504)
    expect(result.error?.message).toBe('')
  })

  it('names the 504 in the error it throws', async () => {
    const { client, calls } = clientAnsweringEmpty504()

    await expect(countInFlight(client, 'research'))
      .rejects.toThrow(/^countInFlight failed: HTTP 504 Gateway Timeout/)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('HEAD')
  })
})
