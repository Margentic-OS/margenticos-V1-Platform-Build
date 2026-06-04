// Verifies that /api/suggestions/regenerate is operator-only.
// Client sessions must receive 403; operator sessions must reach the agent dispatch.

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

// Supabase service client (makeServiceClient path — used for agent execution)
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
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
  })

  it('returns 403 for a client-role user (non-operator)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'client-user-id' } }, error: null })
    mockUserFrom.mockResolvedValue({ data: { role: 'client' }, error: null })

    const { POST } = await import('../route')
    const res = await POST(makeRequest(VALID_BODY))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Operator access required.')
  })

  it('returns 200 for an operator and fires the agent', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'operator-user-id' } }, error: null })
    mockUserFrom.mockResolvedValue({ data: { role: 'operator' }, error: null })

    const { POST } = await import('../route')
    const res = await POST(makeRequest(VALID_BODY))
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
