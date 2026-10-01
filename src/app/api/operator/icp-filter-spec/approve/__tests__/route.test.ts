// The gate on POST /api/operator/icp-filter-spec/approve.
//
// This route is the only way a client's search settings change (ADR-061). What it decides
// is tested in src/lib/sourcing/__tests__/approve-icp-filter-spec.test.ts. What this file
// tests is the part only a route can get wrong: who is let through, what a malformed
// request does, and that each refusal reaches the operator with its own status and words.
//
// "The approval was not attempted" is a zero. The stand-in for the approval records every
// call, and the first test shows it recording one.

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

const approval = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/sourcing/approve-icp-filter-spec', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sourcing/approve-icp-filter-spec')>()),
  approveIcpFilterSpecProposal: (...args: unknown[]) => approval.fn(...args),
}))

import {
  APPROVAL_REFUSALS,
  REFUSAL_MESSAGES,
  REFUSAL_STATUS,
} from '@/lib/sourcing/approve-icp-filter-spec'

const DOC = '11111111-1111-4111-8111-111111111111'
const PRINT = 'ab'.repeat(32)
const APPROVED = {
  outcome: 'approved', organisation_id: 'org', cursor_reset: true, previous_offset: 500, requeued_count: 7,
}

function request(body: unknown, raw = false) {
  return new NextRequest('http://localhost/api/operator/icp-filter-spec/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

async function post(body: unknown, raw = false) {
  const { POST } = await import('../route')
  return POST(request(body, raw))
}

beforeEach(() => {
  vi.clearAllMocks()
  gate.user = { id: 'operator-user' }
  gate.authorized = true
  gate.checks = 0
  approval.fn.mockResolvedValue(APPROVED)
})

describe('an operator approving the proposal they were shown', () => {
  it('runs the approval with the document, the fingerprint, the ticks and who they are', async () => {
    const res = await post({
      document_id: DOC, fingerprint: PRINT, confirmed_removals: ['job_titles_excluded:a placeholder'],
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      approved: true, cursor_reset: true, previous_offset: 500, requeued_count: 7,
    })
    expect(approval.fn).toHaveBeenCalledTimes(1)
    expect(approval.fn.mock.calls[0][1]).toEqual({
      documentId: DOC,
      fingerprint: PRINT,
      confirmedRemovals: ['job_titles_excluded:a placeholder'],
      approvedBy: 'operator-user',
    })
  })

  it('treats no ticks sent as no ticks, never as all of them', async () => {
    await post({ document_id: DOC, fingerprint: PRINT })
    expect(approval.fn.mock.calls[0][1]).toMatchObject({ confirmedRemovals: [] })
  })
})

describe('who may approve', () => {
  it('401s a caller who is not signed in, and attempts nothing', async () => {
    gate.user = null
    gate.authorized = false
    const res = await post({ document_id: DOC, fingerprint: PRINT })
    expect(res.status).toBe(401)
    expect(approval.fn).not.toHaveBeenCalled()
  })

  it('403s a signed-in user who is not an operator, and attempts nothing', async () => {
    gate.authorized = false
    const res = await post({ document_id: DOC, fingerprint: PRINT })
    expect(res.status).toBe(403)
    expect(approval.fn).not.toHaveBeenCalled()
  })

  it('checks the role on EVERY request: an operator demoted between two requests is refused the second', async () => {
    expect((await post({ document_id: DOC, fingerprint: PRINT })).status).toBe(200)
    gate.authorized = false
    expect((await post({ document_id: DOC, fingerprint: PRINT })).status).toBe(403)
    expect(gate.checks).toBe(2)
    expect(approval.fn).toHaveBeenCalledTimes(1)
  })
})

describe('a request that cannot be read is refused before anything is attempted', () => {
  it.each([
    ['a body that is not JSON', '{not json', true],
    ['no document_id', { fingerprint: PRINT }, false],
    ['a document_id that is not a UUID', { document_id: 'not-a-uuid', fingerprint: PRINT }, false],
    ['no fingerprint', { document_id: DOC }, false],
    ['a fingerprint of the wrong shape', { document_id: DOC, fingerprint: 'abc' }, false],
    ['ticks that are not a list', { document_id: DOC, fingerprint: PRINT, confirmed_removals: 'all' }, false],
    ['ticks that are not strings', { document_id: DOC, fingerprint: PRINT, confirmed_removals: [true] }, false],
  ])('%s', async (_name, body, raw) => {
    const res = await post(body, raw as boolean)
    expect(res.status).toBe(400)
    expect(approval.fn).not.toHaveBeenCalled()
  })
})

describe('each refusal reaches the operator with its own status and its own words', () => {
  it.each([...APPROVAL_REFUSALS])('%s', async refused => {
    approval.fn.mockResolvedValue({ outcome: 'refused', refused })
    const res = await post({ document_id: DOC, fingerprint: PRINT })

    expect(res.status).toBe(REFUSAL_STATUS[refused])
    expect(await res.json()).toEqual({ error: REFUSAL_MESSAGES[refused], refused })
  })

  it('names the exclusions that were not ticked', async () => {
    const unconfirmed = [{ source: 'job_titles_excluded', value: 'a placeholder', how: 'removed' }]
    approval.fn.mockResolvedValue({ outcome: 'refused', refused: 'exclusions_not_confirmed', unconfirmed })
    const res = await post({ document_id: DOC, fingerprint: PRINT })

    expect(res.status).toBe(422)
    expect((await res.json()).unconfirmed).toEqual(unconfirmed)
  })

  it('answers a failure with 500 and does not claim anything was approved', async () => {
    approval.fn.mockResolvedValue({ outcome: 'failed', step: 'write the approved settings', error: 'boom' })
    const res = await post({ document_id: DOC, fingerprint: PRINT })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.approved).toBeUndefined()
    // The database's own error text stays in the log and is not sent to the browser.
    expect(JSON.stringify(body)).not.toContain('boom')
  })
})
