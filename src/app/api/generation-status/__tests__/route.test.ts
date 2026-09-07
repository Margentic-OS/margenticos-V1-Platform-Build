// /api/generation-status must be able to say that a run FAILED.
//
// It used to return { isGenerating } computed from status='running' alone. That shape
// cannot express failure, and its one caller read every false as success:
//
//   if (!isGenerating) { /* Generation completed */ }
//
// So the 2026-09-05 tov failure showed as "Generating your Tone of voice guide..." for
// ever. These tests pin the outcome mapping, and the fact that a client is never handed
// the raw agent error.
//
// The fake THROWS on any filter or table it does not implement rather than returning the
// chain. A fake that swallows .order() cannot test that the route asks for the LATEST run,
// and dropping that ordering is exactly how this route would start reporting an ancient
// run's outcome as the current one.
// See CLAUDE.md, "A fake that does not honour a filter cannot test that filter".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: () => [], set: vi.fn() }),
}))

let authedUserId: string | null = 'user-1'
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: async () => ({
        data: { user: authedUserId ? { id: authedUserId } : null },
        error: authedUserId ? null : new Error('no session'),
      }),
    },
  })),
}))

interface AgentRunRow {
  id: string
  status: string
  started_at: string
  completed_at: string | null
  error_message: string | null
}

let userRow: { role: string; organisation_id: string } | null = null
let latestRun: AgentRunRow | null = null
let observed: { ordered?: string; descending?: boolean; limited?: number; agentName?: string } = {}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'users') {
        const chain = {
          select: () => chain,
          eq: (col: string) => {
            if (col !== 'id') throw new Error(`users fake does not implement .eq on ${col}`)
            return chain
          },
          single: async () => ({ data: userRow, error: userRow ? null : new Error('no user') }),
        }
        return chain
      }

      if (table === 'agent_runs') {
        const chain = {
          select: () => chain,
          eq: (col: string, val: string) => {
            if (col === 'agent_name') observed.agentName = val
            else if (col !== 'organisation_id') {
              throw new Error(`agent_runs fake does not implement .eq on ${col}`)
            }
            return chain
          },
          order: (col: string, opts: { ascending: boolean }) => {
            observed.ordered = col
            observed.descending = opts.ascending === false
            return chain
          },
          limit: (n: number) => {
            observed.limited = n
            return chain
          },
          maybeSingle: async () => ({ data: latestRun, error: null }),
        }
        return chain
      }

      throw new Error(`fake does not implement table ${table}`)
    },
  })),
}))

import { GET } from '../route'

function request(clientId = 'org-1', docType = 'tov') {
  return new NextRequest(
    `http://localhost/api/generation-status?client_id=${clientId}&document_type=${docType}`,
  )
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString()

function run(over: Partial<AgentRunRow>): AgentRunRow {
  return {
    id: 'run-1',
    status: 'completed',
    started_at: minutesAgo(2),
    completed_at: minutesAgo(1),
    error_message: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authedUserId = 'user-1'
  userRow = { role: 'operator', organisation_id: 'org-operator' }
  latestRun = null
  observed = {}
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
})

describe('the outcome the route reports', () => {
  it('running and recent is generating', async () => {
    latestRun = run({ status: 'running', started_at: minutesAgo(1), completed_at: null })
    const body = await (await GET(request())).json()
    expect(body.outcome).toBe('generating')
    expect(body.isGenerating).toBe(true)
  })

  it('FAILED is failed, which the old shape could not say at all', async () => {
    latestRun = run({ status: 'failed', error_message: 'TOV agent: not valid JSON' })
    const body = await (await GET(request())).json()
    expect(body.outcome).toBe('failed')
    expect(body.isGenerating).toBe(false)
  })

  it('completed is succeeded', async () => {
    latestRun = run({ status: 'completed' })
    const body = await (await GET(request())).json()
    expect(body.outcome).toBe('succeeded')
  })

  it('running but older than the window is stalled, not generating and not failed', async () => {
    // Deliberately its own state. The remedy differs from a failure, and the reaper has
    // not marked it yet, so calling it failed would be asserting something untrue.
    latestRun = run({ status: 'running', started_at: minutesAgo(45), completed_at: null })
    const body = await (await GET(request())).json()
    expect(body.outcome).toBe('stalled')
    expect(body.isGenerating).toBe(false)
  })

  it('no run at all is none, not succeeded', async () => {
    latestRun = null
    const body = await (await GET(request())).json()
    expect(body.outcome).toBe('none')
    expect(body.latestRun).toBeNull()
  })
})

describe('it reads the LATEST run, not an arbitrary one', () => {
  it('orders by started_at descending and takes one', async () => {
    // Drop the .order() and the route would answer with whatever row came back first,
    // which on an org with history is an old run whose outcome has nothing to do with
    // what the caller is waiting for.
    latestRun = run({ status: 'completed' })
    await GET(request())
    expect(observed.ordered).toBe('started_at')
    expect(observed.descending).toBe(true)
    expect(observed.limited).toBe(1)
  })

  it('scopes to the document type it was asked about', async () => {
    latestRun = run({})
    await GET(request('org-1', 'positioning'))
    expect(observed.agentName).toBe('positioning-generation')
  })
})

describe('the agent error goes to operators only', () => {
  it('includes error_message for an operator', async () => {
    userRow = { role: 'operator', organisation_id: 'org-operator' }
    latestRun = run({ status: 'failed', error_message: 'TOV agent: not valid JSON' })
    const body = await (await GET(request())).json()
    expect(body.latestRun.error_message).toContain('not valid JSON')
  })

  it('withholds it from a client, who cannot act on it and should not see our internals', async () => {
    userRow = { role: 'client', organisation_id: 'org-1' }
    latestRun = run({ status: 'failed', error_message: 'TOV agent: not valid JSON' })
    const body = await (await GET(request('org-1'))).json()
    expect(body.outcome).toBe('failed')
    expect(body.latestRun.error_message).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('not valid JSON')
  })
})

describe('the auth gates still hold', () => {
  it('401 when not authenticated', async () => {
    authedUserId = null
    expect((await GET(request())).status).toBe(401)
  })

  it('403 when a client asks about another organisation', async () => {
    userRow = { role: 'client', organisation_id: 'org-mine' }
    expect((await GET(request('org-someone-else'))).status).toBe(403)
  })

  it('400 without the required params', async () => {
    const res = await GET(new NextRequest('http://localhost/api/generation-status'))
    expect(res.status).toBe(400)
  })
})
