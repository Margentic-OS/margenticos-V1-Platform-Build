// The money tests.
//
// Every assertion here maps to a way the queue could spend money it should not, or lose
// work it should have kept. The one that matters most is "a reclaimed job with spend
// recorded does NOT re-call the paid API": that is the 3de0589 bug expressed as a test,
// and it is asserted with a spy on the paid call rather than by inspecting state, because
// the thing that must not happen is the CALL, not the resulting row.

import { describe, it, expect, vi } from 'vitest'
import { executeJob, decideExecution, type JobContext } from '../execute-job'
import { createFakeQueue, makeJob } from './fake-queue'

describe('decideExecution — the spend gate', () => {
  it('allows a job that has never been paid for', () => {
    const job = makeJob({ state: 'claimed', spend_recorded_at: null })
    expect(decideExecution(job)).toEqual({ action: 'run' })
  })

  it('refuses a job that already carries a spend stamp', () => {
    const job = makeJob({ state: 'claimed', spend_recorded_at: '2026-08-24T10:00:00Z' })
    const decision = decideExecution(job)
    expect(decision.action).toBe('terminate')
  })

  it('says WHY it refused, naming the time money was already spent', () => {
    const job = makeJob({
      state: 'claimed',
      attempts: 2,
      max_attempts: 3,
      spend_recorded_at: '2026-08-24T10:00:00Z',
    })
    const decision = decideExecution(job)
    if (decision.action !== 'terminate') throw new Error('expected terminate')

    // A terminal failure whose reason does not explain itself is the silent-failure
    // class this whole build exists to remove.
    expect(decision.reason).toContain('2026-08-24T10:00:00Z')
    expect(decision.reason).toContain('attempt 2 of 3')
    expect(decision.reason).toMatch(/pay for the same work twice/i)
  })
})

describe('executeJob — a reclaimed job that was already paid for', () => {
  it('does NOT call the paid API again', async () => {
    const job = makeJob({
      state: 'claimed',
      attempts: 2,
      spend_recorded_at: '2026-08-24T10:00:00Z',
      spend_detail: { credits: 1 },
    })
    const fake = createFakeQueue([job])

    // The spy stands in for Apollo, Apify or Anthropic. If it is called, we paid twice.
    const paidApiCall = vi.fn(async () => ({ credits_consumed: 1 }))

    const outcome = await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid('apollo.bulk_match', paidApiCall)
      return 'should never get here'
    })

    expect(paidApiCall).not.toHaveBeenCalled()
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('expected failure')
    expect(outcome.terminatedForSpend).toBe(true)
  })

  it('terminates the job rather than leaving it to be retried', async () => {
    const job = makeJob({
      state: 'claimed',
      attempts: 1,
      max_attempts: 3, // deliberately UNDER the cap: the stamp must win regardless
      spend_recorded_at: '2026-08-24T10:00:00Z',
    })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-one', async () => 'unreachable')

    // Under the attempt cap, a transient failure would normally go back to 'queued'.
    // force_terminal is what stops that here.
    expect(fake.get(job.id)!.state).toBe('failed')
    const failCall = fake.rpcCalls.find(c => c.fn === 'fail_job')
    expect(failCall?.args.p_force_terminal).toBe(true)
  })

  it('never invokes the handler at all', async () => {
    const job = makeJob({ state: 'claimed', spend_recorded_at: '2026-08-24T10:00:00Z' })
    const fake = createFakeQueue([job])
    const handler = vi.fn(async () => 'summary')

    await executeJob(fake.client, job, 'worker-one', handler)

    // The gate runs before the handler, so a handler that does anything expensive
    // before its first paid() call is also protected.
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('executeJob — pay-before-work recording', () => {
  it('records spend BEFORE the handler can throw', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid('apollo.bulk_match', async () => ({ credits_consumed: 4 }))
      // Everything after a paid call is a failure path that used to lose the receipt.
      throw new Error('parsing the response blew up')
    })

    expect(fake.get(job.id)!.spend_recorded_at).not.toBeNull()
  })

  it('records spend before returning the result to the handler', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])
    let stampSeenByHandler: string | null = null

    await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid('apify.linkedin', async () => ({ ok: true }))
      stampSeenByHandler = fake.get(job.id)!.spend_recorded_at
      return 'done'
    })

    // The ordering guarantee: by the time paid() resolves, the stamp exists.
    expect(stampSeenByHandler).not.toBeNull()
  })

  it('still records spend when the spend description throws', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid(
        'apollo.bulk_match',
        async () => ({ credits_consumed: 2 }),
        () => {
          throw new Error('describeSpend is buggy')
        },
      )
      return 'done'
    })

    // Losing the description is survivable. Losing the stamp is not.
    const row = fake.get(job.id)!
    expect(row.spend_recorded_at).not.toBeNull()
    expect(row.spend_detail).toMatchObject({ describe_spend_failed: 'describeSpend is buggy' })
  })

  it('does not overwrite a stamp that already exists', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid('first', async () => 1, () => ({ credits: 1 }))
      await ctx.paid('second', async () => 2, () => ({ credits: 99 }))
      return 'done'
    })

    // Mirrors  WHERE spend_recorded_at IS NULL  in the SQL: the first stamp is the true
    // one, so a later call in the same job cannot move the timestamp forward and make a
    // reclaim think the spend is more recent than it is.
    expect(fake.get(job.id)!.spend_detail).toMatchObject({ credits: 1 })
  })

  it('a failure with spend recorded is refused on its NEXT attempt', async () => {
    const job = makeJob({ state: 'claimed', attempts: 1, max_attempts: 3 })
    const fake = createFakeQueue([job])

    // Attempt one: pays, then dies. Transient, under the cap, so it goes back to queued.
    await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid('apollo.bulk_match', async () => ({ credits_consumed: 1 }))
      throw Object.assign(new Error('Service Unavailable'), { status: 503 })
    })
    expect(fake.get(job.id)!.state).toBe('queued')

    // Attempt two: genuinely re-claimed through the queue, not a detached copy, so the
    // stored row really is 'claimed' when fail_job runs. The backoff is cleared first
    // because we are simulating the passage of time, not testing the backoff itself.
    fake.get(job.id)!.run_after = new Date(Date.now() - 1000).toISOString()
    const { data: reclaimedRows } = await fake.client.rpc('claim_jobs', {
      p_job_type: job.job_type,
      p_organisation_id: job.organisation_id,
      p_worker: 'worker-two',
      p_lease_seconds: 300,
      p_limit: 1,
    })
    const reclaimed = reclaimedRows[0]
    expect(reclaimed.spend_recorded_at).not.toBeNull()
    expect(reclaimed.claimed_by).toBe('worker-two')

    const secondPaidCall = vi.fn(async () => ({ credits_consumed: 1 }))
    // Executed as worker-two, the worker that actually holds the claim. Passing
    // worker-one here would be rejected by the fence, which is correct behaviour but a
    // different test from the one this is.
    await executeJob(fake.client, reclaimed, 'worker-two', async ctx => {
      await ctx.paid('apollo.bulk_match', secondPaidCall)
      return 'x'
    })

    expect(secondPaidCall).not.toHaveBeenCalled()
    expect(fake.get(job.id)!.state).toBe('failed')
  })
})

describe('executeJob — failure classification drives what happens next', () => {
  it('a 429 backs off and stays retryable', async () => {
    const job = makeJob({ state: 'claimed', attempts: 1, max_attempts: 3 })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    })

    if (outcome.status !== 'failed') throw new Error('expected failure')
    expect(outcome.errorClass).toBe('transient')
    expect(fake.get(job.id)!.state).toBe('queued')
    expect(new Date(fake.get(job.id)!.run_after).getTime()).toBeGreaterThan(Date.now())
  })

  it('a 400 fails terminally on the first attempt', async () => {
    const job = makeJob({ state: 'claimed', attempts: 1, max_attempts: 3 })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => {
      throw Object.assign(new Error('Bad Request: details[] is malformed'), { status: 400 })
    })

    if (outcome.status !== 'failed') throw new Error('expected failure')
    expect(outcome.errorClass).toBe('permanent')
    // Terminal despite attempts (1) being well under max_attempts (3). A malformed
    // request will be malformed on every retry.
    expect(fake.get(job.id)!.state).toBe('failed')
  })

  it('a 529 from Anthropic backs off rather than terminating', async () => {
    const job = makeJob({ state: 'claimed', attempts: 1, max_attempts: 3 })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-one', async () => {
      throw Object.assign(new Error('Overloaded'), { status: 529 })
    })

    expect(fake.get(job.id)!.state).toBe('queued')
  })

  it('a transient failure AT the attempt cap terminates instead of looping', async () => {
    const job = makeJob({ state: 'claimed', attempts: 3, max_attempts: 3 })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-one', async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    })

    // The cap is what stops a job looping forever on a paid API.
    expect(fake.get(job.id)!.state).toBe('failed')
    expect(fake.get(job.id)!.last_error).toContain('429')
  })

  it('flags account exhaustion so the worker can trip its circuit breaker', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => {
      throw new Error('Your credit balance is too low to access the Anthropic API')
    })

    if (outcome.status !== 'failed') throw new Error('expected failure')
    expect(outcome.accountExhausted).toBe(true)
    expect(outcome.errorClass).toBe('permanent')
  })
})

describe('executeJob — isolation and resilience', () => {
  it('never throws, so one job cannot abort its neighbours', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    await expect(
      executeJob(fake.client, job, 'worker-one', async () => {
        throw new Error('catastrophic handler failure')
      }),
    ).resolves.toMatchObject({ status: 'failed' })
  })

  it('does not throw even when writing the failure itself fails', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job], { throwRpc: { fail_job: new Error('database is down') } })

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => {
      throw new Error('handler failed')
    })

    // The job stays claimed and its lease lapses, which reclaim handles. Throwing here
    // would take the worker's other jobs down with it for a database blip.
    expect(outcome.status).toBe('failed')
    expect(fake.get(job.id)!.state).toBe('claimed')
  })

  it('running three jobs where the middle one fails leaves the other two done', async () => {
    const jobs = [
      makeJob({ state: 'claimed', prospect_id: 'p1' }),
      makeJob({ state: 'claimed', prospect_id: 'p2' }),
      makeJob({ state: 'claimed', prospect_id: 'p3' }),
    ]
    const fake = createFakeQueue(jobs)

    const outcomes = await Promise.all(
      jobs.map(job =>
        executeJob(fake.client, job, 'worker-one', async () => {
          if (job.prospect_id === 'p2') throw new Error('this prospect is broken')
          return `researched ${job.prospect_id}`
        }),
      ),
    )

    // Isolation: one row per prospect, one failure written to one row.
    expect(outcomes.map(o => o.status)).toEqual(['done', 'failed', 'done'])
    expect(fake.get(jobs[0].id)!.state).toBe('done')
    expect(fake.get(jobs[1].id)!.state).toBe('queued') // transient, retryable
    expect(fake.get(jobs[2].id)!.state).toBe('done')
    expect(fake.get(jobs[0].id)!.last_error).toBeNull()
    expect(fake.get(jobs[2].id)!.last_error).toBeNull()
  })

  it('records the summary on success', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => 'enriched 10 contacts, 10 credits')

    expect(outcome.status).toBe('done')
    expect(fake.get(job.id)!.state).toBe('done')
    expect(fake.get(job.id)!.result_summary).toBe('enriched 10 contacts, 10 credits')
  })
})

describe('executeJob — the lease fence (fix D)', () => {
  it('does not mark done a job whose lease another worker now holds', async () => {
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-b' })
    const fake = createFakeQueue([job])

    // worker-a stalled, its lease was reclaimed, and worker-b now owns the row.
    const outcome = await executeJob(fake.client, job, 'worker-a', async () => 'work done')

    expect(outcome.status).toBe('lease_lost')
    // The row still belongs to worker-b and is untouched.
    expect(fake.get(job.id)!.state).toBe('claimed')
    expect(fake.get(job.id)!.claimed_by).toBe('worker-b')
  })

  it('does not requeue a job another worker is actively running', async () => {
    // The sharper half: without the fence a stalled worker could push a live job back to
    // 'queued', where a third worker claims it and pays for the same prospect again.
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-b', attempts: 1, max_attempts: 3 })
    const fake = createFakeQueue([job])

    await executeJob(fake.client, job, 'worker-a', async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    })

    expect(fake.get(job.id)!.state).toBe('claimed')
    expect(fake.get(job.id)!.claimed_by).toBe('worker-b')
  })

  it('the rightful holder still completes normally', async () => {
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-b' })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'worker-b', async () => 'work done')

    expect(outcome.status).toBe('done')
    expect(fake.get(job.id)!.state).toBe('done')
  })
})

describe('executeJob — completion-write failure is not a work failure (fix F)', () => {
  it('does NOT mark a paid, finished job as failed when the completion write throws', async () => {
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-one' })
    const fake = createFakeQueue([job], { throwRpc: { complete_job: new Error('connection lost') } })
    const paidApiCall = vi.fn(async () => ({ credits_consumed: 1 }))

    const outcome = await executeJob(fake.client, job, 'worker-one', async ctx => {
      await ctx.paid('apollo.bulk_match', paidApiCall)
      return 'enriched 10 contacts'
    })

    expect(paidApiCall).toHaveBeenCalledTimes(1)
    expect(outcome.status).toBe('completion_write_failed')
    // Previously this was caught by the handler's catch and written through safeFail,
    // recording a successful, paid run as a failure.
    expect(fake.get(job.id)!.state).not.toBe('failed')
    expect(fake.get(job.id)!.last_error).toBeNull()
  })

  it('leaves the job claimed so the lease lapses and reclaim requeues it', async () => {
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-one' })
    const fake = createFakeQueue([job], { throwRpc: { complete_job: new Error('connection lost') } })

    await executeJob(fake.client, job, 'worker-one', async () => 'done')

    expect(fake.get(job.id)!.state).toBe('claimed')
  })

  it('still reports the summary so the caller knows the work happened', async () => {
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-one' })
    const fake = createFakeQueue([job], { throwRpc: { complete_job: new Error('boom') } })

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => 'researched p1')

    if (outcome.status !== 'completion_write_failed') throw new Error('expected completion_write_failed')
    expect(outcome.summary).toBe('researched p1')
  })

  it('a handler failure is still recorded as a failure, unchanged', async () => {
    // The separation must not have broken the ordinary path.
    const job = makeJob({ state: 'claimed', claimed_by: 'worker-one', attempts: 1, max_attempts: 3 })
    const fake = createFakeQueue([job])

    const outcome = await executeJob(fake.client, job, 'worker-one', async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    })

    expect(outcome.status).toBe('failed')
    expect(fake.get(job.id)!.state).toBe('queued')
  })
})
