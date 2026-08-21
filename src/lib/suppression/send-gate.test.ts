// Tests for the send gate — the one function that decides whether a prospect may be
// sent to, and the one place both suppression gates are checked together.
//
// These drive the real findBlockedProspects against a fake Supabase serving both the
// prospects table (gate 1, per organisation) and suppressed_emails (gate 2, global).
//
// The case that matters most is the last one: an unsubscribe recorded from org A must
// block a send from org B. That is the whole reason this table is separate from
// prospects.suppressed, and a per-org table could not express it.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))

import { findBlockedProspects } from './send-gate'

interface FakeProspect {
  id: string
  organisation_id: string
  email: string | null
  suppressed: boolean
  client_review_status: string | null
}

interface FakeSuppression {
  email: string
  revoked_at: string | null
}

function createFakeDb(opts: {
  prospects?: FakeProspect[]
  suppressions?: FakeSuppression[]
  prospectsError?: string
  suppressionsError?: string
}) {
  const prospects = opts.prospects ?? []
  const suppressions = opts.suppressions ?? []

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'prospects') {
        const state: { orgId?: string; ids?: string[] } = {}
        const builder: any = {
          select: () => builder,
          eq: (_c: string, v: string) => { state.orgId = v; return builder },
          in: (_c: string, v: string[]) => { state.ids = v; return builder },
          or: (_expr: string) => {
            // Mirrors 'suppressed.eq.true,client_review_status.eq.rejected'
            if (opts.prospectsError) {
              return Promise.resolve({ data: null, error: { message: opts.prospectsError } })
            }
            const matched = prospects.filter(p =>
              p.organisation_id === state.orgId &&
              (state.ids ?? []).includes(p.id) &&
              (p.suppressed === true || p.client_review_status === 'rejected')
            )
            return Promise.resolve({
              data: matched.map(p => ({
                id: p.id,
                suppressed: p.suppressed,
                client_review_status: p.client_review_status,
              })),
              error: null,
            })
          },
        }
        return builder
      }

      if (table === 'suppressed_emails') {
        const state: { emails?: string[] } = {}
        const builder: any = {
          select: () => builder,
          in: (_c: string, v: string[]) => { state.emails = v; return builder },
          is: () => builder,
          then: (resolve: (v: unknown) => unknown) => {
            if (opts.suppressionsError) {
              return resolve({ data: null, error: { message: opts.suppressionsError } })
            }
            const matched = suppressions.filter(s =>
              (state.emails ?? []).includes(s.email) && s.revoked_at === null
            )
            return resolve({ data: matched.map(s => ({ email: s.email })), error: null })
          },
        }
        return builder
      }

      throw new Error(`unexpected table ${table}`)
    },
  }

  return client
}

const ORG_A = 'org-a'
const ORG_B = 'org-b'

describe('findBlockedProspects', () => {
  it('lets a clean prospect through', async () => {
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'fine@x.com', suppressed: false, client_review_status: 'approved' }],
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'fine@x.com' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.size).toBe(0)
  })

  it('blocks an address on the global suppression list', async () => {
    // The upload-excludes-a-suppressed-address case.
    const db = createFakeDb({
      prospects: [
        { id: 'p1', organisation_id: ORG_A, email: 'bounced@x.com', suppressed: false, client_review_status: 'approved' },
        { id: 'p2', organisation_id: ORG_A, email: 'fine@x.com', suppressed: false, client_review_status: 'approved' },
      ],
      suppressions: [{ email: 'bounced@x.com', revoked_at: null }],
    })

    const result = await findBlockedProspects(db, ORG_A, [
      { id: 'p1', email: 'bounced@x.com' },
      { id: 'p2', email: 'fine@x.com' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.get('p1')).toBe('globally_suppressed')
    expect(result.blocked.has('p2')).toBe(false)
  })

  it('matches the global list case-insensitively', async () => {
    // The prospect record carries BOB@X.COM; the list carries bob@x.com. Same person.
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'BOB@X.COM', suppressed: false, client_review_status: 'approved' }],
      suppressions: [{ email: 'bob@x.com', revoked_at: null }],
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: '  BOB@X.COM ' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.get('p1')).toBe('globally_suppressed')
  })

  it('does not block an address whose suppression was revoked', async () => {
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'lifted@x.com', suppressed: false, client_review_status: 'approved' }],
      suppressions: [{ email: 'lifted@x.com', revoked_at: '2026-08-21T00:00:00Z' }],
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'lifted@x.com' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.size).toBe(0)
  })

  it('blocks org B for an unsubscribe recorded from org A', async () => {
    // The reason this table is global and separate from prospects.suppressed.
    // Org B has its own prospect row, clean by every per-organisation measure.
    const db = createFakeDb({
      prospects: [{ id: 'p-in-b', organisation_id: ORG_B, email: 'person@x.com', suppressed: false, client_review_status: 'approved' }],
      // Recorded while polling org A's campaign.
      suppressions: [{ email: 'person@x.com', revoked_at: null }],
    })

    const result = await findBlockedProspects(db, ORG_B, [{ id: 'p-in-b', email: 'person@x.com' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.get('p-in-b')).toBe('globally_suppressed')
  })

  it('still blocks on prospects.suppressed, which is an independent gate', async () => {
    // Nothing on the global list. The per-organisation gate must still fire, because it
    // carries meanings the global list knows nothing about.
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'rejected@x.com', suppressed: true, client_review_status: null }],
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'rejected@x.com' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.get('p1')).toBe('prospect_suppressed')
  })

  it('still blocks on client_review_status = rejected', async () => {
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'rejected@x.com', suppressed: false, client_review_status: 'rejected' }],
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'rejected@x.com' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.get('p1')).toBe('client_rejected')
  })

  it('keeps the per-organisation reason when both gates fire on the same prospect', async () => {
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'both@x.com', suppressed: true, client_review_status: 'rejected' }],
      suppressions: [{ email: 'both@x.com', revoked_at: null }],
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'both@x.com' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked.get('p1')).toBe('prospect_suppressed')
  })

  it('fails closed when the per-organisation query errors', async () => {
    const db = createFakeDb({ prospectsError: 'connection reset' })
    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'a@x.com' }])
    expect(result.ok).toBe(false)
  })

  it('fails closed when the global list query errors', async () => {
    // A gate that degrades to "allow all" when it cannot read the list is not a gate.
    const db = createFakeDb({
      prospects: [{ id: 'p1', organisation_id: ORG_A, email: 'a@x.com', suppressed: false, client_review_status: 'approved' }],
      suppressionsError: 'permission denied',
    })

    const result = await findBlockedProspects(db, ORG_A, [{ id: 'p1', email: 'a@x.com' }])
    expect(result.ok).toBe(false)
  })

  it('returns nothing blocked for an empty candidate list without querying', async () => {
    const db = createFakeDb({})
    const result = await findBlockedProspects(db, ORG_A, [])
    expect(result.ok && result.blocked.size).toBe(0)
  })
})
