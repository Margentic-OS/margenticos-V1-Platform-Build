// The enrichment batch executor.
//
// This is the first executor that spends real money, so the assertions are about exactly
// two things: how many times Apollo is called, and whether every job that could have been
// billed carries a stamp before anything else can go wrong.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeQueue, makeJob } from './fake-queue'
import type { JobRow } from '../types'

// A plain recorder rather than vi.fn(). vi.fn() stores every call's outcome in
// mock.results, including thrown errors, and clearing it between tests makes vitest
// surface those stored throws as failures of whichever test is running, even though the
// executor caught them correctly. This has no such state.
let enrichImpl: (...args: unknown[]) => unknown = () => {
  throw new Error('test did not set enrichImpl')
}
const enrichCalls: unknown[][] = []

vi.mock('@/lib/sourcing/handlers/adapter-apollo-enrichment', () => ({
  enrichProspectsForOrganisation: (...args: unknown[]) => {
    enrichCalls.push(args)
    return enrichImpl(...args)
  },
}))

const { enrichBatchExecutor } = await import('../executors/enrich')

const ORG = 'org-a'

// Only the call log needs clearing. There is no mock state to reset.
beforeEach(() => { enrichCalls.length = 0 })

/** A fake with a prospects table the executor can resolve keys and verdicts from. */
function enrichFake(
  jobs: JobRow[],
  prospects: Array<{ id: string; source_person_key: string | null; enrichment_status?: string | null }>,
) {
  const fake = createFakeQueue(jobs)
  const innerFrom = fake.client.from.bind(fake.client)
  fake.client.from = (table: string) => {
    if (table !== 'prospects') return innerFrom(table)
    let cols = ''
    const chain: Record<string, unknown> = {
      select: (c: string) => { cols = c; return chain },
      eq: () => chain,
      in: async () => ({
        data: prospects.map(p =>
          cols.includes('enrichment_status')
            ? { id: p.id, enrichment_status: p.enrichment_status ?? null }
            : { id: p.id, source_person_key: p.source_person_key },
        ),
        error: null,
      }),
    }
    return chain as never
  }
  return fake
}

const okRun = (credits = 10) => ({
  organisation_id: ORG, batch_size: 10, total_requested_enrichments: 10,
  unique_enriched_records: 10, missing_records: 0, credits_consumed: credits,
  enriched_at: new Date().toISOString(), status: 'success' as const,
})


describe('enrichBatchExecutor — one Apollo call per claimed batch', () => {
  it('issues exactly ONE call for ten claimed jobs', async () => {
    enrichImpl = async () => okRun()
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                organisation_id: ORG, prospect_id: `p${i}` }))
    const fake = enrichFake(jobs, jobs.map(j => ({
      id: j.prospect_id, source_person_key: `apollo:a${j.prospect_id}`, enrichment_status: 'enriched',
    })))

    await enrichBatchExecutor(fake.client, jobs, 'w1')

    // Ten calls instead of one would be ten times the requests against a 600/hour
    // ceiling, for identical cost in credits.
    expect(enrichCalls).toHaveLength(1)
    expect(enrichCalls[0][2]).toHaveLength(10)
  })

  it('caps the adapter to one internal batch by passing the exact id count', async () => {
    enrichImpl = async () => okRun()
    const jobs = Array.from({ length: 4 }, (_, i) =>
      makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                organisation_id: ORG, prospect_id: `p${i}` }))
    const fake = enrichFake(jobs, jobs.map(j => ({
      id: j.prospect_id, source_person_key: `apollo:a${j.prospect_id}`, enrichment_status: 'enriched',
    })))

    await enrichBatchExecutor(fake.client, jobs, 'w1')

    // maxRunBatchSize === number of ids, so the claimed batch and the billed batch are
    // the same thing. The spend stamp below depends on that.
    expect(enrichCalls[0][3]).toBe(4)
  })
})

describe('enrichBatchExecutor — spend is stamped on EVERY job in the batch', () => {
  it('stamps all ten, because Apollo cannot say which record was billed', async () => {
    enrichImpl = async () => okRun()
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                organisation_id: ORG, prospect_id: `p${i}` }))
    const fake = enrichFake(jobs, jobs.map(j => ({
      id: j.prospect_id, source_person_key: `apollo:a${j.prospect_id}`, enrichment_status: 'enriched',
    })))

    await enrichBatchExecutor(fake.client, jobs, 'w1')

    // Over-marking costs a prospect an explicit re-enrichment. Under-marking spends twice.
    for (const job of jobs) expect(fake.get(job.id)!.spend_recorded_at).not.toBeNull()
  })

  it('records the credit figure and batch size on each job', async () => {
    enrichImpl = async () => okRun(7)
    const jobs = [makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                            organisation_id: ORG, prospect_id: 'p1' })]
    const fake = enrichFake(jobs, [{ id: 'p1', source_person_key: 'apollo:a1', enrichment_status: 'enriched' }])

    await enrichBatchExecutor(fake.client, jobs, 'w1')

    expect(fake.get(jobs[0].id)!.spend_detail).toMatchObject({
      label: 'apollo.bulk_match', credits_consumed: 7, batch_size: 1,
    })
  })
})

describe('enrichBatchExecutor — the spend gate excludes already-paid jobs', () => {
  it('leaves an already-stamped job OUT of the Apollo call', async () => {
    enrichImpl = async () => okRun()
    const paid = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                           organisation_id: ORG, prospect_id: 'p-paid',
                           spend_recorded_at: '2026-08-24T10:00:00Z' })
    const fresh = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                            organisation_id: ORG, prospect_id: 'p-fresh' })
    const fake = enrichFake([paid, fresh], [
      { id: 'p-paid',  source_person_key: 'apollo:a1', enrichment_status: 'enriched' },
      { id: 'p-fresh', source_person_key: 'apollo:a2', enrichment_status: 'enriched' },
    ])

    const outcomes = await enrichBatchExecutor(fake.client, [paid, fresh], 'w1')

    // Only the fresh prospect is bought. Including the paid one would re-buy that contact.
    expect(enrichCalls[0][2]).toEqual(['a2'])
    expect(outcomes.find(o => o.jobId === paid.id)!.status).toBe('failed')
    expect(fake.get(paid.id)!.state).toBe('failed')
    expect(fake.get(fresh.id)!.state).toBe('done')
  })

  it('does not call Apollo at all when every job was already paid for', async () => {
    const paid = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                           organisation_id: ORG, spend_recorded_at: '2026-08-24T10:00:00Z' })
    const fake = enrichFake([paid], [{ id: paid.prospect_id, source_person_key: 'apollo:a1' }])

    await enrichBatchExecutor(fake.client, [paid], 'w1')

    expect(enrichCalls).toHaveLength(0)
  })
})

describe('enrichBatchExecutor — a held verdict is a SUCCESSFUL job', () => {
  it.each(['held_duplicate', 'held_unverified', 'held_no_email', 'held_missing'])(
    'marks %s as done, not failed', async status => {
      enrichImpl = async () => okRun()
      const job = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                            organisation_id: ORG, prospect_id: 'p1' })
      const fake = enrichFake([job], [{ id: 'p1', source_person_key: 'apollo:a1', enrichment_status: status }])

      const outcomes = await enrichBatchExecutor(fake.client, [job], 'w1')

      // The job's purpose is to reach a verdict, and it did. Marking it failed would
      // inflate MON-018 and invite a retry of finished work.
      expect(outcomes[0].status).toBe('done')
      expect(fake.get(job.id)!.state).toBe('done')
      expect(fake.get(job.id)!.result_summary).toContain(status)
    })
})

describe('enrichBatchExecutor — failure handling', () => {
  it('fails the whole batch when the shared Apollo call throws', async () => {
    // Honest about what the batch trade-off costs: there was one call and it did not
    // return, so all the jobs in it fail together.
    enrichImpl = () => { throw Object.assign(new Error('Too Many Requests'), { status: 429 }) }
    const jobs = Array.from({ length: 3 }, (_, i) =>
      makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                organisation_id: ORG, prospect_id: `p${i}`, attempts: 1, max_attempts: 3 }))
    const fake = enrichFake(jobs, jobs.map(j => ({ id: j.prospect_id, source_person_key: `apollo:a${j.prospect_id}` })))

    const outcomes = await enrichBatchExecutor(fake.client, jobs, 'w1')

    expect(outcomes.every(o => o.status === 'failed')).toBe(true)
    // Transient, so they go back to queued for another attempt.
    for (const job of jobs) expect(fake.get(job.id)!.state).toBe('queued')
  })

  it('classifies a 403 from Apollo as permanent, so it does not retry', async () => {
    enrichImpl = () => { throw new Error('Apollo API returned 403 (plan-gated, likely free tier)') }
    const job = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1', attempts: 1, max_attempts: 3 })
    const fake = enrichFake([job], [{ id: 'p1', source_person_key: 'apollo:a1' }])

    const outcomes = await enrichBatchExecutor(fake.client, [job], 'w1')

    if (outcomes[0].status !== 'failed') throw new Error('expected failure')
    expect(outcomes[0].errorClass).toBe('permanent')
    expect(fake.get(job.id)!.state).toBe('failed')
  })

  it('flags account exhaustion so the worker can trip the breaker', async () => {
    enrichImpl = () => { throw new Error('insufficient credits on this account') }
    const job = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = enrichFake([job], [{ id: 'p1', source_person_key: 'apollo:a1' }])

    const outcomes = await enrichBatchExecutor(fake.client, [job], 'w1')

    if (outcomes[0].status !== 'failed') throw new Error('expected failure')
    expect(outcomes[0].accountExhausted).toBe(true)
  })

  it('terminates a prospect with no Apollo key WITHOUT calling Apollo', async () => {
    enrichImpl = async () => okRun()
    const bad  = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                           organisation_id: ORG, prospect_id: 'p-bad' })
    const good = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                           organisation_id: ORG, prospect_id: 'p-good' })
    const fake = enrichFake([bad, good], [
      { id: 'p-bad',  source_person_key: 'linkedin:xyz', enrichment_status: null },
      { id: 'p-good', source_person_key: 'apollo:a2',    enrichment_status: 'enriched' },
    ])

    const outcomes = await enrichBatchExecutor(fake.client, [bad, good], 'w1')

    // A malformed row must not consume retries or money.
    expect(enrichCalls[0][2]).toEqual(['a2'])
    const badOutcome = outcomes.find(o => o.jobId === bad.id)!
    expect(badOutcome.status).toBe('failed')
    if (badOutcome.status !== 'failed') throw new Error('x')
    expect(badOutcome.errorClass).toBe('permanent')
    expect(fake.get(good.id)!.state).toBe('done')
  })

  it('returns exactly one outcome per job it was given', async () => {
    // The worker's counters depend on this.
    enrichImpl = async () => okRun()
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                organisation_id: ORG, prospect_id: `p${i}` }))
    const fake = enrichFake(jobs, jobs.map(j => ({
      id: j.prospect_id, source_person_key: `apollo:a${j.prospect_id}`, enrichment_status: 'enriched',
    })))

    const outcomes = await enrichBatchExecutor(fake.client, jobs, 'w1')
    expect(outcomes).toHaveLength(5)
    expect(new Set(outcomes.map(o => o.jobId)).size).toBe(5)
  })

  it('refuses a batch spanning organisations without calling Apollo', async () => {
    // claim_jobs is scoped to one organisation, so this should be impossible. Enriching
    // one client's prospect under another client's run is the most serious error here.
    enrichImpl = async () => okRun()
    const a = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1', organisation_id: 'org-a' })
    const b = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1', organisation_id: 'org-b' })
    const fake = enrichFake([a, b], [])

    const outcomes = await enrichBatchExecutor(fake.client, [a, b], 'w1')

    expect(enrichCalls).toHaveLength(0)
    expect(outcomes.every(o => o.status === 'failed')).toBe(true)
  })

  it('never throws, whatever the adapter does', async () => {
    enrichImpl = () => { throw new Error('synchronous explosion') }
    const job = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = enrichFake([job], [{ id: 'p1', source_person_key: 'apollo:a1' }])

    await expect(enrichBatchExecutor(fake.client, [job], 'w1')).resolves.toHaveLength(1)
  })
})

describe('enrichBatchExecutor — the lease fence', () => {
  it('reports lease_lost rather than overwriting a row another worker now holds', async () => {
    enrichImpl = async () => okRun()
    const job = makeJob({ job_type: 'enrich', state: 'claimed', claimed_by: 'worker-b',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = enrichFake([job], [{ id: 'p1', source_person_key: 'apollo:a1', enrichment_status: 'enriched' }])

    // worker-a stalled; worker-b owns the row now.
    const outcomes = await enrichBatchExecutor(fake.client, [job], 'worker-a')

    expect(outcomes[0].status).toBe('lease_lost')
    expect(fake.get(job.id)!.claimed_by).toBe('worker-b')
  })
})
