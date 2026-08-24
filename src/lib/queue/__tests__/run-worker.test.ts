// The worker pass.
//
// The properties asserted here are the ones a worker can get wrong in ways nothing else
// would notice: claiming work it cannot finish before the platform kills it, letting one
// job type's failure stop the others, hammering a dry provider account, and reporting a
// green run when something inside it failed.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { runWorker, EXHAUSTION_TRIP_THRESHOLD } from '../run-worker'
import { QUEUE_CONFIG, WORKER_BUDGET_SECONDS, MIN_CLAIM_MARGIN_SECONDS } from '../config'
import { createFakeQueue, makeJob } from './fake-queue'
import { perJobExecutor, type JobBatchExecutor } from '../handlers'
import type { JobRow, JobType } from '../types'

/** A fake whose flags and rotation cursor behave like the real tables. */
function workerFake(rows: JobRow[] = [], enabled: Record<string, boolean> = {}) {
  const fake = createFakeQueue(rows)
  for (const [k, v] of Object.entries(enabled)) fake.flags.set(k, v)

  const cursors = new Map<string, string | null>()
  const innerFrom = fake.client.from.bind(fake.client)
  fake.client.from = (table: string) => {
    if (table !== 'queue_rotation') return innerFrom(table)
    return {
      select: () => ({
        eq(_c: string, jobType: string) {
          return {
            maybeSingle: async () => ({
              data: { last_organisation_id: cursors.get(jobType) ?? null },
              error: null,
            }),
          }
        },
      }),
      update: (patch: Record<string, unknown>) => ({
        async eq(_c: string, jobType: string) {
          cursors.set(jobType, patch.last_organisation_id as string)
          return { error: null }
        },
      }),
    }
  }
  return { ...fake, cursors }
}

/**
 * Build a resolveExecutor that returns the same per-job handler for every job type.
 *
 * perJobExecutor is the real production helper, so these tests exercise the same path
 * research and compose will use rather than a test-only shim. It is INJECTED rather than
 * spied: spying on the ESM export produced a test that passed alone and failed in the
 * full suite, because the binding inside run-worker.ts is resolved at import time.
 */
const withHandler = (handler: () => Promise<string>): (jobType: JobType) => JobBatchExecutor | null =>
  () => perJobExecutor(() => handler)

const noHandler = () => null

// One place, so no test can forget. The circuit-breaker suite spies on isQueueEnabled;
// without this it leaked into the next test and made enrich look disabled.
afterEach(() => vi.restoreAllMocks())

describe('runWorker — the flag and the handler are two separate gates', () => {
  it('does nothing when every flag is false, which is the C3 state', async () => {
    const fake = workerFake([makeJob({ job_type: 'research', organisation_id: 'org-a' })])
    const resolveExecutor = withHandler(async () => 'done')
    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.ok).toBe(true)
    expect(run.byJobType.research.enabled).toBe(false)
    expect(run.byJobType.research.claimed).toBe(0)
    // The row is untouched: a disabled job type must not be claimed and then dropped.
    expect(fake.rows[0].state).toBe('queued')
  })

  it('reports a RUN FAILURE when a job type is enabled with no handler deployed', async () => {
    // Work would pile up in the queue with nothing able to execute it and no other
    // symptom, so this is an error rather than a quiet skip.
    const resolveExecutor = noHandler
    const fake = workerFake([makeJob({ job_type: 'research', organisation_id: 'org-a' })],
                            { queue_research: true })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.ok).toBe(false)
    expect(run.errors.join(' ')).toMatch(/enabled in system_flags but no handler is registered/)
    expect(fake.rows[0].state).toBe('queued')
      })

  it('runs a job type that is both enabled and handled', async () => {
    const resolveExecutor = withHandler(async () => 'researched')
    const fake = workerFake([makeJob({ job_type: 'research', organisation_id: 'org-a' })],
                            { queue_research: true })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.ok).toBe(true)
    expect(run.byJobType.research.done).toBe(1)
    expect(fake.rows[0].state).toBe('done')
      })
})

describe('runWorker — the deadline budget', () => {
  it('does not claim a job it cannot finish inside the budget', async () => {
    // Claiming a job this invocation cannot finish would mark it claimed, hold its lease
    // for the full window, and strand it until reclaim, for work never started.
    const resolveExecutor = withHandler(async () => 'done')
    const fake = workerFake([makeJob({ job_type: 'research', organisation_id: 'org-a' })],
                            { queue_research: true })

    // Budget smaller than research's worst case, so nothing may be started.
    const run = await runWorker({
      supabase: fake.client, workerId: 'w1', resolveExecutor,
      budgetSeconds: QUEUE_CONFIG.research.worstCaseSeconds - 1,
    })

    expect(run.byJobType.research.claimed).toBe(0)
    expect(run.byJobType.research.budgetExhausted).toBe(true)
    expect(fake.rows[0].state).toBe('queued')
      })

  it('stops claiming mid-pass once the remaining budget runs out', async () => {
    const resolveExecutor = withHandler(async () => 'done')
    const rows = ['org-a', 'org-b', 'org-c'].map(o =>
      makeJob({ job_type: 'research', organisation_id: o }))
    const fake = workerFake(rows, { queue_research: true })

    // Clock advances 100s per read, so the budget is consumed as the pass proceeds.
    let t = 0
    const run = await runWorker({
      supabase: fake.client, workerId: 'w1', resolveExecutor,
      now: () => { t += 100_000; return t },
      budgetSeconds: 300,
    })

    expect(run.byJobType.research.budgetExhausted).toBe(true)
    expect(run.byJobType.research.claimed).toBeLessThan(3)
      })

  it('a budget check happens BEFORE the claim, not after', async () => {
    const resolveExecutor = withHandler(async () => 'done')
    const fake = workerFake([makeJob({ job_type: 'compose', organisation_id: 'org-a' })],
                            { queue_compose: true })

    await runWorker({
      supabase: fake.client, workerId: 'w1', resolveExecutor,
      budgetSeconds: QUEUE_CONFIG.compose.worstCaseSeconds - 1,
    })

    // No claim_jobs call was ever issued.
    expect(fake.rpcCalls.filter(c => c.fn === 'claim_jobs')).toHaveLength(0)
      })
})

describe('runWorker — EVERY job type must be claimable at the DEFAULT budget', () => {
  // The gap that let research sit unrunnable. The other budget tests all pass a
  // deliberately SMALL budget to prove the refusal works, and none of them checked that
  // the REAL budget permits anything. research.worstCaseSeconds was 240 against a 240s
  // budget, so `elapsed + worstCase > budget` was true the moment any time had elapsed,
  // and the worker reported ok:true while claiming nothing, for ever.
  it.each(Object.keys(QUEUE_CONFIG) as JobType[])(
    '%s: one job is claimed with realistic elapsed time and no budget override', async jobType => {
      const fake = workerFake(
        [makeJob({ job_type: jobType, organisation_id: 'org-a' })],
        { [`queue_${jobType}`]: true },
      )
      const resolveExecutor = withHandler(async () => 'done')

      // 300ms passes on each clock read, as it does on the reclaim and the flag reads.
      let t = 0
      const run = await runWorker({
        supabase: fake.client, workerId: 'w1', resolveExecutor,
        now: () => { t += 300; return t },
      })

      expect(run.byJobType[jobType].budgetExhausted).toBe(false)
      expect(run.byJobType[jobType].claimed).toBe(1)
    })

  it.each(Object.keys(QUEUE_CONFIG) as JobType[])(
    '%s: worst case leaves real margin inside the budget', jobType => {
      // Asserted here as well as at module load, so the number is visible in a test
      // failure rather than only in a startup crash.
      expect(QUEUE_CONFIG[jobType].worstCaseSeconds + MIN_CLAIM_MARGIN_SECONDS)
        .toBeLessThanOrEqual(WORKER_BUDGET_SECONDS)
    })

  it('the budget still fits inside the platform timeout with room to report', () => {
    // maxDuration is 300. The remainder covers the heartbeat insert, the Sentry check-in
    // and its flush(2000), all of which run after the last job finishes.
    const MAX_DURATION = 300
    expect(WORKER_BUDGET_SECONDS).toBeLessThan(MAX_DURATION)
    expect(MAX_DURATION - WORKER_BUDGET_SECONDS).toBeGreaterThanOrEqual(15)
  })
})

describe('runWorker — the circuit breaker', () => {
  it('disables a job type after repeated account-exhaustion failures', async () => {
    // Retrying every queued job against a dry account is "never loop on a paid API"
    // happening at fleet scale. The attempt cap bounds one job; only this bounds them all.
    const resolveExecutor = withHandler(async () => {
      throw new Error('Your credit balance is too low to access the API')
    })
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeJob({ job_type: 'compose', organisation_id: 'org-a', prospect_id: `p${i}` }))
    const fake = workerFake(rows, { queue_compose: true })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.byJobType.compose.circuitBreakerTripped).toBe(true)
    expect(fake.flags.get('queue_compose')).toBe(false)
    expect(run.ok).toBe(false)
      })

  it('does NOT trip on a single exhaustion signal', async () => {
    // One 402 could be a billing blip or a misread message. Turning a client's whole
    // pipeline off on one reading is too eager.
    expect(EXHAUSTION_TRIP_THRESHOLD).toBeGreaterThan(1)

    const resolveExecutor = withHandler(async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    })
    const fake = workerFake([makeJob({ job_type: 'compose', organisation_id: 'org-a' })],
                            { queue_compose: true })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.byJobType.compose.circuitBreakerTripped).toBe(false)
    expect(fake.flags.get('queue_compose')).toBe(true)
      })

  it('reports LOUDLY when the breaker itself fails to turn the flag off', async () => {
    // setQueueFlag throws when it matched zero rows. A breaker that cannot fire is worse
    // than the exhaustion, because the worker believes it stopped and has not.
    const resolveExecutor = withHandler(async () => { throw new Error('quota exceeded') })
    const rows = Array.from({ length: 2 }, (_, i) =>
      makeJob({ job_type: 'compose', organisation_id: 'org-a', prospect_id: `p${i}` }))
    const fake = workerFake(rows)   // flag row deliberately absent

    // Enabled via a stubbed read so the pass runs, but the WRITE will match nothing.
    const flags = await import('../flags')
    vi.spyOn(flags, 'isQueueEnabled').mockImplementation(async (_c, t) => t === 'compose')

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.ok).toBe(false)
    expect(run.errors.join(' ')).toMatch(/FAILED to disable/)
      })
})

describe('runWorker — isolation between job types', () => {
  it('one job type throwing does not stop the others', async () => {
    let call = 0
    const resolveExecutor = (jobType: JobType) =>
      jobType === 'enrich'
        ? perJobExecutor(() => async () => { throw new Error('enrich is broken') })
        : perJobExecutor(() => async () => { call += 1; return 'ok' })
    const fake = workerFake([
      makeJob({ job_type: 'enrich',  organisation_id: 'org-a', prospect_id: 'p1' }),
      makeJob({ job_type: 'compose', organisation_id: 'org-a', prospect_id: 'p2' }),
    ], { queue_enrich: true, queue_compose: true })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.byJobType.enrich.failed).toBe(1)
    expect(run.byJobType.compose.done).toBe(1)
    expect(call).toBe(1)
      })

  it('a reclaim failure does not stop the pass', async () => {
    const resolveExecutor = withHandler(async () => 'done')
    const fake = createFakeQueue([], { failRpc: { reclaim_expired_jobs: 'lock timeout' } })
    fake.flags.set('queue_compose', true)

    const run = await runWorker({ supabase: fake.client as never, workerId: 'w1', resolveExecutor })

    // Recorded as an error so the heartbeat goes red, but the pass still ran.
    expect(run.ok).toBe(false)
    expect(run.errors.join(' ')).toMatch(/reclaim failed/)
      })
})

describe('runWorker — reclaim runs before claiming', () => {
  it('reclaims an expired lease and reports how many were terminated', async () => {
    const resolveExecutor = withHandler(async () => 'done')
    const fake = workerFake([
      makeJob({ job_type: 'compose', state: 'claimed', claimed_by: 'dead',
                lease_expires_at: new Date(Date.now() - 1000).toISOString(),
                attempts: 1, max_attempts: 3 }),
      makeJob({ job_type: 'compose', state: 'claimed', claimed_by: 'dead',
                lease_expires_at: new Date(Date.now() - 1000).toISOString(),
                attempts: 3, max_attempts: 3 }),
    ])

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.reclaimed).toBe(2)
    expect(run.reclaimTerminated).toBe(1)
      })
})

describe('runWorker — the ok rule', () => {
  it('a job that simply FAILS does not make the run not-ok', async () => {
    // A job failing for its own reasons, retrying and eventually terminating is the queue
    // working. A heartbeat that went red on every terminal job would be red permanently
    // and therefore useless. MON-018 watches the RATE instead.
    const resolveExecutor = withHandler(async () => {
      throw Object.assign(new Error('Bad Request'), { status: 400 })
    })
    const fake = workerFake([makeJob({ job_type: 'compose', organisation_id: 'org-a' })],
                            { queue_compose: true })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    expect(run.byJobType.compose.failed).toBe(1)
    expect(run.ok).toBe(true)
      })

  it('counts finished-but-unrecorded work apart from failures', async () => {
    const resolveExecutor = withHandler(async () => 'work done')
    const fake = workerFake([makeJob({ job_type: 'compose', organisation_id: 'org-a' })],
                            { queue_compose: true })
    ;(fake.client as never as { rpc: unknown }).rpc = new Proxy(fake.client.rpc, {
      apply(target, thisArg, args: [string, Record<string, unknown>]) {
        if (args[0] === 'complete_job') throw new Error('connection lost')
        return Reflect.apply(target as never, thisArg, args)
      },
    })

    const run = await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    // A bookkeeping failure must not read as a work failure in the heartbeat.
    expect(run.byJobType.compose.unrecorded).toBe(1)
    expect(run.byJobType.compose.failed).toBe(0)
      })
})

describe('runWorker — the worker identity is what the fence needs', () => {
  it('claims under its own worker id and completes under the same one', async () => {
    const resolveExecutor = withHandler(async () => 'done')
    const fake = workerFake([makeJob({ job_type: 'compose', organisation_id: 'org-a' })],
                            { queue_compose: true })

    await runWorker({ supabase: fake.client, workerId: 'worker-xyz', resolveExecutor })

    const claim = fake.rpcCalls.find(c => c.fn === 'claim_jobs')
    const complete = fake.rpcCalls.find(c => c.fn === 'complete_job')
    expect(claim?.args.p_worker).toBe('worker-xyz')
    // Same identity, or the fence rejects the completion of work it just did.
    expect(complete?.args.p_worker).toBe('worker-xyz')
      })
})

describe('runWorker — rotation is persisted across passes', () => {
  it('writes the cursor after serving an organisation', async () => {
    const resolveExecutor = withHandler(async () => 'done')
    const fake = workerFake([makeJob({ job_type: 'compose', organisation_id: 'org-a' })],
                            { queue_compose: true })

    await runWorker({ supabase: fake.client, workerId: 'w1', resolveExecutor })

    // Without persistence the rotation resets every tick, because each Vercel invocation
    // is a fresh process.
    expect(fake.cursors.get('compose')).toBe('org-a')
      })
})
