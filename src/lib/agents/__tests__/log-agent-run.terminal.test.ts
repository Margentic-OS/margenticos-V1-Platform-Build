// agent_runs must never record a run as both completed and failed.
//
// THE ROW THIS EXISTS TO PREVENT, observed 2026-08-19 on a real messaging run:
//
//   status='completed', duration_ms=543614,
//   output_summary='Generated 3/4 variants... Total API calls: 19.',
//   error_message='...exceeded 240s timeout guard...'
//
// complete() and fail() wrote disjoint column sets on the same row, so the second writer
// changed `status` without touching the first writer's detail column. The run reported
// success while carrying its own failure message.
//
// BOTH ORDERINGS ARE TESTED. fail-then-complete is the ordering that actually shipped
// (guard fires at 240s, work finishes at 543s). complete-then-fail is the mirror, which a
// catch block running after a late abort could produce. A guard that only holds one way
// round is not a guard.
//
// These assert on the UPDATE PAYLOADS the helper sends, because that is where the defect
// lived. Asserting the function returned would have passed in both worlds.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted above ordinary consts, so the shared state has to be too.
const h = vi.hoisted(() => ({
  warn: vi.fn(),
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: h.warn, debug: vi.fn() },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: 'run-1' }, error: null }) }),
      }),
      update: (payload: Record<string, unknown>) => {
        h.updates.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }),
  }),
}))

const warn = h.warn

import { startAgentRun } from '../log-agent-run'

beforeEach(() => {
  h.updates.length = 0
  warn.mockClear()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-a-secret'
})

async function newRun() {
  return startAgentRun({ organisation_id: 'org-1', agent_name: 'messaging-generation' })
}

describe('agent run terminal state', () => {
  it('fail then complete: the failure stands and the completion is ignored', async () => {
    const run = await newRun()

    await run.fail('exceeded 240s timeout guard')
    await run.complete('Generated 3/4 variants. Total API calls: 19.')

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].status).toBe('failed')
    expect(h.updates[0].error_message).toBe('exceeded 240s timeout guard')
    // The exact contradiction from the 2026-08-19 row.
    expect(h.updates[0].output_summary).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('complete then fail: the completion stands and the failure is ignored', async () => {
    const run = await newRun()

    await run.complete('Generated 4/4 variants.')
    await run.fail('late abort')

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].status).toBe('completed')
    expect(h.updates[0].output_summary).toBe('Generated 4/4 variants.')
    expect(h.updates[0].error_message).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('holds when both terminal calls are started before either awaits', async () => {
    // The real interleaving: the guard fires with complete()'s UPDATE already in flight.
    // The claim is synchronous, so exactly one caller can win regardless of scheduling.
    const run = await newRun()

    await Promise.all([
      run.fail('exceeded 240s timeout guard'),
      run.complete('Generated 3/4 variants.'),
    ])

    expect(h.updates).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a third terminal call is also ignored', async () => {
    const run = await newRun()

    await run.fail('first')
    await run.fail('second')
    await run.complete('third')

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].error_message).toBe('first')
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
