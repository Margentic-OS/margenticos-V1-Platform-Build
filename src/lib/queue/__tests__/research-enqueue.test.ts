// The research enqueue guards.
//
// These mirror runResearchBatchForOrg's refusals. While both paths exist behind the flag,
// a prospect must be eligible under ONE definition, or flipping the flag would change
// WHICH prospects get researched rather than only how.

import { describe, it, expect } from 'vitest'
import { enqueueResearchForOrganisation } from '../enqueue/research'

const ORG = 'org-a'

interface FakeProspect {
  id: string
  personalisation_trigger: string | null
  suppressed?: boolean
  researched?: boolean
  /**
   * Verification verdict. Defaults to a clean Valid, because the send-eligibility gate
   * added 2026-08-25 FAILS CLOSED on a missing verdict: a fixture without these would be
   * filtered out entirely and every assertion below would pass vacuously against an empty
   * batch. Tests that want the gate to bite set them explicitly.
   */
  verified_at?: string | null
  email_status?: string | null
  ineligible_reason?: string | null
}

/** A client whose organisations and prospects tables answer the enqueue query. */
function fake(prospects: FakeProspect[], opts: { archived?: boolean; orgMissing?: boolean } = {}) {
  const enqueued: Array<Record<string, unknown>> = []
  const filters: Record<string, unknown> = {}

  const client = {
    from(table: string) {
      if (table === 'organisations') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: async () => ({
            data: opts.orgMissing || opts.archived ? null : { id: ORG },
            error: null,
          }),
        }
        return chain
      }
      // prospects
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { filters[c] = v; return chain },
        limit: () => chain,
        is: (c: string) => { filters[`${c}_isNull`] = true; return chain },
        not: (c: string) => { filters[`${c}_notNull`] = true; return chain },
        then: (resolve: (v: unknown) => void) => {
          const wantResearched = filters.current_research_result_id_notNull === true
          const rows = prospects
            .filter(p => (p.suppressed ?? false) === false)
            .filter(p => (p.researched ?? false) === wantResearched)
            .map(p => ({
              id: p.id,
              personalisation_trigger: p.personalisation_trigger,
              independent_verified_at:      p.verified_at      !== undefined ? p.verified_at      : '2026-08-10T00:00:00Z',
              independent_email_status:     p.email_status     !== undefined ? p.email_status     : 'Valid',
              email_send_ineligible_reason: p.ineligible_reason !== undefined ? p.ineligible_reason : null,
            }))
          resolve({ data: rows, error: null })
        },
      }
      return chain
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== 'enqueue_job') return { data: null, error: { message: `unexpected rpc ${fn}` } }
      enqueued.push(args)
      return { data: [{ id: `job-${enqueued.length}`, ...args }], error: null }
    },
  }
  return { client: client as never, enqueued }
}

describe('enqueueResearchForOrganisation — the trigger guard', () => {
  it('REFUSES the whole batch when any prospect already holds a trigger', async () => {
    // updateProspect writes personalisation_trigger on EVERY run, so re-researching a
    // prospect whose copy is finished replaces it, or clears it when the judge holds.
    // Much of that copy has already shipped.
    const f = fake([
      { id: 'p1', personalisation_trigger: null },
      { id: 'p2', personalisation_trigger: 'An opening that already shipped.' },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/1 of 2 selected prospects already have a personalisation trigger/)
    // Refused as a whole, not partially enqueued: a partial enqueue would quietly
    // research a different set than the operator asked for.
    expect(f.enqueued).toHaveLength(0)
  })

  it('names the CLI as the only way to ask for it', async () => {
    const f = fake([{ id: 'p1', personalisation_trigger: 'shipped copy' }])
    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/--allow-overwrite-trigger/)
  })

  it('enqueues normally when no prospect holds a trigger', async () => {
    const f = fake([
      { id: 'p1', personalisation_trigger: null },
      { id: 'p2', personalisation_trigger: null },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.created).toBe(2)
    expect(f.enqueued).toHaveLength(2)
  })
})

describe('enqueueResearchForOrganisation — the other inherited guards', () => {
  it('refuses an archived organisation', async () => {
    // The one place the queue path DOES check archived. See BACKLOG: the claim path does
    // not, which is a separate recorded defect.
    const f = fake([{ id: 'p1', personalisation_trigger: null }], { archived: true })
    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/not found or archived/)
  })

  it('excludes suppressed prospects', async () => {
    // Suppressed means opted out or disqualified. Researching them spends money on copy
    // that can never be sent.
    const f = fake([
      { id: 'p1', personalisation_trigger: null },
      { id: 'p2', personalisation_trigger: null, suppressed: true },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    if (!result.ok) throw new Error('expected success')
    expect(result.created).toBe(1)
    expect(f.enqueued.map(e => e.p_prospect_id)).toEqual(['p1'])
  })

  it('scope unresearched selects only prospects with no research result', async () => {
    const f = fake([
      { id: 'fresh', personalisation_trigger: null, researched: false },
      { id: 'done',  personalisation_trigger: null, researched: true },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    if (!result.ok) throw new Error('expected success')
    expect(f.enqueued.map(e => e.p_prospect_id)).toEqual(['fresh'])
  })

  it('scope researched selects only prospects that have one', async () => {
    const f = fake([
      { id: 'fresh', personalisation_trigger: null, researched: false },
      { id: 'done',  personalisation_trigger: null, researched: true },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'researched', 'test')

    if (!result.ok) throw new Error('expected success')
    expect(f.enqueued.map(e => e.p_prospect_id)).toEqual(['done'])
  })

  it('explains WHICH scope found nothing rather than a bare empty result', async () => {
    const f = fake([{ id: 'done', personalisation_trigger: null, researched: true }])
    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/already been researched/)
  })

  it('enqueues as the job type research, not anything else', async () => {
    const f = fake([{ id: 'p1', personalisation_trigger: null }])
    await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'operator:doug')
    expect(f.enqueued[0]).toMatchObject({
      p_job_type: 'research',
      p_organisation_id: ORG,
      p_enqueued_by: 'operator:doug',
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SEND-ELIGIBILITY GATE, added 2026-08-25.
//
// Measured on the first real queue batch: 12 of 13 prospects had already been verified as
// unmailable BEFORE research ran, and it ran anyway. $2.56 spent, one mailable prospect
// bought. The policy itself is unit-tested in
// src/lib/sourcing/__tests__/send-eligibility-policy.test.ts; these assert that enqueue
// actually applies it, reports it, and does not refuse the whole batch over it.
describe('enqueueResearchForOrganisation — the send-eligibility gate', () => {
  it('skips the ineligible and still enqueues the rest', async () => {
    const f = fake([
      { id: 'ok',       personalisation_trigger: null },
      { id: 'catchall', personalisation_trigger: null, email_status: 'Catch All' },
      { id: 'invalid',  personalisation_trigger: null, email_status: 'Invalid' },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    // A SKIP, not a refusal. Unlike the trigger guard, this protects spend rather than
    // an existing artefact, so filtering is the intended behaviour.
    expect(f.enqueued.map(e => e.p_prospect_id)).toEqual(['ok'])
    expect(result.selected).toBe(3)
    expect(result.created).toBe(1)
    expect(result.skippedIneligible).toBe(2)
  })

  it('reports WHY it skipped, so the filter cannot become invisible', async () => {
    const f = fake([
      { id: 'ok',  personalisation_trigger: null },
      { id: 'c1',  personalisation_trigger: null, email_status: 'Catch All' },
      { id: 'c2',  personalisation_trigger: null, email_status: 'Catch All' },
      { id: 'bad', personalisation_trigger: null, email_status: 'Invalid' },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    if (!result.ok) throw new Error('expected success')
    expect(result.skippedBreakdown).toBe('2 catch-all domain, 1 verified undeliverable')
  })

  it('FAILS CLOSED on a prospect that has never been verified', async () => {
    const f = fake([
      { id: 'unverified', personalisation_trigger: null, verified_at: null, email_status: null },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/never verified/)
    expect(f.enqueued).toHaveLength(0)
  })

  it('explains itself when everything is filtered out, rather than saying nothing to do', async () => {
    const f = fake([
      { id: 'c1', personalisation_trigger: null, email_status: 'Catch All' },
      { id: 'c2', personalisation_trigger: null, email_status: 'Catch All' },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/2 catch-all domain/)
    // Names the one file to change, so the next person does not go looking.
    expect(result.error).toMatch(/send-eligibility-policy\.ts/)
  })

  it('reports nothing skipped when every prospect is eligible', async () => {
    const f = fake([
      { id: 'p1', personalisation_trigger: null },
      { id: 'p2', personalisation_trigger: null },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    if (!result.ok) throw new Error('expected success')
    expect(result.skippedIneligible).toBe(0)
    expect(result.skippedBreakdown).toBeNull()
    expect(f.enqueued.map(e => e.p_prospect_id)).toEqual(['p1', 'p2'])
  })

  // Ordering matters: the trigger guard is DESTRUCTIVE-write protection and must refuse the
  // whole batch before the spend filter quietly narrows it.
  it('lets the trigger guard refuse first, even when some prospects are also ineligible', async () => {
    const f = fake([
      { id: 'shipped', personalisation_trigger: 'already sent' },
      { id: 'c1',      personalisation_trigger: null, email_status: 'Catch All' },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/already have a personalisation trigger/)
    expect(f.enqueued).toHaveLength(0)
  })
})
