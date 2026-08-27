// Verifies /api/suggestions/regenerate routes:
// - Operators can regenerate existing pending suggestions (with suggestion_id)
// - Clients can generate doc types with no pending suggestion (without suggestion_id)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/agents/icp-generation-agent', () => ({ runIcpGenerationAgent: vi.fn().mockResolvedValue(null) }))
vi.mock('@/agents/positioning-generation-agent', () => ({ runPositioningGenerationAgent: vi.fn().mockResolvedValue(null) }))
vi.mock('@/agents/tov-generation-agent', () => ({ runTovGenerationAgent: vi.fn().mockResolvedValue(null) }))
vi.mock('@/agents/messaging-generation-agent', () => ({ runMessagingGenerationAgent: vi.fn().mockResolvedValue(null) }))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))

// Supabase service client (makeServiceClient path — used for data queries and agent execution)
let userRowMockData: Record<string, unknown> | null = null
let suggestionMockData: Record<string, unknown> | null = null

vi.mock('next/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    // Stub after() to immediately invoke the callback.
    // This allows tests to verify the agent execution path without relying on
    // Next.js runtime infrastructure. Real after() deferral semantics are proven
    // by the live integration check (Step 3).
    after: (fn: () => Promise<unknown>) => fn(),
  }
})

// Captures the payload of the rejection UPDATE so a test can assert what was persisted.
let lastSuggestionUpdate: Record<string, unknown> | null = null

// The fake PROJECTS onto the requested column list rather than returning the whole
// fixture row. A fake that ignores .select() cannot tell a route that asks for a
// column from one that does not, so a test written against it passes in both worlds.
// See CLAUDE.md, "A fake that does not honour a filter cannot test that filter".
function project(
  row: Record<string, unknown> | null,
  columns: string | undefined,
): Record<string, unknown> | null {
  if (!row) return null
  if (!columns || columns === '*') return row
  const wanted = columns.split(',').map(c => c.trim()).filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const key of wanted) out[key] = row[key]
  return out
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      let singleData: Record<string, unknown> | null = null
      if (table === 'users') {
        singleData = userRowMockData
      } else if (table === 'document_suggestions') {
        singleData = suggestionMockData
      }

      let selectedColumns: string | undefined

      const baseChain = {
        select: vi.fn((columns?: string) => { selectedColumns = columns; return baseChain }),
        eq:     vi.fn(() => baseChain),
        in:     vi.fn(() => baseChain),
        update: vi.fn((payload: Record<string, unknown>) => {
          if (table === 'document_suggestions') lastSuggestionUpdate = payload
          return baseChain
        }),
        neq:    vi.fn(() => baseChain),
        gte:    vi.fn(() => baseChain),
        single: vi.fn(async () => {
          const data = project(singleData, selectedColumns)
          return { data, error: singleData ? null : new Error('not found') }
        }),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      }
      return baseChain
    },
  })),
}))

// ── Supabase SSR client — behaviour varies per test ───────────────────────────
const mockGetUser  = vi.fn()
const mockUserFrom = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      single: mockUserFrom,
    }),
  })),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/suggestions/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = { client_id: 'org-uuid', document_type: 'icp' }

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/suggestions/regenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userRowMockData = null
    suggestionMockData = null
    lastSuggestionUpdate = null
  })

  it('returns 202 for a client generating fresh (no pending suggestion)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'client-user-id' } }, error: null })
    userRowMockData = { role: 'client', organisation_id: 'org-uuid' }

    const { runIcpGenerationAgent } = await import('@/agents/icp-generation-agent')
    const { POST } = await import('../route')
    const res = await POST(makeRequest(VALID_BODY))
    const body = await res.json()

    // Verify response and that agent was invoked via the stubbed after().
    // Real after() deferral semantics (execution after response) are proven by live integration test.
    expect(res.status).toBe(202)
    expect(body.success).toBe(true)
    expect(body.started).toBe(true)
    expect(runIcpGenerationAgent).toHaveBeenCalled()
  })

  it('returns 202 for an operator regenerating and queues the agent', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    userRowMockData = { role: 'operator', organisation_id: 'org-uuid' }
    suggestionMockData = { id: 'suggestion-uuid', organisation_id: 'org-uuid', document_type: 'icp', status: 'pending' }

    const { runIcpGenerationAgent } = await import('@/agents/icp-generation-agent')
    const { POST } = await import('../route')
    const res = await POST(makeRequest({ ...VALID_BODY, suggestion_id: 'suggestion-uuid' }))
    const body = await res.json()

    // Verify response and that agent was invoked via the stubbed after().
    // Real after() deferral semantics (execution after response) are proven by live integration test.
    expect(res.status).toBe(202)
    expect(body.success).toBe(true)
    expect(body.started).toBe(true)
    expect(runIcpGenerationAgent).toHaveBeenCalled()
  })

  // ── The operator note reaches the agent ─────────────────────────────────────
  //
  // The defect this covers: on 27 August an operator rejected an ICP suggestion with a
  // note naming three regions to remove, the note was written to
  // document_suggestions.rejection_reason, and the regenerated document still named all
  // three. The route persisted the note and called the agent without it. See ADR-038.

  it('passes the operator rejection note to the agent', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    userRowMockData = { role: 'operator', organisation_id: 'org-uuid' }
    suggestionMockData = {
      id: 'suggestion-uuid', organisation_id: 'org-uuid', document_type: 'icp',
      status: 'pending', revision_note: null,
    }

    const { runIcpGenerationAgent } = await import('@/agents/icp-generation-agent')
    const { POST } = await import('../route')
    await POST(makeRequest({
      ...VALID_BODY,
      suggestion_id: 'suggestion-uuid',
      rejection_reason: 'Remove Canada, Australia and Western Europe from the geography in all three tiers.',
    }))

    expect(runIcpGenerationAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        regeneration_notes: expect.objectContaining({
          operator_note: 'Remove Canada, Australia and Western Europe from the geography in all three tiers.',
        }),
      }),
    )
  })

  it('still records the rejection note on the row it rejects', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    userRowMockData = { role: 'operator', organisation_id: 'org-uuid' }
    suggestionMockData = {
      id: 'suggestion-uuid', organisation_id: 'org-uuid', document_type: 'icp',
      status: 'pending', revision_note: null,
    }

    const { POST } = await import('../route')
    await POST(makeRequest({
      ...VALID_BODY, suggestion_id: 'suggestion-uuid', rejection_reason: '  Tighten tier three.  ',
    }))

    expect(lastSuggestionUpdate).toMatchObject({
      status: 'rejected',
      rejection_reason: 'Tighten tier three.',
    })
  })

  it("carries the client's original change request when regenerating a client revision", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    userRowMockData = { role: 'operator', organisation_id: 'org-uuid' }
    suggestionMockData = {
      id: 'suggestion-uuid', organisation_id: 'org-uuid', document_type: 'messaging',
      status: 'pending', revision_note: 'Mention the onboarding guarantee in email two.',
    }

    const { runMessagingGenerationAgent } = await import('@/agents/messaging-generation-agent')
    const { POST } = await import('../route')
    await POST(makeRequest({
      client_id: 'org-uuid',
      document_type: 'messaging',
      suggestion_id: 'suggestion-uuid',
      rejection_reason: 'Email two is now longer than email one.',
    }))

    // Both notes travel. The client note is the request, the operator note is the
    // correction to the attempt that answered it. Dropping either loses information
    // the next run needs.
    expect(runMessagingGenerationAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        regeneration_notes: {
          operator_note: 'Email two is now longer than email one.',
          client_note: 'Mention the onboarding guarantee in email two.',
        },
      }),
    )
  })

  it('sends no notes when the operator gave none', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    userRowMockData = { role: 'operator', organisation_id: 'org-uuid' }
    suggestionMockData = {
      id: 'suggestion-uuid', organisation_id: 'org-uuid', document_type: 'icp',
      status: 'pending', revision_note: null,
    }

    const { runIcpGenerationAgent } = await import('@/agents/icp-generation-agent')
    const { POST } = await import('../route')
    await POST(makeRequest({ ...VALID_BODY, suggestion_id: 'suggestion-uuid' }))

    expect(runIcpGenerationAgent).toHaveBeenCalledWith(
      expect.objectContaining({ regeneration_notes: undefined }),
    )
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') })

    const { POST } = await import('../route')
    const res = await POST(makeRequest(VALID_BODY))

    expect(res.status).toBe(401)
  })
})
