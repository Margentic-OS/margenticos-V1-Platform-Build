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
            .map(p => ({ id: p.id, personalisation_trigger: p.personalisation_trigger }))
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
