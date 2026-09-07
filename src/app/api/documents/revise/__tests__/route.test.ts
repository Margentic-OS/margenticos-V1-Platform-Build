// Verifies that POST /api/documents/revise maps RevisionGateError → 422 with the
// human-readable error message DocumentRevisionControls will render.
//
// ─── WHAT CHANGED HERE, 2026-09-07 ───────────────────────────────────────────
//
// The doubles in this file used to accept any filter and return the same document
// regardless, so the route's ownership check could be deleted outright with this file
// still green. It now runs against a fake that honours filters, seeded with rows that
// have to be matched. The 422 assertion is unchanged and still the point of the file;
// what changed is that reaching the assertion now requires the lookup to have actually
// found the seeded document. See fake-supabase.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { RevisionGateError } from '@/lib/agents/revision/run-revision'
import { makeFakeSupabase } from './fake-supabase'

const ORG = '11111111-1111-1111-1111-111111111111'
const DOC = '7660973b-3895-4aae-bd9e-5819f000d488'
const USER = 'the-signed-in-user'

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

// Cookie client — authentication only. The route resolves role and organisation
// through the service client, so nothing else is read from the session here.
const mockGetUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}))

let fake: ReturnType<typeof makeFakeSupabase>

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => fake.client),
}))

vi.mock('@/lib/email/send', () => ({
  sendTransactionalEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'test-message-id' }),
}))

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('POST /api/documents/revise — 422 error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })

    fake = makeFakeSupabase({
      tables: {
        users: [{ id: USER, role: 'client', organisation_id: ORG }],
        strategy_documents: [{
          id: DOC, organisation_id: ORG, document_type: 'messaging',
          status: 'active', segment_id: null, version: '5',
          content: { variants: {} },
          update_trigger: 'signal_suggestion',
          created_at: '2020-01-01T00:00:00.000Z',
        }],
        document_suggestions: [],
        organisations: [{ id: ORG, name: 'The organisation' }],
      },
      rpc: () => ({ data: null, error: { message: 'should not reach promote' } }),
    })
  })

  it('returns 422 with human-readable error when RevisionGateError is thrown', async () => {
    const { POST } = await import('../route')

    const request = new NextRequest(
      'http://localhost:3000/api/documents/revise',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: DOC, note: 'Add credentials' }),
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
