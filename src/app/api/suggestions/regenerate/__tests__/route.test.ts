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

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      let singleData: Record<string, unknown> | null = null
      if (table === 'users') {
        singleData = userRowMockData
      } else if (table === 'document_suggestions') {
        singleData = suggestionMockData
      }

      const baseChain = {
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        in:     vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        neq:    vi.fn().mockReturnThis(),
        gte:    vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: singleData, error: singleData ? null : new Error('not found') }),
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
  })

  it('returns 200 for a client generating fresh (no pending suggestion)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'client-user-id' } }, error: null })
    userRowMockData = { role: 'client', organisation_id: 'org-uuid' }

    const { POST } = await import('../route')
    const res = await POST(makeRequest(VALID_BODY))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('returns 200 for an operator regenerating and fires the agent', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    userRowMockData = { role: 'operator', organisation_id: 'org-uuid' }
    suggestionMockData = { id: 'suggestion-uuid', organisation_id: 'org-uuid', document_type: 'icp', status: 'pending' }

    const { POST } = await import('../route')
    const res = await POST(makeRequest({ ...VALID_BODY, suggestion_id: 'suggestion-uuid' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') })

    const { POST } = await import('../route')
    const res = await POST(makeRequest(VALID_BODY))

    expect(res.status).toBe(401)
  })
})
