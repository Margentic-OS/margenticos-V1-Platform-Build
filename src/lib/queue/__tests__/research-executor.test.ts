// The research executor and its enqueue guards.
//
// Research is the most expensive job in the system and the one whose spend stamp is
// coarsest, so these tests are about two things: that the stamp lands at all, and that
// the guards which stop finished copy being regenerated survive the move to the queue.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeQueue, makeJob } from './fake-queue'
import { executeJob } from '../execute-job'

let researchImpl: (...args: unknown[]) => unknown = () => {
  throw new Error('test did not set researchImpl')
}
const researchCalls: unknown[][] = []

vi.mock('@/lib/agents/prospect-research-agent-v2', () => ({
  runProspectResearchAgentV2: (...args: unknown[]) => {
    researchCalls.push(args)
    return researchImpl(...args)
  },
}))

const { researchHandler } = await import('../executors/research')

const ORG = 'org-a'

const okResult = (over: Record<string, unknown> = {}) => ({
  prospect_id: 'p1',
  client_id: ORG,
  research_result_id: 'rr-1',
  qualification_status: 'qualified',
  has_dateable_signal: true,
  sources_attempted: ['linkedin', 'apollo', 'website', 'web_search'],
  sources_successful: ['linkedin', 'website'],
  trigger_text: 'Something specific and dateable.',
  // Added 2026-08-25 with per-prospect token recording. Omitting them is not a harmless
  // fixture gap: describeSpend reads token_usage.input_tokens, so an absent object throws
  // inside paid()'s guard, the spend stamp is still written, and the DETAIL is replaced by
  // an error note. That is the designed failure mode, and it is exactly what these two
  // tests caught when the fields were first threaded through.
  token_usage: {
    input_tokens: 1200, output_tokens: 800,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 9000, calls: 4,
  },
  web_search_count: 2,
  ...over,
})

beforeEach(() => { researchCalls.length = 0 })

describe('researchHandler — agent isolation', () => {
  it('passes client_id from the JOB ROW, never from ambient state', async () => {
    researchImpl = async () => okResult()
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    // Researching one client's prospect under another client's positioning is the most
    // serious error this system can make.
    expect(researchCalls[0][0]).toMatchObject({ prospect_id: 'p1', client_id: ORG })
  })

  it('always uses stored findings, because a queued job carries no options', async () => {
    researchImpl = async () => okResult()
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    // Re-fetching every source is the expensive half of a run and must never be the
    // default. The route refuses use_stored_findings=false on the queued path instead.
    expect(researchCalls[0][0]).toMatchObject({ use_stored_findings: true })
  })
})

describe('researchHandler — the spend stamp', () => {
  it('stamps spend after the agent returns', async () => {
    researchImpl = async () => okResult()
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    expect(fake.get(job.id)!.spend_recorded_at).not.toBeNull()
    expect(fake.get(job.id)!.spend_detail).toMatchObject({
      label: 'research.full_run',
      research_result_id: 'rr-1',
      sources_successful: ['linkedin', 'website'],
    })
  })

  // The cost model was guesswork until these landed. A run that records a spend stamp but
  // no token counts cannot be priced afterwards, and the response carrying them is gone.
  it('records the token counts and the billable web search count', async () => {
    researchImpl = async () => okResult()
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    expect(fake.get(job.id)!.spend_detail).toMatchObject({
      input_tokens: 1200,
      output_tokens: 800,
      cache_creation_input_tokens: 0,
      // Non-zero is the only production-visible proof prompt caching still works.
      cache_read_input_tokens: 9000,
      // Calls, not prospects: writer 1-3, floor and judge 0-3 each, plus synthesis.
      anthropic_calls: 4,
      web_search_count: 2,
    })
  })

  it('records which sources ran, so a cheap stored-findings run is distinguishable', async () => {
    // An empty sources list is the marker that phase 1 was skipped and the run reused
    // findings already on file, which is the difference between $0.026 and near zero.
    researchImpl = async () => okResult({ sources_attempted: [], sources_successful: [] })
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    expect(fake.get(job.id)!.spend_detail).toMatchObject({ sources_attempted: [] })
  })

  it('does NOT stamp when the agent throws before returning', async () => {
    // The documented limitation, asserted so it cannot change silently. ctx.paid can only
    // wrap the whole agent, so a crash mid-run leaves no stamp and the retry re-pays.
    // Bounded by maxAttempts 2 at roughly $0.026 per wasted attempt.
    researchImpl = () => { throw Object.assign(new Error('Overloaded'), { status: 529 }) }
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1', attempts: 1, max_attempts: 2 })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    expect(fake.get(job.id)!.spend_recorded_at).toBeNull()
    expect(fake.get(job.id)!.state).toBe('queued')
  })

  it('refuses to re-run a job that already carries a stamp', async () => {
    researchImpl = async () => okResult()
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1',
                          spend_recorded_at: '2026-08-24T10:00:00Z' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    expect(researchCalls).toHaveLength(0)
    expect(fake.get(job.id)!.state).toBe('failed')
  })
})

describe('researchHandler — a verdict is a successful job', () => {
  it.each(['qualified', 'disqualified', 'unknown'])(
    'marks %s as done, not failed', async status => {
      researchImpl = async () => okResult({ qualification_status: status })
      const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                            organisation_id: ORG, prospect_id: 'p1' })
      const fake = createFakeQueue([job])

      const outcome = await executeJob(fake.client, job, 'w1', researchHandler())

      expect(outcome.status).toBe('done')
      expect(fake.get(job.id)!.result_summary).toContain(status)
    })

  it('records when the judge held and no trigger was written', async () => {
    researchImpl = async () => okResult({ trigger_text: null, has_dateable_signal: false })
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, prospect_id: 'p1' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())

    expect(fake.get(job.id)!.result_summary).toContain('no trigger')
    expect(fake.get(job.id)!.state).toBe('done')
  })
})

describe('researchHandler — failure classification', () => {
  it('a 529 backs off and stays retryable', async () => {
    researchImpl = () => { throw Object.assign(new Error('Overloaded'), { status: 529 }) }
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, attempts: 1, max_attempts: 2 })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())
    expect(fake.get(job.id)!.state).toBe('queued')
  })

  it('a credit-exhaustion message is permanent and flagged for the breaker', async () => {
    researchImpl = () => { throw new Error('Your credit balance is too low') }
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, attempts: 1, max_attempts: 2 })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'w1', researchHandler())

    if (outcome.status !== 'failed') throw new Error('expected failure')
    expect(outcome.accountExhausted).toBe(true)
    expect(fake.get(job.id)!.state).toBe('failed')
  })

  it('terminates at the cap of 2, tighter than the other job types', async () => {
    // Research is the most expensive job here, so a third attempt is likelier to spend
    // money than to succeed.
    researchImpl = () => { throw Object.assign(new Error('Overloaded'), { status: 529 }) }
    const job = makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                          organisation_id: ORG, attempts: 2, max_attempts: 2 })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchHandler())
    expect(fake.get(job.id)!.state).toBe('failed')
  })

  it('one prospect failing does not affect its neighbours', async () => {
    researchImpl = async (input: unknown) => {
      const { prospect_id } = input as { prospect_id: string }
      if (prospect_id === 'p2') throw new Error('this prospect is broken')
      return okResult({ prospect_id })
    }
    const jobs = ['p1', 'p2', 'p3'].map(p =>
      makeJob({ job_type: 'research', state: 'claimed', claimed_by: 'w1',
                organisation_id: ORG, prospect_id: p, attempts: 1, max_attempts: 2 }))
    const fake = createFakeQueue(jobs)

    const outcomes = await Promise.all(
      jobs.map(j => executeJob(fake.client, j, 'w1', researchHandler())),
    )

    expect(outcomes.map(o => o.status)).toEqual(['done', 'failed', 'done'])
    expect(fake.get(jobs[0].id)!.last_error).toBeNull()
    expect(fake.get(jobs[2].id)!.last_error).toBeNull()
  })
})
