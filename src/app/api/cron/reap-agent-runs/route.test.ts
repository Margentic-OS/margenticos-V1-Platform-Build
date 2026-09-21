// The reap cron, which had no test file at all.
//
// WHAT IT IS FOR. An agent_run stuck at 'running' is a run that died without saying so.
// Nothing else notices: the row looks like work in progress forever, and the dashboard
// reads it as an agent still going. This job is what turns that silence into a failure.
//
// THE GUARD THAT MATTERS is the threshold. Reaping too eagerly kills live runs and
// records them as failures, which is worse than leaving a zombie: it manufactures false
// failures in the one table that says what the agents did. So the boundary is tested from
// both sides rather than with one comfortable value in the middle.
//
// THE OTHER GUARD IS THE HEARTBEAT, and it is here for the MON-019 reason in CLAUDE.md: a
// monitor that exists and is silent reads on the dashboard as a monitor that is healthy.
// Both paths through this route must write one, including the path where there was
// nothing to do.
//
// The fake RECORDS its updates and inserts rather than swallowing them. A chainable proxy
// returning itself would accept an .update() that never happened and prove only that the
// code path ran.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}))

const MINUTE = 60 * 1000

interface RunRow {
  id: string
  organisation_id: string
  agent_name: string
  started_at: string
}

const state = vi.hoisted(() => ({
  running: [] as RunRow[],
  fetchError: null as { message: string } | null,
  updateErrorFor: new Set<string>(),
  updates: [] as Array<{ id: string; values: Record<string, unknown> }>,
  heartbeats: [] as Array<{ job_name: string; ok: boolean; detail: string }>,
  throwOnHeartbeat: false,
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      if (table === 'agent_runs') {
        return {
          select: () => ({
            eq: async () => ({ data: state.fetchError ? null : state.running, error: state.fetchError }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              if (state.updateErrorFor.has(id)) {
                return { error: { message: `update refused for ${id}` } }
              }
              state.updates.push({ id, values })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'cron_heartbeats') {
        return {
          insert: (row: { job_name: string; ok: boolean; detail: string }) => ({
            throwOnError: async () => {
              if (state.throwOnHeartbeat) throw new Error('heartbeat insert refused')
              state.heartbeats.push(row)
              return { error: null }
            },
          }),
        }
      }
      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

import { POST } from './route'

/** A run that started `agoMs` before now. */
function run(id: string, agoMs: number): RunRow {
  return {
    id,
    organisation_id: 'org-1',
    agent_name: 'a-generation-agent',
    started_at: new Date(Date.now() - agoMs).toISOString(),
  }
}

function cronRequest(auth: string | null = 'Bearer test-secret'): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/reap-agent-runs', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.running = []
  state.fetchError = null
  state.updateErrorFor = new Set()
  state.updates = []
  state.heartbeats = []
  state.throwOnHeartbeat = false
  process.env.CRON_SECRET = 'test-secret'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
})

describe('POST /api/cron/reap-agent-runs — auth', () => {
  it('401s without the bearer token, and never reads the table', async () => {
    const res = await POST(cronRequest(null))
    expect(res.status).toBe(401)
    expect(state.updates).toHaveLength(0)
    expect(state.heartbeats).toHaveLength(0)
  })

  it('401s on a wrong token', async () => {
    const res = await POST(cronRequest('Bearer not-the-secret'))
    expect(res.status).toBe(401)
  })

  it('401s when CRON_SECRET is unset, rather than accepting anything', async () => {
    // An unset secret must FAIL CLOSED. Comparing against undefined and letting a
    // matching-but-absent header through would open the endpoint on a misconfigured
    // deploy, which is the environment most likely to have one.
    delete process.env.CRON_SECRET
    const res = await POST(cronRequest('Bearer undefined'))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/cron/reap-agent-runs — the threshold', () => {
  it('reaps a run that has been running past the threshold', async () => {
    state.running = [run('run-old', 11 * MINUTE)]

    const res = await POST(cronRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ found: 1, reaped: 1, errors: 0 })

    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].id).toBe('run-old')
    expect(state.updates[0].values.status).toBe('failed')
    // The row must say WHY it ended, or a reaped run is indistinguishable from one that
    // failed on its own.
    expect(state.updates[0].values.error_message).toMatch(/reaped by cron/i)
    expect(state.updates[0].values.completed_at).toBeTruthy()
  })

  it('leaves a run that is still inside the threshold completely alone', async () => {
    // The dangerous direction. Reaping a live run records a false failure in the one
    // table that says what the agents actually did.
    state.running = [run('run-young', 2 * MINUTE)]

    const res = await POST(cronRequest())
    expect(await res.json()).toEqual({ found: 1, reaped: 0, errors: 0 })
    expect(state.updates).toHaveLength(0)
  })

  it('reaps only the runs past the threshold when both kinds are present', async () => {
    // The discriminating case: a single-sided test would pass against a route that
    // reaped everything, or nothing.
    state.running = [run('run-young', 1 * MINUTE), run('run-old', 30 * MINUTE)]

    const res = await POST(cronRequest())
    expect(await res.json()).toEqual({ found: 2, reaped: 1, errors: 0 })
    expect(state.updates.map(u => u.id)).toEqual(['run-old'])
  })

  it('does not reap a run sitting just under ten minutes', async () => {
    // Pins the boundary itself. Widening the threshold to, say, five minutes passes every
    // other test in this file and fails this one.
    state.running = [run('run-edge', 9 * MINUTE)]
    await POST(cronRequest())
    expect(state.updates).toHaveLength(0)
  })
})

describe('POST /api/cron/reap-agent-runs — the heartbeat', () => {
  it('writes a heartbeat when there was nothing to reap', async () => {
    // A job that stays silent on a quiet run cannot be told apart from a job that stopped
    // running at all.
    const res = await POST(cronRequest())
    expect(await res.json()).toEqual({ reaped: 0 })
    expect(state.heartbeats).toHaveLength(1)
    expect(state.heartbeats[0].job_name).toBe('reap-agent-runs')
    expect(state.heartbeats[0].ok).toBe(true)
  })

  it('writes a heartbeat after doing work', async () => {
    state.running = [run('run-old', 20 * MINUTE)]
    await POST(cronRequest())
    expect(state.heartbeats).toHaveLength(1)
    expect(state.heartbeats[0].ok).toBe(true)
    expect(state.heartbeats[0].detail).toContain('1')
  })

  it('marks the heartbeat NOT ok when a reap failed', async () => {
    // ok: true here would report a partly broken run as a clean one, and the monitor
    // reading this table would never show it.
    state.running = [run('run-old', 20 * MINUTE), run('run-stuck', 20 * MINUTE)]
    state.updateErrorFor = new Set(['run-stuck'])

    const res = await POST(cronRequest())
    expect(await res.json()).toEqual({ found: 2, reaped: 1, errors: 1 })
    expect(state.heartbeats[0].ok).toBe(false)
    expect(state.heartbeats[0].detail).toMatch(/error/i)
  })

  it('carries on past one failed reap rather than abandoning the batch', async () => {
    // One bad row must not strand every other zombie until the next run.
    state.running = [run('run-stuck', 20 * MINUTE), run('run-ok', 20 * MINUTE)]
    state.updateErrorFor = new Set(['run-stuck'])

    await POST(cronRequest())
    expect(state.updates.map(u => u.id)).toEqual(['run-ok'])
  })
})

describe('POST /api/cron/reap-agent-runs — failures', () => {
  it('500s when the runs cannot be read, rather than reporting nothing to do', async () => {
    // A failed read returning "reaped: 0" is the reassuring direction: it looks exactly
    // like a healthy quiet run while zombies accumulate.
    state.fetchError = { message: 'connection reset' }

    const res = await POST(cronRequest())
    expect(res.status).toBe(500)
    expect(state.heartbeats).toHaveLength(0)
  })

  it('500s when the heartbeat itself cannot be written', async () => {
    // throwOnError is deliberate: a run whose heartbeat was lost must not report success,
    // because the heartbeat is the only evidence the job ran.
    state.running = [run('run-old', 20 * MINUTE)]
    state.throwOnHeartbeat = true

    const res = await POST(cronRequest())
    expect(res.status).toBe(500)
  })
})
