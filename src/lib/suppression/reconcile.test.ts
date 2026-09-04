// Tests for the reconciliation sweep — the instrument that says a suppression did not
// reach the provider.
//
// The case that matters most is the FIRST one: a prospect suppressed by a hand-written
// UPDATE, which leaves outbound_suppression_status NULL. That is what actually happened on
// 2026-09-04, and a sweep that read our own suppression columns to decide what to check
// would skip exactly that row and report zero for ever.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))

const readLead = vi.fn()
const stopLead = vi.fn()
const findLeadIds = vi.fn()

vi.mock('@/lib/integrations/capabilities/suppress-contact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/integrations/capabilities/suppress-contact')>()
  return {
    ...actual,
    resolveSuppressContactHandler: vi.fn(async () => resolveResult),
  }
})

const findBlockedProspects = vi.fn()
vi.mock('./send-gate', () => ({
  findBlockedProspects: (...args: unknown[]) => findBlockedProspects(...args),
}))

import { reconcileSuppression, SETTLE_WINDOW_MINUTES } from './reconcile'

/* eslint-disable @typescript-eslint/no-explicit-any */
let resolveResult: any

interface Row {
  id: string
  organisation_id: string
  email: string | null
  outbound_lead_id: string | null
  outbound_suppression_at: string | null
}

/**
 * A fake prospects table that HONOURS the uploaded filter and throws on anything else.
 *
 * Honouring it matters: the sweep selects on outbound_upload_status rather than on the lead
 * id precisely so that a row marked uploaded with no lead id is visible as an invariant
 * breach. A fake that ignored the filter would return the same rows either way and could
 * not tell the two selectors apart.
 */
function createFakeDb(rows: Row[], opts: { error?: string } = {}) {
  const client: any = {
    from(table: string) {
      if (table !== 'prospects') throw new Error(`fake does not implement table ${table}`)
      const state: { eq: Record<string, string> } = { eq: {} }
      const builder: any = {
        select: () => builder,
        eq: (col: string, v: string) => { state.eq[col] = v; return builder },
        then: (resolve: (v: unknown) => void) => {
          if (opts.error) {
            return Promise.resolve(resolve({ data: null, error: { message: opts.error } }))
          }
          if (state.eq.outbound_upload_status === undefined) {
            throw new Error('fake: the sweep must filter on outbound_upload_status')
          }
          const matched = rows.filter(() => state.eq.outbound_upload_status === 'uploaded')
          return Promise.resolve(resolve({ data: matched, error: null }))
        },
      }
      return builder
    },
  }
  return client
}

function gateBlocks(ids: string[]) {
  findBlockedProspects.mockResolvedValue({
    ok: true,
    blocked: new Map(ids.map(id => [id, 'prospect_suppressed'])),
  })
}

const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

beforeEach(() => {
  readLead.mockReset()
  stopLead.mockReset()
  findLeadIds.mockReset()
  findBlockedProspects.mockReset()
  resolveResult = { ok: true, handler: { toolName: 'fake', stopLead, findLeadIds, readLead } }
})

describe('reconcileSuppression', () => {
  it('finds a suppressed prospect the provider is still sending to, with NULL suppression columns', async () => {
    // THE 2026-09-04 CASE, EXACTLY. Suppressed by hand, so outbound_suppression_at is NULL
    // and outbound_suppression_status is NULL. The provider still has them Active.
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: null },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: 1, interestStatus: null } })

    const v = await reconcileSuppression(db)

    expect(v.unreconciledCount).toBe(1)
    expect(v.unreconciledProspectIds).toEqual(['p1'])
    expect(v.checkedCount).toBe(1)
    // A NULL suppression stamp must never be read as "still settling". Nothing is in flight.
    expect(v.settlingCount).toBe(0)
    expect(v.detail).toContain('still being sent to')
  })

  it('passes a suppressed prospect the provider has stopped', async () => {
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: OLD },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: 3, interestStatus: -1 } })

    const v = await reconcileSuppression(db)

    expect(v.unreconciledCount).toBe(0)
    expect(v.checkedCount).toBe(1)
    expect(v.detail).toContain('have stopped')
  })

  it('treats PAUSED as still sending, because a paused lead can resume', async () => {
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: OLD },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: 2, interestStatus: null } })

    expect((await reconcileSuppression(db)).unreconciledCount).toBe(1)
  })

  it('treats an unreadable status as still sending, never as fine', async () => {
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: OLD },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: null, interestStatus: -1 } })

    expect((await reconcileSuppression(db)).unreconciledCount).toBe(1)
  })

  it('counts a lead the provider will not answer for as unreachable, not as checked', async () => {
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: OLD },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: false, error: 'provider 500' })

    const v = await reconcileSuppression(db)
    expect(v.unreachableCount).toBe(1)
    expect(v.checkedCount).toBe(0)
    expect(v.unreconciledCount).toBe(0)
    expect(v.detail).toContain('unknown rather than fine')
  })

  it('skips a prospect suppressed inside the settle window, and says so', async () => {
    // The provider applies a stop asynchronously: measured at about 43 seconds. Without this
    // the monitor would flicker red on every normal suppression.
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1',
        outbound_suppression_at: new Date(Date.now() - 60_000).toISOString() },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: 1, interestStatus: -1 } })

    const v = await reconcileSuppression(db)
    expect(v.settlingCount).toBe(1)
    expect(v.unreconciledCount).toBe(0)
    expect(readLead).not.toHaveBeenCalled()
    expect(v.detail).toContain(`last ${SETTLE_WINDOW_MINUTES} minutes`)
  })

  it('judges a prospect suppressed BEFORE the settle window rather than skipping for ever', async () => {
    // The window must be a delay, not an exemption.
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1',
        outbound_suppression_at: new Date(Date.now() - (SETTLE_WINDOW_MINUTES + 5) * 60_000).toISOString() },
    ])
    gateBlocks(['p1'])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: 1, interestStatus: -1 } })

    const v = await reconcileSuppression(db)
    expect(v.settlingCount).toBe(0)
    expect(v.unreconciledCount).toBe(1)
  })

  it('reports an uploaded prospect with no provider lead id as an invariant breach', async () => {
    // ASSERTED, NOT ASSUMED. It held on all 26 rows on 2026-09-04. If it stops holding, the
    // sweep loses its handle on those prospects and must say so rather than report zero.
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: null, outbound_suppression_at: null },
    ])
    gateBlocks(['p1'])

    const v = await reconcileSuppression(db)
    expect(v.invariantBreachCount).toBe(1)
    expect(v.detail).toContain('no provider lead id')
    // Not double-counted as unreachable, or one row would raise two alarms.
    expect(v.unreachableCount).toBe(0)
  })

  it('ignores a prospect the send gate does NOT block, however suppressed it looks', async () => {
    // "Who must not be mailed" is defined in findBlockedProspects and nowhere else. A second
    // definition here could go green over exactly the prospects the gate blocks.
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: OLD },
    ])
    gateBlocks([])
    readLead.mockResolvedValue({ ok: true, state: { leadId: 'lead-1', status: 1, interestStatus: null } })

    const v = await reconcileSuppression(db)
    expect(v.blockedCount).toBe(0)
    expect(v.unreconciledCount).toBe(0)
    expect(readLead).not.toHaveBeenCalled()
    // And the denominator is still reported, so this cannot read as "nothing was examined".
    expect(v.uploadedCount).toBe(1)
    expect(v.detail).toContain('1 uploaded prospect')
  })

  it('fails closed when the send gate fails, rather than reporting zero unreconciled', async () => {
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'lead-1', outbound_suppression_at: OLD },
    ])
    findBlockedProspects.mockResolvedValue({ ok: false, error: 'suppression list unreadable' })

    const v = await reconcileSuppression(db)
    expect(v.incomplete).toBe(true)
    expect(v.detail).toContain('No count here is a statement about the provider')
  })

  it('fails closed when the capability does not resolve', async () => {
    resolveResult = { ok: false, error: 'no active tool provides can_suppress_contact' }
    const v = await reconcileSuppression(createFakeDb([]))

    expect(v.incomplete).toBe(true)
    expect(v.detail).toContain('No count here is a statement about the provider')
  })

  it('fails closed when the prospects read fails', async () => {
    const v = await reconcileSuppression(createFakeDb([], { error: 'connection reset' }))
    expect(v.incomplete).toBe(true)
    expect(v.detail).toContain('connection reset')
  })

  it('reports the denominator when there is nothing suppressed, so zero is not a bare zero', async () => {
    const v = await reconcileSuppression(createFakeDb([]))
    expect(v.uploadedCount).toBe(0)
    expect(v.blockedCount).toBe(0)
    // uploaded_count 0 is what mon_026 maps to UNKNOWN rather than OK.
    expect(v.detail).toContain('Nothing to reconcile')
  })

  it('checks each organisation through the gate separately', async () => {
    // The gate is per organisation by design; one call for two organisations would scope
    // gate 1 to whichever id was passed and silently miss the other.
    const db = createFakeDb([
      { id: 'p1', organisation_id: 'org-1', email: 'a@b.com', outbound_lead_id: 'l1', outbound_suppression_at: OLD },
      { id: 'p2', organisation_id: 'org-2', email: 'c@d.com', outbound_lead_id: 'l2', outbound_suppression_at: OLD },
    ])
    gateBlocks([])

    await reconcileSuppression(db)

    expect(findBlockedProspects).toHaveBeenCalledTimes(2)
    const orgs = findBlockedProspects.mock.calls.map(c => c[1]).sort()
    expect(orgs).toEqual(['org-1', 'org-2'])
  })
})
