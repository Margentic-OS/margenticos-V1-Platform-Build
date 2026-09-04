// Tests for the shared path that carries a suppression out to the sending provider.
//
// THE FAKES HERE THROW ON ANYTHING THEY DO NOT IMPLEMENT.
//
// CLAUDE.md records three separate occasions where a fake silently accepted a call it did
// not honour, and the production code was correct while the test was structurally unable to
// notice when it stopped being. A fake handler that quietly returned success for a lead it
// was never asked about would make every assertion below meaningless.
//
// So the handler fake records every call, and the capability resolver fake refuses a table
// it does not serve.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))

const stopLead = vi.fn()
const findLeadIds = vi.fn()
const readLead = vi.fn()

vi.mock('@/lib/integrations/capabilities/suppress-contact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/integrations/capabilities/suppress-contact')>()
  return {
    ...actual,
    resolveSuppressContactHandler: vi.fn(async () => resolveResult),
  }
})

import {
  suppressProspectAtProvider,
  suppressAddressAtProvider,
} from './provider-suppression'

/* eslint-disable @typescript-eslint/no-explicit-any */
let resolveResult: any

interface ProspectRow {
  id: string
  organisation_id: string
  email: string | null
}

/**
 * A fake prospects table that records every UPDATE and REFUSES every other table.
 *
 * The refusal is the point. A fake that returns a chain for an unknown table lets a code
 * path write somewhere nobody is asserting on.
 */
function createFakeDb(rows: ProspectRow[] = []) {
  const updates: Array<Record<string, unknown>> = []

  const client: any = {
    updates,
    from(table: string) {
      if (table !== 'prospects') {
        throw new Error(`fake does not implement table ${table}`)
      }
      const state: { values?: Record<string, unknown>; eq: Record<string, string> } = { eq: {} }
      const builder: any = {
        update: (values: Record<string, unknown>) => { state.values = values; return builder },
        select: () => builder,
        eq: (col: string, v: string) => { state.eq[col] = v; return builder },
        // Thenable, so the chain resolves wherever the production code stops adding filters
        // rather than at a position this fake guessed. An UPDATE here ends on its second
        // .eq() and the address SELECT ends on its first, and a fake that resolved on a
        // fixed one would dictate the shape of the code under test.
        then: (resolve: (v: unknown) => void) => {
          if (state.values) {
            if (state.eq.id === undefined || state.eq.organisation_id === undefined) {
              // Both filters or nothing. An UPDATE scoped to the id alone would cross
              // organisations, and a fake that accepted it could not tell us.
              throw new Error('fake: prospect UPDATE must filter on id AND organisation_id')
            }
            updates.push({ ...state.values, __id: state.eq.id, __org: state.eq.organisation_id })
            return Promise.resolve(resolve({ data: null, error: null }))
          }
          const matched = rows.filter(r => r.email === state.eq.email)
          return Promise.resolve(
            resolve({ data: matched.map(r => ({ id: r.id, organisation_id: r.organisation_id })), error: null }),
          )
        },
      }
      return builder
    },
  }
  return client
}

function okHandler() {
  return {
    ok: true as const,
    handler: { toolName: 'fake', stopLead, findLeadIds, readLead },
  }
}

beforeEach(() => {
  stopLead.mockReset()
  findLeadIds.mockReset()
  readLead.mockReset()
  resolveResult = okHandler()
})

describe('suppressProspectAtProvider', () => {
  it('stops the stored lead AND every duplicate the address lookup finds', async () => {
    // THE REQUIREMENT THIS EXISTS FOR. The resolver it replaces asked for limit 1 and took
    // items[0], so a person held as two leads had one stopped and the rest left sending.
    findLeadIds.mockResolvedValue({ ok: true, leadIds: ['lead-dupe'] })
    stopLead.mockResolvedValue({ ok: true, state: { leadId: 'x', status: 3, interestStatus: -1 } })

    const db = createFakeDb()
    const result = await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'Person@Example.com',
      outbound_lead_id: 'lead-stored',
    })

    expect(result.status).toBe('confirmed')
    expect(result.stoppedLeadIds.sort()).toEqual(['lead-dupe', 'lead-stored'])
    expect(stopLead).toHaveBeenCalledTimes(2)
    // The address is normalised before the lookup, or a capitalised address escapes.
    expect(findLeadIds).toHaveBeenCalledWith('person@example.com', 'org-1')
  })

  it('records a PARTIAL success as failed, not as success', async () => {
    // "Some of this person's leads were stopped" is not a state anybody can act on, and
    // reporting it as success is how duplicates were left sending.
    findLeadIds.mockResolvedValue({ ok: true, leadIds: ['lead-b'] })
    stopLead.mockImplementation(async (id: string) =>
      id === 'lead-a'
        ? { ok: true, state: { leadId: id, status: 3, interestStatus: -1 } }
        : { ok: false, error: 'provider said no', state: null },
    )

    const db = createFakeDb()
    const result = await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'a@b.com',
      outbound_lead_id: 'lead-a',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('1 of 2')
    expect(result.stoppedLeadIds).toEqual(['lead-a'])
  })

  it('treats a FAILED address lookup as a failure, never as "no duplicates"', async () => {
    // "We could not ask" and "there are none" are different answers and only one is safe to
    // record as success.
    findLeadIds.mockResolvedValue({ ok: false, error: 'provider 500' })
    stopLead.mockResolvedValue({ ok: true, state: { leadId: 'x', status: 3, interestStatus: -1 } })

    const db = createFakeDb()
    const result = await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'a@b.com',
      outbound_lead_id: 'lead-a',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('address lookup failed')
    // And nothing was stopped, because a partial view of the leads is not a basis to act.
    expect(stopLead).not.toHaveBeenCalled()
  })

  it('reports not_required when the provider holds nothing, and writes that to the row', async () => {
    findLeadIds.mockResolvedValue({ ok: true, leadIds: [] })

    const db = createFakeDb()
    const result = await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'a@b.com',
      outbound_lead_id: null,
    })

    expect(result.status).toBe('not_required')
    expect(stopLead).not.toHaveBeenCalled()
    expect(db.updates[0].outbound_suppression_status).toBe('not_required')
    // The CHECK constraint permits an error only on a failed row.
    expect(db.updates[0].outbound_suppression_error).toBeNull()
  })

  it('writes the failure and its reason onto the prospect row', async () => {
    // Requirement: the record must not claim suppressed while the provider was never told.
    findLeadIds.mockResolvedValue({ ok: true, leadIds: [] })
    stopLead.mockResolvedValue({ ok: false, error: 'provider 503', state: null })

    const db = createFakeDb()
    await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'a@b.com',
      outbound_lead_id: 'lead-a',
    })

    expect(db.updates[0].outbound_suppression_status).toBe('failed')
    expect(String(db.updates[0].outbound_suppression_error)).toContain('provider 503')
  })

  it('records a failure rather than throwing when the capability does not resolve', async () => {
    resolveResult = { ok: false, error: 'no active tool provides can_suppress_contact' }

    const db = createFakeDb()
    const result = await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'a@b.com',
      outbound_lead_id: 'lead-a',
    })

    expect(result.status).toBe('failed')
    expect(db.updates[0].outbound_suppression_status).toBe('failed')
  })

  it('records a failure rather than escaping when a handler throws', async () => {
    // The handlers throw InstantlyFlagError on a flag misconfiguration. An exception
    // escaping here would abandon the suppression path mid-way.
    findLeadIds.mockRejectedValue(new Error('flag is off'))

    const db = createFakeDb()
    const result = await suppressProspectAtProvider(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'a@b.com',
      outbound_lead_id: 'lead-a',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('flag is off')
  })
})

describe('suppressAddressAtProvider', () => {
  it('stops every lead the provider holds for the address', async () => {
    findLeadIds.mockResolvedValue({ ok: true, leadIds: ['l1', 'l2', 'l3'] })
    stopLead.mockResolvedValue({ ok: true, state: { leadId: 'x', status: 3, interestStatus: -1 } })

    const db = createFakeDb()
    const result = await suppressAddressAtProvider(db, 'org-1', 'BOB@Example.com ')

    expect(result.status).toBe('confirmed')
    expect(result.stoppedLeadIds).toEqual(['l1', 'l2', 'l3'])
    expect(findLeadIds).toHaveBeenCalledWith('bob@example.com', 'org-1')
  })

  it('leaves the same evidence on the matching prospect rows', async () => {
    findLeadIds.mockResolvedValue({ ok: true, leadIds: ['l1'] })
    stopLead.mockResolvedValue({ ok: true, state: { leadId: 'l1', status: 3, interestStatus: -1 } })

    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'bob@example.com' },
      { id: 'p2', organisation_id: 'org-2', email: 'bob@example.com' },
    ])

    await suppressAddressAtProvider(db, 'org-1', 'bob@example.com')

    // BOTH organisations' rows, because the global list is global by design and a bounce
    // seen in one client's campaign suppresses the address everywhere.
    const ids = db.updates.map((u: Record<string, unknown>) => u.__id).sort()
    expect(ids).toEqual(['p1', 'p2'])
    for (const u of db.updates) expect(u.outbound_suppression_status).toBe('confirmed')
  })

  it('refuses a blank address rather than sweeping every lead', async () => {
    const db = createFakeDb()
    const result = await suppressAddressAtProvider(db, 'org-1', '   ')

    expect(result.status).toBe('failed')
    expect(findLeadIds).not.toHaveBeenCalled()
  })
})
