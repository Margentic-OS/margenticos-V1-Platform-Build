// The ceiling on a Supabase call, and the two clients that must carry it.
//
// Before 2026-09-07 nothing in this codebase bounded a Supabase call: no AbortSignal, no
// maxDuration on any dashboard route, no timeout of any kind. A read that opened a
// connection and never answered ran until the 300s function timeout cut the response,
// which the user sees as a blank page and the platform logs as the HTTP 200 it already
// sent.
//
// These tests assert the WIRING, not a rendered result. A test that renders a dashboard
// with a fast fake passes identically with and without the timeout, which is exactly the
// mutation this file exists to catch: delete `global: { fetch: ... }` and something must
// go red.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchWithTimeout,
  serviceReadSignal,
  SESSION_READ_TIMEOUT_MS,
  SERVICE_READ_TIMEOUT_MS,
} from '@/lib/supabase/read-timeout'

describe('fetchWithTimeout', () => {
  it('passes an AbortSignal to the underlying fetch', async () => {
    const base = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('{}'))
    await fetchWithTimeout(1000, base as unknown as typeof fetch)('https://example.test')
    expect(base).toHaveBeenCalledOnce()
    const init = base.mock.calls[0][1] as RequestInit
    expect(init.signal, 'no signal was attached, so nothing bounds the call').toBeInstanceOf(AbortSignal)
  })

  it('actually aborts once the timeout elapses', async () => {
    // A signal that is merely present proves nothing. This proves it fires.
    const base = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await expect(
      fetchWithTimeout(20, base as unknown as typeof fetch)('https://example.test'),
    ).rejects.toThrow('aborted')
  })

  it('does not discard a signal the caller already passed', async () => {
    // Composing rather than replacing. Overwriting init.signal would silently break every
    // caller-side cancellation in the codebase, and no test of the timeout alone notices.
    const base = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const caller = new AbortController()
    const promise = fetchWithTimeout(60_000, base as unknown as typeof fetch)(
      'https://example.test',
      { signal: caller.signal },
    )
    caller.abort()
    await expect(promise).rejects.toThrow('aborted')
  })

  it('keeps the session ceiling ABOVE the database statement_timeout', () => {
    // Read back from pg_roles on 2026-09-07: authenticated = 8s, service_role = none.
    // The session ceiling must sit above 8s so it can only fire on a network fault and
    // never part-way through a statement, which is what makes it safe on writes.
    expect(SESSION_READ_TIMEOUT_MS).toBeGreaterThan(8_000)
    expect(SERVICE_READ_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('serviceReadSignal returns a signal that is not already aborted', () => {
    expect(serviceReadSignal().aborted).toBe(false)
  })
})

describe('the clients that must carry a ceiling', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('the SSR session client is bounded, which is what covers the pages this session may not edit', () => {
    const src = read('src/lib/supabase/server.ts')
    expect(
      src,
      'createClient in src/lib/supabase/server.ts no longer passes a bounded fetch. This ' +
      'is the ONLY thing bounding the 19 session reads in (client)/layout.tsx and ' +
      '(client)/page.tsx, which are not edited here.',
    ).toMatch(/global:\s*\{\s*fetch:\s*fetchWithTimeout\(/)
  })

  it('the client-facing metrics chokepoint builds a bounded service-role client', () => {
    const src = read('src/lib/metrics/get-client-visible-campaign-metrics.ts')
    expect(
      src,
      'service_role has NO statement_timeout in the database, so without this these four ' +
      'reads have no ceiling on either side of the connection.',
    ).toMatch(/global:\s*\{\s*fetch:\s*fetchWithTimeout\(/)
  })

  it('leaves createServiceRoleClient unbounded, deliberately', () => {
    // The job queue, the agents and the batch sweeps use this client for work that is
    // legitimately slow. A blanket ceiling here would abort real work, so the timeout goes
    // on the reads a person is waiting on and nowhere else. Pinned so that "add it
    // everywhere for consistency" has to argue with this comment first.
    const src = read('src/lib/supabase/service-role.ts')
    expect(src).not.toMatch(/fetchWithTimeout/)
  })
})
