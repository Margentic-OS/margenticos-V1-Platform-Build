// The cascade's eligibility check fails CLOSED when a count fails.
//
// isEligible() returns true only when the target document has no active version and no
// pending suggestion. Until 2026-09-15 it read those two counts as `count ?? 0`, so a
// refused or timed-out read became zero, zero read as "nothing exists yet", and the
// function returned ELIGIBLE.
//
// The consequence was not a wrong number on a screen. It was dispatching a
// document-generation agent for a document that may already exist: a paid model call, and
// a race with the run already in flight. The failure pointed at doing MORE work, which is
// the expensive direction.
//
// Every test asserts NO DISPATCH WAS SENT, not merely that something was logged. "It
// logged an error" and "it did not spend a model call" are different claims and only the
// second is the one that matters.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { triggerCascadeIfEligible } from '../trigger-cascade'
import { logger } from '@/lib/logger'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type TableResult = { count: number | null; error: { message: string } | null }

/**
 * A fake that honours the ONE thing these tests are about: which table was asked, and what
 * that read returned. It deliberately THROWS on any method it does not implement rather
 * than returning itself, because a fake that silently swallows a call it was not written
 * for is how a guard stops being covered without any test going red (CLAUDE.md).
 */
function fakeSupabase(byTable: Record<string, TableResult>): SupabaseClient {
  const from = (table: string) => {
    const result = byTable[table]
    if (!result) throw new Error(`fake: no result configured for table "${table}"`)
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in']) {
      chain[method] = () => chain
    }
    chain.then = (res: (v: TableResult) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej)
    return chain
  }
  return { from } as unknown as SupabaseClient
}

const ORG = '00000000-0000-4000-8000-000000000001'

describe('triggerCascadeIfEligible when an eligibility count fails', () => {
  beforeEach(() => {
    process.env.NEXT_INTERNAL_SECRET = 'test-internal-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test'
    vi.mocked(logger.error).mockClear()
  })

  afterEach(() => {
    delete process.env.NEXT_INTERNAL_SECRET
    delete process.env.NEXT_PUBLIC_APP_URL
    vi.restoreAllMocks()
  })

  it('dispatches nothing when the ACTIVE-document count fails', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const supabase = fakeSupabase({
      // The shape the bug turned into zero.
      strategy_documents: { count: null, error: { message: 'canceling statement due to statement timeout' } },
      document_suggestions: { count: 0, error: null },
    })

    await triggerCascadeIfEligible(supabase, ORG, 'icp')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.mocked(logger.error)).toHaveBeenCalled()
  })

  it('dispatches nothing when the PENDING-suggestion count fails', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const supabase = fakeSupabase({
      strategy_documents: { count: 0, error: null },
      document_suggestions: { count: null, error: { message: 'connection reset by peer' } },
    })

    await triggerCascadeIfEligible(supabase, ORG, 'icp')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.mocked(logger.error)).toHaveBeenCalled()
  })

  it('keeps the contract that the entry point never throws at its caller', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const supabase = fakeSupabase({
      strategy_documents: { count: null, error: { message: 'boom' } },
      document_suggestions: { count: 0, error: null },
    })

    // A promotion must still return a success response to the client even when the
    // best-effort cascade could not run.
    await expect(triggerCascadeIfEligible(supabase, ORG, 'icp')).resolves.toBeUndefined()
  })

  it('STILL DISPATCHES when both counts genuinely succeed and report zero', async () => {
    // The control. Without it, a guard that refused unconditionally would pass every test
    // above and this file would be proving an outage rather than a guard.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const supabase = fakeSupabase({
      strategy_documents: { count: 0, error: null },
      document_suggestions: { count: 0, error: null },
    })

    await triggerCascadeIfEligible(supabase, ORG, 'icp')

    // icp is upstream of positioning and messaging. Messaging needs all three upstream
    // documents active and the count above says zero are, so exactly one dispatch: positioning.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/agents/positioning')
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
  })
})
