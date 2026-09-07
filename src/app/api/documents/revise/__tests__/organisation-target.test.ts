// WHO A REVISION IS FOR, and who is allowed to ask for it.
//
// ─── THE DEFECT ──────────────────────────────────────────────────────────────
//
// /api/documents/revise took the organisation from the caller's own user row and never
// from the client being viewed. The strategy page honours ?client= for an operator and
// posts that client's document id, so the lookup searched for the right document inside
// the wrong organisation and returned "not found". Measured live before the fix: twenty
// of twenty live documents were revisable by their own client, none by an operator.
//
// ─── WHY THE OLD TESTS COULD NOT HAVE CAUGHT IT ──────────────────────────────
//
// Their doubles returned the same document for any filter, so the ownership check was
// unfalsifiable: removing `.eq('organisation_id', orgId)` from the route left the whole
// suite green. These tests use a fake that honours filters, so each assertion below
// fails when the guard it names is removed. See fake-supabase.ts.
//
// Three guards are pinned here, and each was mutation-proved by deleting exactly the
// line it protects and watching this file go red:
//   1. the ownership check still scopes the lookup to an organisation
//   2. an operator may act for the client they are viewing
//   3. a non-operator naming someone else's organisation is refused, and refused with
//      403 rather than 404 — "not allowed" and "does not exist" are different claims

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeSupabase, type Row } from './fake-supabase'

// ─── Identifiers. Opaque on purpose: nothing here names a company or a market. ───
const ORG_VIEWED   = '11111111-1111-1111-1111-111111111111'
const ORG_OPERATOR = '22222222-2222-2222-2222-222222222222'
const DOC_VIEWED   = '33333333-3333-3333-3333-333333333333'
const DOC_OPERATOR = '44444444-4444-4444-4444-444444444444'
const DOC_ARCHIVED = '55555555-5555-5555-5555-555555555555'
const NEW_DOC_ID   = '66666666-6666-6666-6666-666666666666'

const USER_OPERATOR = 'user-with-operator-role'
const USER_CLIENT   = 'user-with-client-role'

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
      revised_content: { summary: 'A revised summary.' },
      change_summary:  'Shortened the summary.',
    }),
  }
})

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))

// Run deferred work inline so the test observes it rather than racing it.
vi.mock('next/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, after: (fn: () => Promise<unknown>) => fn() }
})

vi.mock('@/lib/sourcing/persist-icp-filter-spec', () => ({
  persistIcpFilterSpec: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/agents/cascade/trigger-cascade', () => ({
  triggerCascadeIfEligible: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/send', () => ({
  sendTransactionalEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'm' }),
}))

const mockGetUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}))

// The service client the route builds. Rebuilt per test from `seed`.
let fake: ReturnType<typeof makeFakeSupabase>
const rpcCalls: Array<{ fn: string; args: Row }> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => fake.client),
}))

function seed(overrides: { failReadOn?: { table: string; message: string } } = {}) {
  return makeFakeSupabase({
    tables: {
      users: [
        { id: USER_OPERATOR, role: 'operator', organisation_id: ORG_OPERATOR },
        { id: USER_CLIENT,   role: 'client',   organisation_id: ORG_VIEWED },
      ],
      strategy_documents: [
        {
          id: DOC_VIEWED, organisation_id: ORG_VIEWED, document_type: 'icp',
          status: 'active', segment_id: null, version: '3',
          content: { summary: 'The current summary.' },
          update_trigger: 'signal_suggestion', created_at: '2020-01-01T00:00:00.000Z',
        },
        {
          id: DOC_OPERATOR, organisation_id: ORG_OPERATOR, document_type: 'icp',
          status: 'active', segment_id: null, version: '1',
          content: { summary: 'A different summary.' },
          update_trigger: 'signal_suggestion', created_at: '2020-01-01T00:00:00.000Z',
        },
        {
          id: DOC_ARCHIVED, organisation_id: ORG_VIEWED, document_type: 'icp',
          status: 'archived', segment_id: null, version: '2',
          content: { summary: 'A superseded summary.' },
          update_trigger: 'client_revision', created_at: '2020-01-01T00:00:00.000Z',
        },
      ],
      document_suggestions: [],
      organisations: [{ id: ORG_VIEWED, name: 'The viewed organisation' }],
    },
    failReadOn: overrides.failReadOn,
    rpc: (fn, args) => {
      rpcCalls.push({ fn, args })
      return {
        data: { id: NEW_DOC_ID, version: '4', change_summary: 'Shortened the summary.' },
        error: null,
      }
    },
  })
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/documents/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function signedInAs(userId: string) {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls.length = 0
  fake = seed()
})

// ─── The instrument first. A guard that passes on a fake that cannot fail proves
// ─── nothing, so prove the fake can tell rows apart before trusting any verdict below.
describe('the fake honours filters, which is the whole reason these tests mean anything', () => {
  it('returns only the row matching eq, not simply the first row', async () => {
    const { data } = await fake.client
      .from('strategy_documents')
      .select('id, organisation_id')
      .eq('id', DOC_OPERATOR)
      .maybeSingle()
    expect((data as Row | null)?.['id']).toBe(DOC_OPERATOR)
  })

  it('returns null when two filters cannot both be satisfied', async () => {
    // The exact shape of the bug: a real document id, the wrong organisation.
    const { data } = await fake.client
      .from('strategy_documents')
      .select('id')
      .eq('id', DOC_VIEWED)
      .eq('organisation_id', ORG_OPERATOR)
      .maybeSingle()
    expect(data).toBeNull()
  })

  it('honours in() rather than accepting any status', async () => {
    const { data } = await fake.client
      .from('strategy_documents')
      .select('id')
      .eq('id', DOC_ARCHIVED)
      .in('status', ['active', 'approved'])
      .maybeSingle()
    expect(data).toBeNull()
  })

  it('throws on a filter it does not implement instead of ignoring it', () => {
    expect(() =>
      (fake.client.from('strategy_documents') as unknown as { limit: () => void }).limit(),
    ).toThrow(/not implemented/)
  })
})

// ─── GUARD 1 ────────────────────────────────────────────────────────────────────
describe('the lookup is scoped to an organisation', () => {
  it('refuses a document belonging to an organisation the caller has no claim on', async () => {
    // A client signed in to ORG_VIEWED, naming a document that lives in ORG_OPERATOR.
    // Nothing about this request is malformed: the document id is real.
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({ document_id: DOC_OPERATOR, note: 'Please change this.' }))
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(404)
    expect(body['error']).toBe('Document not found or not accessible.')
    expect(rpcCalls).toHaveLength(0)
  })

  it('still allows a client their own document, so the guard is not simply refusing everything', async () => {
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({ document_id: DOC_VIEWED, note: 'Please change this.' }))

    expect(res.status).toBe(200)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]?.args['p_org_id']).toBe(ORG_VIEWED)
  })
})

// ─── GUARD 2 ────────────────────────────────────────────────────────────────────
describe('an operator can file a revision for the client they are viewing', () => {
  it('accepts a client_id that is not the operator own organisation', async () => {
    signedInAs(USER_OPERATOR)
    const { POST } = await import('../route')

    const res = await POST(post({
      document_id: DOC_VIEWED,
      note:        'Please change this.',
      client_id:   ORG_VIEWED,
    }))
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body['id']).toBe(NEW_DOC_ID)

    // The revision must land on the viewed organisation, not the operator's own. A fix
    // that resolved the caller correctly and then promoted against the wrong org would
    // pass a status check and still write to the wrong place.
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]?.args['p_org_id']).toBe(ORG_VIEWED)
    expect(rpcCalls[0]?.args['p_org_id']).not.toBe(ORG_OPERATOR)
  })

  it('without a client_id an operator still acts on their own organisation', async () => {
    signedInAs(USER_OPERATOR)
    const { POST } = await import('../route')

    const res = await POST(post({ document_id: DOC_OPERATOR, note: 'Please change this.' }))

    expect(res.status).toBe(200)
    expect(rpcCalls[0]?.args['p_org_id']).toBe(ORG_OPERATOR)
  })

  it('an operator naming an organisation cannot reach a document that is not in it', async () => {
    // The cross-org permission is not a skeleton key: it widens which organisation may
    // be named, never which documents belong to it.
    signedInAs(USER_OPERATOR)
    const { POST } = await import('../route')

    const res = await POST(post({
      document_id: DOC_OPERATOR,
      note:        'Please change this.',
      client_id:   ORG_VIEWED,
    }))

    expect(res.status).toBe(404)
    expect(rpcCalls).toHaveLength(0)
  })
})

// ─── GUARD 3 ────────────────────────────────────────────────────────────────────
describe('a non-operator naming another organisation is refused', () => {
  it('answers 403 and not 404, because the document exists and they may not have it', async () => {
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({
      document_id: DOC_OPERATOR,
      note:        'Please change this.',
      client_id:   ORG_OPERATOR,
    }))
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(403)
    expect(res.status).not.toBe(404)
    expect(body['error']).toBe('Not authorized for this client.')
    expect(rpcCalls).toHaveLength(0)
  })

  it('is refused even when the named organisation holds no such document', async () => {
    // The refusal is about the caller, so it must not depend on what happens to be in
    // the other organisation. Otherwise the response leaks whether a document is there.
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({
      document_id: DOC_VIEWED,
      note:        'Please change this.',
      client_id:   ORG_OPERATOR,
    }))

    expect(res.status).toBe(403)
  })

  it('a client naming their own organisation explicitly is allowed through', async () => {
    // Guard 3 must reject a mismatch, not the presence of the field. The control posts
    // client_id on every request, including a client's own.
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({
      document_id: DOC_VIEWED,
      note:        'Please change this.',
      client_id:   ORG_VIEWED,
    }))

    expect(res.status).toBe(200)
    expect(rpcCalls[0]?.args['p_org_id']).toBe(ORG_VIEWED)
  })
})

// ─── The discarded error ────────────────────────────────────────────────────────
describe('a failed read is reported as a failure, not as a missing document', () => {
  it('answers 500 when the lookup itself errors', async () => {
    // Line 91 used to destructure `data` alone, so a bad service key or a dropped
    // connection reached the client as "not found" and sent whoever debugged it hunting
    // for a row that was never missing.
    fake = seed({ failReadOn: { table: 'strategy_documents', message: 'connection reset' } })
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({ document_id: DOC_VIEWED, note: 'Please change this.' }))
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(500)
    expect(body['error']).not.toBe('Document not found or not accessible.')
    expect(rpcCalls).toHaveLength(0)
  })
})

// ─── Status alignment ───────────────────────────────────────────────────────────
describe('the route accepts the same statuses the page renders', () => {
  it('accepts a document the page would show under the other live status', async () => {
    fake.store['strategy_documents'] = [
      {
        id: DOC_VIEWED, organisation_id: ORG_VIEWED, document_type: 'icp',
        status: 'approved', segment_id: null, version: '3',
        content: { summary: 'The current summary.' },
        update_trigger: 'signal_suggestion', created_at: '2020-01-01T00:00:00.000Z',
      },
    ]
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({ document_id: DOC_VIEWED, note: 'Please change this.' }))

    expect(res.status).toBe(200)
  })

  it('still refuses an archived version, which the page does not render either', async () => {
    signedInAs(USER_CLIENT)
    const { POST } = await import('../route')

    const res = await POST(post({ document_id: DOC_ARCHIVED, note: 'Please change this.' }))

    expect(res.status).toBe(404)
    expect(rpcCalls).toHaveLength(0)
  })
})
