// A 504 ON A READ IS RETRIED ONCE. NOTHING ELSE CHANGES.
//
// The installed postgrest-js retries only on 503, 520 and network errors, and only for
// GET, HEAD and OPTIONS. Supabase's API gateway has been cutting about 1% of requests at
// five seconds since September 2026, answering 504, which the library does not retry. The
// local patch (patches/@supabase+postgrest-js+2.103.2.patch) adds 504 for those same read
// methods, once, after a short jittered wait.
//
// Every test runs the REAL supabase-js client with a stubbed fetch, so what is exercised is
// the patched library as installed, not a copy of its logic. The one thing a hand-written
// fake could not show is the thing that matters: which requests the library sends again.
//
// The writes are the point of half of these tests. A 504 means the gateway stopped
// waiting, not that the database did nothing, so a write must never be sent twice.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { countInFlight } from '@/lib/queue/job-queue'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

interface Answer {
  status: number
  body?: string | null
  headers?: Record<string, string>
}

const JSON_504: Answer = {
  status: 504,
  body: '{"message":"Gateway Timeout"}',
  headers: { 'content-type': 'application/json' },
}
// What a cut HEAD count looks like: no body at all.
const EMPTY_504: Answer = { status: 504, body: null }
const ROWS_200: Answer = {
  status: 200,
  body: '[{"id":1}]',
  headers: { 'content-type': 'application/json', 'content-range': '0-0/1' },
}
const COUNT_200: Answer = { status: 200, body: null, headers: { 'content-range': '*/3' } }

function clientAnswering(answers: Answer[]) {
  const calls: { method: string; retryCount: string | null; at: number }[] = []
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      retryCount: new Headers(init?.headers).get('X-Retry-Count'),
      at: Date.now(),
    })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers })
  })
  const client = createClient('https://example.supabase.co', 'test-anon-key', {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return { client, calls }
}

describe('a 504 on a read is retried once', () => {
  it('GET: retried once, after a short wait, and the second answer is returned', async () => {
    const { client, calls } = clientAnswering([JSON_504, ROWS_200])
    const result = await client.from('things').select('id')

    expect(result.error).toBeNull()
    expect(result.data).toEqual([{ id: 1 }])
    expect(calls).toHaveLength(2)
    expect(calls[1].retryCount).toBe('1')
    const waited = calls[1].at - calls[0].at
    expect(waited).toBeGreaterThanOrEqual(240)
    expect(waited).toBeLessThan(1500)
  })

  it('HEAD count: retried once, and the count comes back rather than a blank error', async () => {
    const { client, calls } = clientAnswering([EMPTY_504, COUNT_200])
    const result = await client.from('things').select('id', { count: 'exact', head: true })

    expect(result.error).toBeNull()
    expect(result.count).toBe(3)
    expect(calls.map(c => c.method)).toEqual(['HEAD', 'HEAD'])
  })
})

describe('a 504 on a write is NEVER retried', () => {
  it('POST through an RPC: one attempt, and the 504 is reported', async () => {
    const { client, calls } = clientAnswering([JSON_504, ROWS_200])
    const result = await client.rpc('some_function', { p_value: 1 })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(result.status).toBe(504)
    expect(result.error).not.toBeNull()
  })

  it('insert (POST), update (PATCH) and delete (DELETE): one attempt each', async () => {
    const writes = [
      (c: ReturnType<typeof clientAnswering>['client']) => c.from('things').insert({ id: 1 }),
      (c: ReturnType<typeof clientAnswering>['client']) => c.from('things').update({ id: 2 }).eq('id', 1),
      (c: ReturnType<typeof clientAnswering>['client']) => c.from('things').delete().eq('id', 1),
    ]
    const methods: string[] = []

    for (const write of writes) {
      const { client, calls } = clientAnswering([JSON_504, ROWS_200])
      const result = await write(client)
      expect(calls).toHaveLength(1)
      expect(result.status).toBe(504)
      methods.push(calls[0].method)
    }

    expect(methods).toEqual(['POST', 'PATCH', 'DELETE'])
  })
})

describe('nothing else is widened', () => {
  it('a 403 on a read is not retried', async () => {
    const { client, calls } = clientAnswering([
      { status: 403, body: '{"message":"permission denied"}', headers: { 'content-type': 'application/json' } },
      ROWS_200,
    ])
    const result = await client.from('things').select('id')

    expect(calls).toHaveLength(1)
    expect(result.error?.message).toBe('permission denied')
  })

  it('the per-request opt-out still works: .retry(false) makes one attempt', async () => {
    const { client, calls } = clientAnswering([JSON_504, ROWS_200])
    const result = await client.from('things').select('id').retry(false)

    expect(calls).toHaveLength(1)
    expect(result.status).toBe(504)
  })

  it('CONTROL: the library\'s own 503 retry is untouched', async () => {
    const { client, calls } = clientAnswering([{ status: 503, headers: { 'Retry-After': '0' } }, ROWS_200])
    const result = await client.from('things').select('id')

    expect(calls).toHaveLength(2)
    expect(result.data).toEqual([{ id: 1 }])
  })
})

describe('when the retry also fails', () => {
  it('a read gets exactly two attempts, then an ERROR, never an empty list', async () => {
    // A third answer that would succeed, so a policy that retried more than once would pass
    // everything below except the call count.
    const { client, calls } = clientAnswering([JSON_504, JSON_504, ROWS_200])
    const result = await client.from('things').select('id')

    expect(calls).toHaveLength(2)
    expect(result.status).toBe(504)
    expect(result.error).not.toBeNull()
    expect(result.data).toBeNull()
  })

  it('a count gets an ERROR and a null count, never a quiet zero', async () => {
    const { client, calls } = clientAnswering([EMPTY_504, EMPTY_504, COUNT_200])
    const result = await client.from('things').select('id', { count: 'exact', head: true })

    expect(calls).toHaveLength(2)
    expect(result.error).not.toBeNull()
    expect(result.count).toBeNull()
  })

  it('a caller that checks the error raises: countInFlight rejects after two attempts', async () => {
    const { client, calls } = clientAnswering([EMPTY_504, EMPTY_504, COUNT_200])

    await expect(countInFlight(client, 'research')).rejects.toThrow(/countInFlight failed/)
    expect(calls).toHaveLength(2)
  })
})

describe('the patch is actually installed', () => {
  it('both builds the package ships carry it, at the version it was written for', () => {
    const dir = join(process.cwd(), 'node_modules', '@supabase', 'postgrest-js')
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    expect(version).toBe('2.103.2')
    for (const build of ['dist/index.cjs', 'dist/index.mjs']) {
      expect(readFileSync(join(dir, build), 'utf8'), build).toContain('LOCAL PATCH: retry-504-on-reads')
    }
  })
})
