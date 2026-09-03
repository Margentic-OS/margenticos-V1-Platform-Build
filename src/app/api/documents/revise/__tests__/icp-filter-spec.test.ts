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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

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
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: function () { return this },
      eq: function () { return this },
      single: vi.fn().mockResolvedValue({ data: { organisation_id: 'test-org-id' } }),
    }),
  })),
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

const OLD_DOC = {
  id: 'old-doc-uuid',
  document_type: 'icp',
  segment_id: null,
  content: { summary: 'Before.' },
  organisation_id: 'test-org-id',
  version: '3',
}

const NEW_DOC = { id: 'new-doc-uuid', version: '4', change_summary: 'Made the summary shorter.' }

function ownershipChain() {
  return {
    select: function () { return this },
    eq: function () { return this },
    maybeSingle: vi.fn().mockResolvedValue({ data: OLD_DOC }),
  }
}

function countChain() {
  const chain: Record<string, unknown> = {}
  chain['select'] = () => chain
  chain['eq'] = () => chain
  chain['neq'] = () => chain
  chain['gte'] = () => chain
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ count: 0, error: null }).then(resolve)
  return chain
}

let strategyDocCalls = 0
const rpc = vi.fn().mockResolvedValue({ data: NEW_DOC, error: null })

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'strategy_documents') {
        strategyDocCalls++
        return strategyDocCalls === 1 ? ownershipChain() : countChain()
      }
      if (table === 'document_suggestions') return countChain()
      return {
        select: function () { return this },
        eq: function () { return this },
        single: vi.fn().mockResolvedValue({ data: { name: 'An organisation' } }),
      }
    },
    rpc: (...args: unknown[]) => rpc(...args),
  })),
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
  strategyDocCalls = 0
  rpc.mockResolvedValue({ data: NEW_DOC, error: null })
  persistIcpFilterSpec.mockResolvedValue(undefined)
  triggerCascadeIfEligible.mockResolvedValue(undefined)
  mockGetUser.mockResolvedValue({ data: { user: { id: 'test-user-id' } }, error: null })
})

describe('a client revision to the prospect profile derives its filter spec', () => {
  it('calls persistIcpFilterSpec with the NEW document id, and still runs the sequencer', async () => {
    const { POST } = await import('../route')
    const res = await POST(request({
      document_id: '11111111-1111-1111-1111-111111111111',
      note: 'Shorten the summary.',
    }))

    expect(res.status).toBe(200)
    expect(persistIcpFilterSpec).toHaveBeenCalledTimes(1)
    expect(persistIcpFilterSpec.mock.calls[0][1]).toBe(NEW_DOC.id)
    expect(persistIcpFilterSpec.mock.calls[0][1]).not.toBe(OLD_DOC.id)

    // The spec derivation was inserted into the same after() block the cascade already
    // occupied. Both must run: a fix that quietly replaced one deferred call with another
    // would pass the assertion above and break first-generation for new clients.
    expect(triggerCascadeIfEligible).toHaveBeenCalledTimes(1)
    expect(triggerCascadeIfEligible.mock.calls[0][2]).toBe('icp')
  })

})
