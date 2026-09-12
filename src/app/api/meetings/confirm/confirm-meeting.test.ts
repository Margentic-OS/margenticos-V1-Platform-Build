// POST /api/meetings/confirm, driven for real against a STRICT fake database.
//
// WHY THIS FILE WAS REWRITTEN. Most of the old tests reimplemented the rule inside the test
// and asserted the copy ("const is_billable = decision === 'held'; expect(is_billable)…"), so
// they would have stayed green with the route broken. And the route WAS broken: clients hold
// only SELECT on meetings, a client's update touched 0 rows, and the route told them
// "Meeting confirmation already recorded" while writing nothing.
//
// Every test here goes through the real route. The login-based client is stood in for only
// to answer "who is signed in"; every meeting read and write goes through the service-role
// fake, which applies every filter it offers and throws on any it does not.
//
// MUTATION-PROVED on commit:
//   - treating "0 rows written" as success turns "never answers recorded when nothing was written" red
//   - dropping the organisation scope for a signed-in client turns "cannot answer for another client" red
//   - with no secret set, the token path refuses and writes nothing

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { createStrictFakeDb, type StrictFakeDb } from '@/lib/meetings/__tests__/helpers/strict-fake-db'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

// The login-based client: only used to learn who is signed in and their role.
const session = vi.hoisted(() => ({ user: null as null | { id: string }, userRow: null as null | Record<string, unknown> }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: session.user }, error: null }) },
    from: (table: string) => {
      if (table !== 'users') throw new Error(`the session client must only read users, not ${table}`)
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: session.userRow, error: null }) }
      return chain
    },
  })),
}))

const createServiceRoleClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service-role', () => ({ createServiceRoleClient }))

import * as routeModule from './route'
import { POST } from './route'
import { generateConfirmationToken } from '@/lib/meetings/confirmation-token'

const SECRET = 'test-only-confirmation-secret-0123456789abcdef'
const ORG_A = 'org-a'
const ORG_B = 'org-b'

function meeting(id: string, organisationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id, organisation_id: organisationId, meeting_status: 'booked', held_decision_locked: false,
    held_confirmed_by: null, is_billable: false, ...overrides,
  }
}

let db: StrictFakeDb
function seed(meetings: Record<string, unknown>[], opts: { silentlyBlockUpdatesTo?: string } = {}) {
  db = createStrictFakeDb({ meetings }, opts)
  createServiceRoleClient.mockResolvedValue(db.client)
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request('http://localhost/api/meetings/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest)
}

let savedSecret: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  savedSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
  session.user = null
  session.userRow = null
  seed([meeting('m-1', ORG_A), meeting('m-2', ORG_B)])
})
afterEach(() => {
  if (savedSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = savedSecret
})

describe('scanner safety', () => {
  it('exports only POST, so a scanner pre-fetching a link cannot change anything', () => {
    expect((routeModule as Record<string, unknown>).GET).toBeUndefined()
    expect((routeModule as Record<string, unknown>).HEAD).toBeUndefined()
    expect(typeof POST).toBe('function')
  })
})

describe('a client answering through the emailed link', () => {
  it('records a no-show: written, locked, not billable', async () => {
    const res = await post({ token: generateConfirmationToken('m-1', ORG_A), decision: 'no_show' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ recorded: true })
    expect(db.tables.meetings.find(m => m.id === 'm-1')).toMatchObject({
      meeting_status: 'no_show', held_decision_locked: true, held_confirmed_by: 'client', is_billable: false,
    })
  })

  it('records held: written, locked, billable', async () => {
    await post({ token: generateConfirmationToken('m-1', ORG_A), decision: 'held' })
    expect(db.tables.meetings.find(m => m.id === 'm-1')).toMatchObject({
      meeting_status: 'held', held_confirmed_by: 'client', is_billable: true,
    })
  })

  it('a token for one organisation cannot reach another organisation\'s meeting', async () => {
    const res = await post({ token: generateConfirmationToken('m-2', ORG_A), decision: 'held' })
    expect(res.status).toBe(404)
    expect(db.tables.meetings.find(m => m.id === 'm-2')).toMatchObject({ meeting_status: 'booked', is_billable: false })
  })

  it('with no secret set, refuses the link and writes nothing', async () => {
    const token = generateConfirmationToken('m-1', ORG_A)
    delete process.env.JWT_SECRET
    const res = await post({ token, decision: 'held' })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ recorded: false, reason: 'secret_not_configured' })
    expect(db.calls).toEqual([])
  })

  it('an invalid link is refused and writes nothing', async () => {
    const res = await post({ token: 'not-a-token', decision: 'held' })
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
  })
})

describe('a signed-in client', () => {
  beforeEach(() => {
    session.user = { id: 'user-client' }
    session.userRow = { role: 'client', organisation_id: ORG_A }
  })

  it('records their own no-show, which is the case that used to be thanked and discarded', async () => {
    const res = await post({ meeting_id: 'm-1', decision: 'no_show' })
    expect(res.status).toBe(200)
    expect(db.tables.meetings.find(m => m.id === 'm-1')).toMatchObject({ meeting_status: 'no_show', held_decision_locked: true })
  })

  it('cannot answer for another client\'s meeting', async () => {
    const res = await post({ meeting_id: 'm-2', decision: 'held' })
    expect(res.status).toBe(404)
    expect(db.tables.meetings.find(m => m.id === 'm-2')).toMatchObject({ meeting_status: 'booked', is_billable: false })
  })
})

describe('never answers "recorded" when nothing was written', () => {
  it('an update that touches no row is reported as NOT recorded, and says so', async () => {
    session.user = { id: 'user-client' }
    session.userRow = { role: 'client', organisation_id: ORG_A }
    seed([meeting('m-1', ORG_A)], { silentlyBlockUpdatesTo: 'meetings' })

    const res = await post({ meeting_id: 'm-1', decision: 'no_show' })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.recorded).toBe(false)
    expect(body.message).toMatch(/not recorded/i)
    expect(body.message).not.toMatch(/thank|already recorded/i)
    expect(db.tables.meetings[0]).toMatchObject({ meeting_status: 'booked', held_decision_locked: false })
  })

  it('an already-decided meeting says what it was decided as, and that this answer was not recorded', async () => {
    seed([meeting('m-1', ORG_A, { meeting_status: 'held', held_decision_locked: true, held_confirmed_by: 'operator', is_billable: true })])
    const res = await post({ token: generateConfirmationToken('m-1', ORG_A), decision: 'no_show' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.recorded).toBe(false)
    expect(body.message).toMatch(/already recorded as held.*not recorded/i)
    expect(db.tables.meetings[0]).toMatchObject({ meeting_status: 'held', is_billable: true })
  })

  it('a cancelled meeting cannot be answered', async () => {
    seed([meeting('m-1', ORG_A, { meeting_status: 'canceled' })])
    const res = await post({ token: generateConfirmationToken('m-1', ORG_A), decision: 'held' })
    expect(res.status).toBe(409)
    expect(db.tables.meetings[0]).toMatchObject({ meeting_status: 'canceled', is_billable: false })
  })
})

describe('an operator', () => {
  it('can mark any organisation\'s meeting, recorded as the operator', async () => {
    session.user = { id: 'user-operator' }
    session.userRow = { role: 'operator', organisation_id: 'operator-home-org' }
    const res = await post({ meeting_id: 'm-2', decision: 'held' })
    expect(res.status).toBe(200)
    expect(db.tables.meetings.find(m => m.id === 'm-2')).toMatchObject({ meeting_status: 'held', held_confirmed_by: 'operator', is_billable: true })
  })
})

describe('request validation', () => {
  it('rejects a missing or unknown decision before reading anything', async () => {
    expect((await post({ token: 'x' })).status).toBe(400)
    expect((await post({ token: 'x', decision: 'rescheduled' })).status).toBe(400)
    expect(db.calls).toEqual([])
  })

  it('with neither a link nor a session, refuses', async () => {
    const res = await post({ meeting_id: 'm-1', decision: 'held' })
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
  })
})
