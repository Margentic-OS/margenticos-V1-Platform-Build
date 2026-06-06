// Verifies that POST /api/documents/revise maps RevisionGateError → 422 with the
// human-readable error message DocApprovalControls will render.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { RevisionGateError } from '@/lib/agents/revision/run-revision'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: vi.fn().mockResolvedValue({
    run_id: 'test-run-id',
    complete: vi.fn(),
    fail: vi.fn(),
  }),
}))

vi.mock('@/lib/agents/revision/run-revision', async () => {
  const actual = await vi.importActual('@/lib/agents/revision/run-revision')
  return {
    ...(actual as object),
    runDocumentRevisionAgent: vi.fn().mockRejectedValue(
      new (actual as { RevisionGateError: typeof RevisionGateError }).RevisionGateError(
        ['word count 105 exceeds 100-word limit'],
        'messaging',
      ),
    ),
  }
})

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))

// Cookie client (auth)
const mockGetUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { organisation_id: 'test-org-id' } }),
    }),
  })),
}))

// Service client (data access) — two sequential calls to from('strategy_documents'):
//   call 1: ownership check (.maybeSingle())
//   call 2: rate-limit count (awaited directly → needs .count = 0)
const MOCK_DOC = {
  id: 'doc-uuid',
  document_type: 'messaging',
  segment_id: null,
  content: { variants: {} },
  organisation_id: 'test-org-id',
  version: 5,
}

function makeDocOwnershipChain() {
  return {
    select: function() { return this },
    eq:     function() { return this },
    maybeSingle: vi.fn().mockResolvedValue({ data: MOCK_DOC }),
  }
}

function makeRateLimitChain() {
  const chain: Record<string, unknown> = {
    count: 0,
    error: null,
  }
  const self = chain
  chain['select'] = () => self
  chain['eq']     = () => self
  chain['gte']    = () => self
  chain['then']   = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ count: 0, error: null }).then(resolve)
  return chain
}

let strategyDocCallCount = 0
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'strategy_documents') {
        strategyDocCallCount++
        return strategyDocCallCount === 1 ? makeDocOwnershipChain() : makeRateLimitChain()
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { organisation_id: 'test-org-id' } }),
      }
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: new Error('should not reach promote') }),
  })),
}))

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('POST /api/documents/revise — 422 error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    strategyDocCallCount = 0
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'test-user-id' } },
      error: null,
    })
  })

  it('returns 422 with human-readable error when RevisionGateError is thrown', async () => {
    const { POST } = await import('../route')

    const request = new NextRequest(
      'http://localhost:3000/api/documents/revise',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: '7660973b-3895-4aae-bd9e-5819f000d488', note: 'Add credentials' }),
      },
    )

    const response = await POST(request)
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(422)
    expect(typeof body['error']).toBe('string')
    expect((body['error'] as string).startsWith("We couldn't apply")).toBe(true)
    expect(body['error']).toContain('outbound guidelines')
  })
})
