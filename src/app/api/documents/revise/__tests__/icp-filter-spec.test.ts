// THE REGRESSION THIS FILE EXISTS FOR.
//
// /api/documents/revise promoted a new ICP and never derived its filter spec. The
// approval path did. So a client revising their own prospect profile produced a live ICP
// with icp_filter_spec NULL, permanently, and sourcing then failed on it with no
// explanation of why this document was different from the last one.
//
// Measured on production 2026-09-03 before the fix: every active ICP with update_trigger
// 'client_revision' had a NULL spec, and every one from the suggestion path had a
// populated one. A clean split along the code path.
//
// The assertion is that persistIcpFilterSpec is called with the id of the NEW document,
// not the one that was revised. Passing the old id would derive a spec from stale content
// and write it to a row that is already archived, which is the version of this fix that
// would look right and do nothing.
//
// ─── WHAT CHANGED HERE, 2026-09-07 ───────────────────────────────────────────
//
// The doubles returned OLD_DOC for any filter, so this file passed without the lookup
// having matched anything. It now runs against a fake that honours filters and is seeded
// with the document being revised, so the route has to find it before any of the
// assertions below are reached. See fake-supabase.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeSupabase, type Row } from './fake-supabase'

const ORG = '22222222-2222-2222-2222-222222222222'
const OLD_DOC_ID = '11111111-1111-1111-1111-111111111111'
const NEW_DOC_ID = '99999999-9999-9999-9999-999999999999'
const USER = 'the-signed-in-user'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: vi.fn().mockResolvedValue({ run_id: 'r', complete: vi.fn(), fail: vi.fn() }),
}))

vi.mock('@/lib/agents/revision/run-revision', async () => {
  const actual = await vi.importActual('@/lib/agents/revision/run-revision')
  return {
    ...(actual as object),
    runDocumentRevisionAgent: vi.fn().mockResolvedValue({
      revised_content: { summary: 'Revised.' },
      change_summary: 'Made the summary shorter.',
    }),
  }
})

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))

// after() runs its callback immediately, so the test can observe work the route
// deliberately defers past the response.
vi.mock('next/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, after: (fn: () => Promise<unknown>) => fn() }
})

const mockGetUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}))

const persistIcpFilterSpec = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/sourcing/persist-icp-filter-spec', () => ({
  persistIcpFilterSpec: (...args: unknown[]) => persistIcpFilterSpec(...args),
}))

const triggerCascadeIfEligible = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/agents/cascade/trigger-cascade', () => ({
  triggerCascadeIfEligible: (...args: unknown[]) => triggerCascadeIfEligible(...args),
}))

vi.mock('@/lib/email/send', () => ({
  sendTransactionalEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'm' }),
}))

const NEW_DOC = { id: NEW_DOC_ID, version: '4', change_summary: 'Made the summary shorter.' }

let fake: ReturnType<typeof makeFakeSupabase>
const rpcCalls: Array<{ fn: string; args: Row }> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => fake.client),
}))

function request(body: unknown) {
  return new NextRequest('http://localhost/api/documents/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls.length = 0
  persistIcpFilterSpec.mockResolvedValue(undefined)
  triggerCascadeIfEligible.mockResolvedValue(undefined)
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })

  fake = makeFakeSupabase({
    tables: {
      users: [{ id: USER, role: 'client', organisation_id: ORG }],
      strategy_documents: [{
        id: OLD_DOC_ID, organisation_id: ORG, document_type: 'icp',
        status: 'active', segment_id: null, version: '3',
        content: { summary: 'Before.' },
        update_trigger: 'signal_suggestion',
        created_at: '2020-01-01T00:00:00.000Z',
      }],
      document_suggestions: [],
      organisations: [{ id: ORG, name: 'An organisation' }],
    },
    rpc: (fn, args) => {
      rpcCalls.push({ fn, args })
      return { data: NEW_DOC, error: null }
    },
  })
})

describe('a client revision to the prospect profile derives its filter spec', () => {
  it('calls persistIcpFilterSpec with the NEW document id, and still runs the sequencer', async () => {
    const { POST } = await import('../route')
    const res = await POST(request({
      document_id: OLD_DOC_ID,
      note: 'Shorten the summary.',
    }))

    expect(res.status).toBe(200)
    expect(persistIcpFilterSpec).toHaveBeenCalledTimes(1)
    expect(persistIcpFilterSpec.mock.calls[0][1]).toBe(NEW_DOC.id)
    expect(persistIcpFilterSpec.mock.calls[0][1]).not.toBe(OLD_DOC_ID)

    // The spec derivation was inserted into the same after() block the cascade already
    // occupied. Both must run: a fix that quietly replaced one deferred call with another
    // would pass the assertion above and break first-generation for new clients.
    expect(triggerCascadeIfEligible).toHaveBeenCalledTimes(1)
    expect(triggerCascadeIfEligible.mock.calls[0][2]).toBe('icp')
  })

})
