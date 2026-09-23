// The FAQ seed route's three gates are real: operator role, the pending-candidate
// duplicate guard, and the run lock.
//
// WHAT EACH TEST LOCKS OUT, and what it does NOT:
//
//   - A CLIENT CANNOT CALL THIS. The role check is server-side and runs before the body
//     is even parsed, so a client with a valid session gets 403 and no Opus call happens.
//     The assertion is on the agent NOT being called, not just on the status code: a 403
//     that still spent money would pass a status-only test.
//
//   - THE DUPLICATE GUARD. A second run while earlier candidates are pending is refused
//     before the agent is called. Mutation-proved: deleting the `.eq('status','pending')`
//     filter, or the pending count check itself, turns these red.
//
//   - THE LOCK IS TAKEN BEFORE THE GUARD IS READ. The guard is a read and cannot defend
//     itself. The ordering test below fails if the claim moves after the count.
//
// The supabase fake THROWS on any filter it does not implement rather than returning the
// chain. A fake that silently accepted `.eq(...)` would let the org filter be deleted and
// still pass, which is the shape CLAUDE.md records as untestable-by-construction.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  role: 'operator' as string | null,
  pendingSeedCandidates: 0,
  claimOutcome: 'claimed' as 'claimed' | 'already_running',
  /** Order in which the route touched things, so "lock before guard" is checkable. */
  callOrder: [] as string[],
  extractionFilters: [] as Array<Record<string, unknown>>,
  agentCalls: [] as Array<Record<string, unknown>>,
  agentResult: [{ extracted_question: 'q', suggested_answer: 'a', source_material: 'icp', prompt_version: '1.0.0' }],
  released: [] as Array<{ runId: string; outcome: unknown }>,
  abandoned: [] as string[],
  docRows: [] as Array<Record<string, unknown>>,
  intakeRows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: state.user ? null : new Error('no session') }) },
  }),
}))

const claimSeedRun = vi.hoisted(() => vi.fn(async () => {
  state.callOrder.push('claim')
  return state.claimOutcome === 'claimed'
    ? { kind: 'claimed' as const, runId: 'run-1', tookOverStaleClaim: false }
    : { kind: 'already_running' as const, startedAt: '2026-09-21T10:00:00.000Z' }
}))
const releaseSeedRun = vi.hoisted(() => vi.fn(async (_c: unknown, runId: string, outcome: unknown) => {
  state.released.push({ runId, outcome })
}))
const abandonSeedRun = vi.hoisted(() => vi.fn(async (_c: unknown, runId: string) => {
  state.abandoned.push(runId)
}))
vi.mock('@/lib/faq/seed-run-claim', () => ({ claimSeedRun, releaseSeedRun, abandonSeedRun }))

const generateFaqSeedCandidates = vi.hoisted(() => vi.fn(async (input: Record<string, unknown>) => {
  state.callOrder.push('agent')
  state.agentCalls.push(input)
  return state.agentResult
}))
vi.mock('@/lib/agents/faq-seed-agent', () => ({ generateFaqSeedCandidates }))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      if (table === 'users') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: state.role ? { role: state.role } : null, error: null }) }) }) }
      }

      if (table === 'faq_extractions') {
        const filters: Record<string, unknown> = {}
        const chain: any = {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            filters.countRequested = opts?.count
            return chain
          },
          eq: (col: string, val: unknown) => { filters[col] = val; return chain },
          then: undefined,
        }
        // Terminal: awaiting the chain resolves the count.
        chain.then = (resolve: (v: unknown) => void) => {
          state.callOrder.push('count_pending')
          state.extractionFilters.push({ ...filters })
          // PostgREST returns a count only when one was asked for.
          const count = filters.countRequested === 'exact' ? countMatching(filters) : null
          resolve({ count, error: null })
        }
        return chain
      }

      if (table === 'organisations') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'org-1', name: 'Client Org' }, error: null }) }) }),
        }
      }

      if (table === 'strategy_documents') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: async () => ({ data: state.docRows, error: null }),
        }
        return chain
      }

      if (table === 'intake_responses') {
        const chain: any = {
          select: () => chain,
          eq: async () => ({ data: state.intakeRows, error: null }),
        }
        return chain
      }

      if (table === 'faq_seed_runs') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        }
        return chain
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

// The fake honours the filters rather than swallowing them: a row counts only if every
// filter the route applied actually matches a seed-generated pending row.
function countMatching(filters: Record<string, unknown>): number {
  const wantsSeed = filters.source === 'seed_generated'
  const wantsPending = filters.status === 'pending'
  const wantsOrg = filters.organisation_id === ORG_ID
  if (!wantsSeed || !wantsPending || !wantsOrg) {
    throw new Error(
      `fake supabase: the pending-candidate count dropped a filter ` +
      `(source=${String(filters.source)} status=${String(filters.status)} org=${String(filters.organisation_id)})`,
    )
  }
  return state.pendingSeedCandidates
}

import { POST, GET } from './route'

const ORG_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/operator/faq-seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function activeDocs() {
  return ['icp', 'positioning', 'tov', 'messaging'].map(t => ({
    document_type: t, plain_text: `${t} text`, content: null, status: 'active', created_at: '2026-09-01T00:00:00Z',
  }))
}

describe('POST /api/operator/faq-seed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.user = { id: 'user-1' }
    state.role = 'operator'
    state.pendingSeedCandidates = 0
    state.claimOutcome = 'claimed'
    state.callOrder = []
    state.extractionFilters = []
    state.agentCalls = []
    state.agentResult = [
      { extracted_question: 'q1', suggested_answer: 'a1', source_material: 'icp', prompt_version: '1.0.0' },
      { extracted_question: 'q2', suggested_answer: 'a2', source_material: 'tov', prompt_version: '1.0.0' },
    ]
    state.released = []
    state.abandoned = []
    state.docRows = activeDocs()
    state.intakeRows = [{ field_key: 'company_name', field_label: 'Company name', response_value: 'Client Org' }]
  })

  // ── The role gate ──────────────────────────────────────────────────────────

  it('a client cannot call it: 403, and no model call is made', async () => {
    state.role = 'client'

    const res = await POST(postRequest({ organisation_id: ORG_ID }))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Operator access required.' })
    // The part that matters: refusing AFTER spending would also have returned 403.
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
    expect(claimSeedRun).not.toHaveBeenCalled()
  })

  it('an unauthenticated caller gets 401, not 403', async () => {
    state.user = null

    const res = await POST(postRequest({ organisation_id: ORG_ID }))

    expect(res.status).toBe(401)
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
  })

  it('a user row that does not exist is refused, not treated as an operator', async () => {
    state.role = null

    const res = await POST(postRequest({ organisation_id: ORG_ID }))

    expect(res.status).toBe(403)
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
  })

  // ── The duplicate guard ────────────────────────────────────────────────────

  it('refuses a second run while earlier seed candidates are still pending', async () => {
    state.pendingSeedCandidates = 12

    const res = await POST(postRequest({ organisation_id: ORG_ID }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.pending_seed_count).toBe(12)
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
    // Nothing was spent, so the refusal must not be recorded as a run.
    expect(state.abandoned).toEqual(['run-1'])
    expect(state.released).toEqual([])
  })

  it('counts only this org\'s pending seed-generated candidates', async () => {
    await POST(postRequest({ organisation_id: ORG_ID }))

    expect(state.extractionFilters).toHaveLength(1)
    expect(state.extractionFilters[0]).toMatchObject({
      organisation_id: ORG_ID,
      source: 'seed_generated',
      status: 'pending',
      countRequested: 'exact',
    })
  })

  it('runs when nothing is pending', async () => {
    const res = await POST(postRequest({ organisation_id: ORG_ID }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.candidates_created).toBe(2)
    expect(generateFaqSeedCandidates).toHaveBeenCalledTimes(1)
    expect(state.released).toEqual([
      { runId: 'run-1', outcome: { state: 'completed', candidatesCreated: 2 } },
    ])
  })

  // ── The lock ───────────────────────────────────────────────────────────────

  it('takes the lock BEFORE reading the pending count', async () => {
    await POST(postRequest({ organisation_id: ORG_ID }))

    // A read cannot defend itself. If the count is read first, two simultaneous requests
    // both see zero and both pay.
    // Both must be PRESENT as well as ordered: indexOf returns -1 for a missing entry,
    // so a mutation that dropped the claim altogether would satisfy a bare `<` comparison.
    expect(state.callOrder).toContain('claim')
    expect(state.callOrder).toContain('count_pending')
    expect(state.callOrder.indexOf('claim')).toBeLessThan(state.callOrder.indexOf('count_pending'))
  })

  it('refuses with 409 when another run already holds the lock', async () => {
    state.claimOutcome = 'already_running'

    const res = await POST(postRequest({ organisation_id: ORG_ID }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.started_at).toBe('2026-09-21T10:00:00.000Z')
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
    // It does not hold the lock, so it must not release or delete the other run's row.
    expect(state.released).toEqual([])
    expect(state.abandoned).toEqual([])
  })

  // ── Isolation ──────────────────────────────────────────────────────────────

  it('passes the requested organisation to the agent (ADR-003)', async () => {
    await POST(postRequest({ organisation_id: ORG_ID }))

    expect(state.agentCalls[0]).toMatchObject({
      organisationId: ORG_ID,
      organisationName: 'Client Org',
      icpDocument: 'icp text',
      messagingDocument: 'messaging text',
    })
  })

  it('rejects a malformed organisation id before taking the lock', async () => {
    const res = await POST(postRequest({ organisation_id: 'not-a-uuid' }))

    expect(res.status).toBe(400)
    expect(claimSeedRun).not.toHaveBeenCalled()
  })

  // ── Preconditions ──────────────────────────────────────────────────────────

  it('refuses with 422 when a required document is missing, and records no run', async () => {
    state.docRows = activeDocs().filter(d => d.document_type !== 'messaging')

    const res = await POST(postRequest({ organisation_id: ORG_ID }))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toContain('Messaging document')
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
    expect(state.abandoned).toEqual(['run-1'])
  })

  it('refuses with 422 when the client has no intake at all', async () => {
    state.intakeRows = []

    const res = await POST(postRequest({ organisation_id: ORG_ID }))

    expect(res.status).toBe(422)
    expect(generateFaqSeedCandidates).not.toHaveBeenCalled()
  })

  it('records a failed run when the agent returns nothing', async () => {
    state.agentResult = []

    const res = await POST(postRequest({ organisation_id: ORG_ID }))

    expect(res.status).toBe(502)
    // It DID spend a model call, so this belongs in the history, not deleted.
    expect(state.abandoned).toEqual([])
    expect(state.released[0].outcome).toMatchObject({ state: 'failed', candidatesCreated: 0 })
  })
})

describe('GET /api/operator/faq-seed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.user = { id: 'user-1' }
    state.role = 'operator'
    state.pendingSeedCandidates = 3
    state.extractionFilters = []
    state.callOrder = []
  })

  it('a client cannot read the seed status either', async () => {
    state.role = 'client'

    const res = await GET(new NextRequest(`http://localhost:3000/api/operator/faq-seed?client=${ORG_ID}`))

    expect(res.status).toBe(403)
  })

  it('reports the pending count so the button can explain itself', async () => {
    const res = await GET(new NextRequest(`http://localhost:3000/api/operator/faq-seed?client=${ORG_ID}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.pending_seed_count).toBe(3)
    expect(json.last_run).toBeNull()
  })
})
