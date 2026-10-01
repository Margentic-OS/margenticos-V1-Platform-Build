// The gate on POST /api/operator/icp-filter-spec/reject.
//
// Rejecting throws a proposal away and changes nothing else (ADR-061 rule 5). What it
// decides is tested in src/lib/sourcing/__tests__/approve-icp-filter-spec.test.ts. This
// file tests who is let through, what a malformed request does, and that each refusal
// reaches the operator with its own status and words.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ marker: 'service client' })) }))

const gate = vi.hoisted(() => ({
  user: { id: 'operator-user' } as { id: string } | null,
  authorized: true,
  checks: 0,
}))
vi.mock('@/lib/supabase/require-operator', () => ({
  requireOperator: vi.fn(async () => {
    gate.checks += 1
    return { user: gate.user, authorized: gate.authorized }
  }),
}))

const rejection = vi.hoisted(() => ({ reject: vi.fn(), approve: vi.fn() }))
vi.mock('@/lib/sourcing/approve-icp-filter-spec', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sourcing/approve-icp-filter-spec')>()),
  rejectIcpFilterSpecProposal: (...args: unknown[]) => rejection.reject(...args),
  approveIcpFilterSpecProposal: (...args: unknown[]) => rejection.approve(...args),
}))

import {
  APPROVAL_REFUSALS,
  REFUSAL_MESSAGES,
  REFUSAL_STATUS,
} from '@/lib/sourcing/approve-icp-filter-spec'

const DOC = '11111111-1111-4111-8111-111111111111'
const PRINT = 'cd'.repeat(32)

async function post(body: unknown, raw = false) {
  const { POST } = await import('../route')
  return POST(new NextRequest('http://localhost/api/operator/icp-filter-spec/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  gate.user = { id: 'operator-user' }
  gate.authorized = true
  gate.checks = 0
  rejection.reject.mockResolvedValue({ outcome: 'rejected', organisation_id: 'org' })
})

describe('an operator rejecting the proposal they were shown', () => {
  it('runs the rejection with the document, the fingerprint and who they are', async () => {
    const res = await post({ document_id: DOC, fingerprint: PRINT })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rejected: true })
    expect(rejection.reject).toHaveBeenCalledTimes(1)
    expect(rejection.reject.mock.calls[0][1]).toEqual({
      documentId: DOC, fingerprint: PRINT, rejectedBy: 'operator-user',
    })
  })

  it('never runs an approval', async () => {
    await post({ document_id: DOC, fingerprint: PRINT })
    expect(rejection.approve).not.toHaveBeenCalled()
  })
})

describe('who may reject', () => {
  it('401s a caller who is not signed in, and attempts nothing', async () => {
    gate.user = null
    gate.authorized = false
    expect((await post({ document_id: DOC, fingerprint: PRINT })).status).toBe(401)
    expect(rejection.reject).not.toHaveBeenCalled()
  })

  it('403s a signed-in user who is not an operator, and attempts nothing', async () => {
    gate.authorized = false
    expect((await post({ document_id: DOC, fingerprint: PRINT })).status).toBe(403)
    expect(rejection.reject).not.toHaveBeenCalled()
  })

  it('checks the role on EVERY request', async () => {
    expect((await post({ document_id: DOC, fingerprint: PRINT })).status).toBe(200)
    gate.authorized = false
    expect((await post({ document_id: DOC, fingerprint: PRINT })).status).toBe(403)
    expect(gate.checks).toBe(2)
    expect(rejection.reject).toHaveBeenCalledTimes(1)
  })
})

describe('a request that cannot be read is refused before anything is attempted', () => {
  it.each([
    ['a body that is not JSON', '{not json', true],
    ['no document_id', { fingerprint: PRINT }, false],
    ['a document_id that is not a UUID', { document_id: 'not-a-uuid', fingerprint: PRINT }, false],
    ['no fingerprint', { document_id: DOC }, false],
    ['a fingerprint of the wrong shape', { document_id: DOC, fingerprint: 'abc' }, false],
  ])('%s', async (_name, body, raw) => {
    expect((await post(body, raw as boolean)).status).toBe(400)
    expect(rejection.reject).not.toHaveBeenCalled()
  })
})

describe('each refusal reaches the operator with its own status and its own words', () => {
  it.each([...APPROVAL_REFUSALS])('%s', async refused => {
    rejection.reject.mockResolvedValue({ outcome: 'refused', refused })
    const res = await post({ document_id: DOC, fingerprint: PRINT })

    expect(res.status).toBe(REFUSAL_STATUS[refused])
    expect(await res.json()).toEqual({ error: REFUSAL_MESSAGES[refused], refused })
  })

  it('answers a failure with 500 and does not claim anything was rejected', async () => {
    rejection.reject.mockResolvedValue({ outcome: 'failed', step: 'clear the proposal', error: 'boom' })
    const res = await post({ document_id: DOC, fingerprint: PRINT })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.rejected).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('boom')
  })
})
