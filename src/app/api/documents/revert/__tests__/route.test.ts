// The gates on /api/documents/revert.
//
// Revert rewrites the live copy every future email is composed from, so the two things
// worth testing are the two that decide whether it runs at all: the caller is an
// operator, and the target is not already live.
//
// The fake THROWS on any filter it does not implement rather than silently returning the
// chain. A fake that swallows a filter cannot test that filter, and a test written
// against one passes whether or not the guard is still there.
// See CLAUDE.md, "A fake that does not honour a filter cannot test that filter".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({})) }))

// Both are called after a successful revert. Neither is what this file is about, and a
// real call would reach the network.
vi.mock('@/lib/sourcing/persist-icp-filter-spec', () => ({
  persistIcpFilterSpec: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/agents/cascade/trigger-cascade', () => ({
  triggerCascadeIfEligible: vi.fn().mockResolvedValue(undefined),
}))

let authorized = true
let sourceRow: Record<string, unknown> | null = null
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []

vi.mock('@/lib/supabase/require-operator', () => ({
  requireOperator: vi.fn(async () => ({
    user: { id: 'operator-user' },
    authorized,
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      if (table !== 'strategy_documents') {
        throw new Error(`fake does not implement table ${table}`)
      }
      const chain = {
        select: () => chain,
        eq: (column: string) => {
          if (column !== 'id') throw new Error(`fake does not implement .eq on ${column}`)
          return chain
        },
        maybeSingle: async () => ({ data: sourceRow, error: null }),
      }
      return chain
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return { data: { id: 'new-doc', version: '6' }, error: null }
    },
  })),
}))

function request(body: unknown) {
  return new NextRequest('http://localhost/api/documents/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ARCHIVED = {
  id: '11111111-1111-1111-1111-111111111111',
  status: 'archived',
  organisation_id: '22222222-2222-2222-2222-222222222222',
  document_type: 'messaging',
  version: '2',
}

beforeEach(() => {
  authorized = true
  sourceRow = { ...ARCHIVED }
  rpcCalls = []
  vi.clearAllMocks()
})

describe('who may restore a version', () => {
  it('refuses a caller who is not an operator, and writes nothing', async () => {
    authorized = false
    const { POST } = await import('../route')
    const res = await POST(request({ document_id: ARCHIVED.id }))

    expect(res.status).toBe(403)
    expect(rpcCalls).toEqual([])
  })

  it('lets an operator through', async () => {
    const { POST } = await import('../route')
    const res = await POST(request({ document_id: ARCHIVED.id }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'new-doc', version: '6' })
    expect(rpcCalls).toEqual([
      { name: 'revert_strategy_doc_version', args: { p_document_id: ARCHIVED.id } },
    ])
  })
})

describe('what may be restored', () => {
  it('refuses to restore the version that is already live', async () => {
    // Not a formality. Reverting to the live version would append a duplicate that says
    // nothing, and it would archive the row it was copied from in the process.
    sourceRow = { ...ARCHIVED, status: 'active' }
    const { POST } = await import('../route')
    const res = await POST(request({ document_id: ARCHIVED.id }))

    expect(res.status).toBe(409)
    expect(rpcCalls).toEqual([])
  })

  it('404s on a version that does not exist', async () => {
    sourceRow = null
    const { POST } = await import('../route')
    const res = await POST(request({ document_id: ARCHIVED.id }))

    expect(res.status).toBe(404)
    expect(rpcCalls).toEqual([])
  })

  it('rejects a document_id that is not a UUID before touching the database', async () => {
    const { POST } = await import('../route')
    const res = await POST(request({ document_id: 'not-a-uuid' }))

    expect(res.status).toBe(400)
    expect(rpcCalls).toEqual([])
  })
})
