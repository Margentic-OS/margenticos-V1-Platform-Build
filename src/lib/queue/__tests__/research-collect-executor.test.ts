// What the research_collect job records about what it spent.
//
// THE GAP THIS CLOSES. This executor recorded which entry it collected and nothing about
// tokens, so every prospect researched through the Batch API split — the production path at
// volume — had no per-prospect cost on record at all. The synthesis half was never missing:
// it is billed hours earlier and sits on synthesis_batch_entries.usage. The calls THIS job
// makes are the writer, the floor judge, the judge, and on the generated arm the follow-up
// call and the fact-check calls it triggers. None of them were recorded anywhere.
//
// There was no test file for this executor before 2026-09-25.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeQueue, makeJob } from './fake-queue'
import { executeJob } from '../execute-job'

let collectImpl: (...args: unknown[]) => unknown = () => {
  throw new Error('test did not set collectImpl')
}
const collectCalls: unknown[][] = []

vi.mock('@/lib/agents/prospect-research-collect-agent', () => ({
  runProspectResearchCollect: (...args: unknown[]) => {
    collectCalls.push(args)
    return collectImpl(...args)
  },
}))

const { researchCollectHandler } = await import('../executors/research-collect')

const ORG = 'org-a'

const OPENING_USAGE = {
  input_tokens: 3016, output_tokens: 6610,
  cache_creation_input_tokens: 3018, cache_read_input_tokens: 21421,
  // Writer 1-3 attempts, floor and judge 0-3 each. ONE accumulator inside
  // write-opening.ts, so this is the whole of Email 1's cost and cannot be split further.
  calls: 5,
}

const FOLLOWUP_USAGE = {
  input_tokens: 2400, output_tokens: 310,
  cache_creation_input_tokens: 1800, cache_read_input_tokens: 4300,
  // Follow-up attempts PLUS the fact-check calls they triggered. write-followups.ts adds
  // the fact-check usage into this same accumulator deliberately, so the check can never be
  // billed invisibly.
  calls: 3,
}

const stored = (over: Record<string, unknown> = {}) => ({
  outcome: 'stored' as const,
  research_result_id: 'rr-1',
  entry_id: 'e-1',
  qualification_status: 'qualified',
  trigger_written: true,
  doc_superseded: false,
  opening_usage: OPENING_USAGE,
  followup_usage: FOLLOWUP_USAGE,
  ...over,
})

const collectJob = () => makeJob({
  job_type: 'research_collect', state: 'claimed', claimed_by: 'w1',
  organisation_id: ORG, prospect_id: 'p1',
})

beforeEach(() => { collectCalls.length = 0 })

describe('researchCollectHandler — agent isolation', () => {
  it('passes client_id from the JOB ROW, never from ambient state', async () => {
    collectImpl = async () => stored()
    const job = collectJob()
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchCollectHandler())

    expect(collectCalls[0][0]).toMatchObject({ prospect_id: 'p1', client_id: ORG })
  })
})

describe('researchCollectHandler — the spend detail', () => {
  it("records Email 1's writer, floor and judge tokens", async () => {
    collectImpl = async () => stored()
    const job = collectJob()
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchCollectHandler())

    expect(fake.get(job.id)!.spend_detail).toMatchObject({
      opening_input_tokens: 3016,
      opening_output_tokens: 6610,
      opening_cache_creation_input_tokens: 3018,
      // Non-zero is the only production-visible proof prompt caching still works. If it
      // falls to zero across a batch, a per-prospect value has leaked into a system prompt.
      opening_cache_read_input_tokens: 21421,
      opening_calls: 5,
    })
  })

  it('records the follow-up and fact-check tokens as their OWN keys', async () => {
    collectImpl = async () => stored()
    const job = collectJob()
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchCollectHandler())

    const detail = fake.get(job.id)!.spend_detail as Record<string, unknown>
    expect(detail).toMatchObject({
      followup_input_tokens: 2400,
      followup_output_tokens: 310,
      followup_cache_creation_input_tokens: 1800,
      followup_cache_read_input_tokens: 4300,
      followup_calls: 3,
    })
    // NOT SUMMED INTO THE OPENING TOTALS. The generated and template arms differ by exactly
    // this line, and a blended figure cannot say which half moved.
    expect(detail.opening_input_tokens).toBe(3016)
    expect(detail.opening_calls).toBe(5)
  })

  it('writes NO follow-up keys on the template arm', async () => {
    // Absence is the signal. Zeroes would read as a call that happened and cost nothing;
    // no keys says no call was paid for, which is what the template arm means.
    collectImpl = async () => stored({ followup_usage: null })
    const job = collectJob()
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchCollectHandler())

    const detail = fake.get(job.id)!.spend_detail as Record<string, unknown>
    expect(detail).not.toHaveProperty('followup_input_tokens')
    expect(detail).not.toHaveProperty('followup_calls')
    // The control: the rest of the stamp is present, so the assertion above is about the
    // follow-up keys rather than about a detail that was never written.
    expect(detail.opening_input_tokens).toBe(3016)
  })

  it('records no token keys at all when the prospect became unmailable during the wait', async () => {
    // No writer, floor, judge or follow-up call was made. The synthesis was already paid
    // for on the batch and is recorded on the entry, not here.
    collectImpl = async () => ({
      outcome: 'stored_without_opening' as const,
      research_result_id: 'rr-2',
      entry_id: 'e-2',
      reason: 'became send-ineligible during the batch wait',
    })
    const job = collectJob()
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'w1', researchCollectHandler())

    const detail = fake.get(job.id)!.spend_detail as Record<string, unknown>
    expect(detail).toMatchObject({ outcome: 'stored_without_opening' })
    expect(detail).not.toHaveProperty('opening_input_tokens')
    expect(detail).not.toHaveProperty('followup_input_tokens')
    // And it still records WHY, because the saving is real and worth counting.
    expect(detail.skipped_reason).toBe('became send-ineligible during the batch wait')
  })
})
