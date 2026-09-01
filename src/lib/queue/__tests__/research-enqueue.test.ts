// The research enqueue guards.
//
// These mirror runResearchBatchForOrg's refusals. While both paths exist behind the flag,
// a prospect must be eligible under ONE definition, or flipping the flag would change
// WHICH prospects get researched rather than only how.

import { describe, it, expect } from 'vitest'
import { enqueueResearchForOrganisation } from '../enqueue/research'
import { TIER_NOT_REJECTED_FILTER } from '@/lib/sourcing/tier-verdict'

/**
 * A rejection reason, deliberately NOT one of the real ones.
 *
 * The gate is on the PRESENCE of a reason, never on what it says, and a fixture carrying a
 * real reason string would read as though the value mattered. It also would not catch the
 * legacy value already in the live data that REMOVAL_REASONS no longer lists.
 */
const A_REJECTION = 'a-rejection-reason-the-gate-never-reads'


const ORG = 'org-a'

/**
 * The job type that holds a prospect during a batch wait.
 *
 * research_collect, NOT research, because that is the case the guard exists for: the
 * per-type index job_queue_one_live_per_target already stops two 'research' jobs, and it
 * is precisely the type MISMATCH that slipped through before.
 */
const HELD_BY_JOB_TYPE = 'research_collect'

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
  /**
   * The tier verdict. Defaults to a QUALIFIED prospect, for the same reason the
   * verification fields do: the tier gate added 2026-09-01 refuses rejected rows, so a
   * fixture without these would be filtered out and the assertions would pass vacuously.
   */
  sourced_tier?: string | null
  tiering_reason?: string | null
}

/**
 * The tier gate, as the database applies it:
 *   sourced_tier IS NOT NULL OR tiering_reason IS NULL
 *
 * The defaults key off `undefined` rather than `??`, because a fixture that explicitly sets
 * sourced_tier to null is the rejected row under test and `??` would quietly qualify it.
 */
function notRejected(p: FakeProspect): boolean {
  const tier = p.sourced_tier === undefined ? 'tier_1' : p.sourced_tier
  const reason = p.tiering_reason === undefined ? null : p.tiering_reason
  return tier !== null || reason === null
}

/** A client whose organisations, prospects and job_queue tables answer the enqueue query. */
function fake(
  prospects: FakeProspect[],
  opts: {
    archived?: boolean
    orgMissing?: boolean
    /**
     * Prospect ids that already hold a live job somewhere in the research family, which
     * during a batch rollout means they are waiting on an Anthropic batch. Their sources
     * are already bought, so enqueuing an ordinary research job for them would buy the
     * same Apify, Apollo and Brave data a second time.
     */
    liveResearchJobs?: string[]
    /** Make the live-job lookup fail, to prove the guard does not fail open. */
    liveResearchJobsError?: string
  } = {},
) {
  const enqueued: Array<Record<string, unknown>> = []
  const filters: Record<string, unknown> = {}

  const client = {
    from(table: string) {
      if (table === 'job_queue') {
        const jqFilters: Record<string, unknown> = {}
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: unknown) => { jqFilters[c] = v; return chain },
          in: (c: string, v: unknown[]) => { jqFilters[c] = v; return chain },
          then: (resolve: (v: unknown) => void) => {
            if (opts.liveResearchJobsError) {
              resolve({ data: null, error: { message: opts.liveResearchJobsError } })
              return
            }
            // HONOURS THE job_type FILTER, deliberately. It did not, and a mutation test
            // caught it: narrowing the real query to ['research'] alone failed only the
            // one test that inspects the filter directly, while every behavioural test
            // stayed green. A fake that ignores a filter cannot test the filter, and the
            // filter is the whole point here, since the prospect is held by a job of a
            // DIFFERENT type.
            const askedTypes = (jqFilters.job_type as string[] | undefined) ?? []
            if (!askedTypes.includes(HELD_BY_JOB_TYPE)) {
              resolve({ data: [], error: null })
              return
            }
            const askedStates = (jqFilters.state as string[] | undefined) ?? []
            if (!askedStates.includes('queued') || !askedStates.includes('claimed')) {
              resolve({ data: [], error: null })
              return
            }
            const asked = (jqFilters.prospect_id as string[] | undefined) ?? []
            const live = (opts.liveResearchJobs ?? []).filter(id => asked.includes(id))
            resolve({ data: live.map(id => ({ prospect_id: id, job_type: HELD_BY_JOB_TYPE })), error: null })
          },
        }
        return chain
      }
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
      const orFilters: string[] = []
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { filters[c] = v; return chain },
        limit: () => chain,
        is: (c: string) => { filters[`${c}_isNull`] = true; return chain },
        not: (c: string) => { filters[`${c}_notNull`] = true; return chain },
        // HONOURED, not swallowed. This method did not exist, so the tier gate would have
        // thrown rather than being ignored; it is implemented here so the gate is actually
        // APPLIED, which is what makes deleting it from the real query fail a test.
        or: (expr: string) => { orFilters.push(expr); return chain },
        then: (resolve: (v: unknown) => void) => {
          const wantResearched = filters.current_research_result_id_notNull === true
          const tierGated = orFilters.includes(TIER_NOT_REJECTED_FILTER)
          const rows = prospects
            .filter(p => !tierGated || notRejected(p))
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

// ═════════════════════════════════════════════════════════════════════════════
// THE BATCH-WAIT GATE
//
// Added 2026-08-26 with the research batch split. The batch path runs research as two
// jobs with up to 24 hours between them, and the prospect_research_results row is
// deliberately not written until the second one finishes. So during the wait the
// prospect still reads as current_research_result_id IS NULL and the 'unresearched'
// scope selects it again.
//
// Enqueuing an ordinary research job for it re-fetches Apify, Apollo, the website and
// Brave for sources that are already bought and already stored on the
// synthesis_batch_entries row. That is the 10 August 2026 shape: 141 credits for 29
// prospects against a ceiling of one per contact.

describe('enqueueResearchForOrganisation — prospects mid-way through a batch run', () => {
  it('SKIPS a prospect that is waiting on a batch, and enqueues the rest', async () => {
    const f = fake(
      [
        { id: 'p1', personalisation_trigger: null },
        { id: 'p2', personalisation_trigger: null },
        { id: 'p3', personalisation_trigger: null },
      ],
      { liveResearchJobs: ['p2'] },
    )

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    // p2's sources are paid for and sitting on its synthesis_batch_entries row.
    expect(f.enqueued.map(a => a.p_prospect_id)).toEqual(['p1', 'p3'])
  })

  it('skips rather than refusing the whole batch, unlike the trigger guard', async () => {
    // Different in kind. The trigger guard refuses because overwriting shipped copy is
    // destructive and has to be asked for. This is a spend filter: the other prospects
    // should still be researched.
    const f = fake(
      [
        { id: 'p1', personalisation_trigger: null },
        { id: 'p2', personalisation_trigger: null },
      ],
      { liveResearchJobs: ['p1'] },
    )

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    expect(f.enqueued).toHaveLength(1)
  })

  it('returns a named error, not a bare nothing-to-do, when EVERY prospect is mid-batch', async () => {
    const f = fake(
      [
        { id: 'p1', personalisation_trigger: null },
        { id: 'p2', personalisation_trigger: null },
      ],
      { liveResearchJobs: ['p1', 'p2'] },
    )

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // The operator has to be able to tell "already in progress" from "broken".
    expect(result.error).toMatch(/already have a research job in progress/)
    expect(result.error).toMatch(/already paid for/)
    expect(f.enqueued).toHaveLength(0)
  })

  it('FAILS LOUD when the live-job lookup errors, rather than enqueuing anyway', async () => {
    // Failing open here would silently disable the guard and walk straight into the
    // duplicate paid work it exists to prevent. A thrown error is recoverable; a silent
    // re-spend on Apify, Apollo and Brave is not.
    const f = fake(
      [{ id: 'p1', personalisation_trigger: null }],
      { liveResearchJobsError: 'connection reset' },
    )

    await expect(enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test'))
      .rejects.toThrow(/Could not check for live research jobs/)
    expect(f.enqueued).toHaveLength(0)
  })

  it('asks about all three research job types, not just its own', async () => {
    // The whole point is that the job types DIFFER. A check that only asked about
    // 'research' would see nothing while a research_collect job held the prospect.
    let askedJobTypes: unknown = null
    const base = fake([{ id: 'p1', personalisation_trigger: null }])
    const spy = {
      ...base.client as object,
      from(table: string) {
        if (table !== 'job_queue') return (base.client as never as { from: (t: string) => unknown }).from(table)
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: (c: string, v: unknown[]) => {
            if (c === 'job_type') askedJobTypes = v
            return chain
          },
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        }
        return chain
      },
    } as never

    await enqueueResearchForOrganisation(spy, ORG, 'unresearched', 'test')

    expect(askedJobTypes).toEqual(['research', 'research_sources', 'research_collect'])
  })
})

describe('enqueueResearchForOrganisation — the tier gate', () => {
  // Research is the most expensive step in the pipeline, roughly 60 times what composition
  // costs per prospect. Measured on the live organisation 2026-09-01: 10 prospects tiering
  // had rejected had been researched anyway, and 9 of them carry finished personalisation
  // copy that can never be used.
  it('never enqueues a prospect tiering rejected', async () => {
    const f = fake([
      { id: 'qualified', personalisation_trigger: null },
      { id: 'rejected', personalisation_trigger: null, sourced_tier: null, tiering_reason: A_REJECTION },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    expect(f.enqueued.map(j => j.p_prospect_id ?? j.prospect_id)).toEqual(['qualified'])
  })

  // THE GATE RUNS BEFORE THE TRIGGER GUARD, and this is the case that proves it.
  //
  // 9 of the live rejected rows hold personalisation copy. If the tier gate ran after the
  // trigger guard, those rows would refuse an entire legitimate batch on behalf of
  // prospects that should never have been researched in the first place.
  it('a rejected prospect holding shipped copy does not refuse the batch', async () => {
    const f = fake([
      { id: 'qualified', personalisation_trigger: null },
      {
        id: 'rejected', personalisation_trigger: 'An opening that already shipped.',
        sourced_tier: null, tiering_reason: A_REJECTION,
      },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.created).toBe(1)
  })

  it('still enqueues a prospect tiering has not reached yet', async () => {
    // excludeTierRejected, not requireTierPresent: a pending prospect is a normal prospect.
    const f = fake([
      { id: 'pending', personalisation_trigger: null, sourced_tier: null, tiering_reason: null },
    ])

    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.created).toBe(1)
  })
})
