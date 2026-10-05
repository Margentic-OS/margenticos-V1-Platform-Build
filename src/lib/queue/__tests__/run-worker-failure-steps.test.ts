// F2a: every failure a run records says WHERE it happened, and one list is the source of the
// others.
//
// Before this, a run's failures were strings. Sentry grouped them all under one line, so an
// unreadable switch, a job type whose pass threw and a reclaim failure were one issue. Now each
// failure carries its step and job type, the route captures each under that fingerprint, and
// `errors` and each job type's `errors` are views of the same list.
//
// Each step below is planted with a real fault and must come out under its own step. The
// control in each block is a fault of a DIFFERENT step, so a step that is always reported the
// same way cannot pass.

import { describe, it, expect } from 'vitest'
import { runWorker } from '../run-worker'
import { createFakeQueue, makeJob } from './fake-queue'
import { perJobExecutor, type JobBatchExecutor } from '../handlers'
import type { JobType } from '../types'

const doneHandler = (): JobBatchExecutor | null => perJobExecutor(() => async () => 'done')

describe('each failure names its step and job type', () => {
  it('an unreadable switch is flag_unreadable, under the job type whose switch it was', async () => {
    const fake = createFakeQueue(
      [makeJob({ job_type: 'research', organisation_id: 'org-a' })],
      { failRpc: { 'select:system_flags': 'Gateway Timeout' } },
    )
    fake.flags.set('queue_research', true)

    const run = await runWorker({
      supabase: fake.client as never,
      workerId: 'w1',
      resolveExecutor: () => doneHandler(),
    })

    // Every job type reads its own switch, so each one that cannot be read is named separately,
    // and research, whose switch this test is about, is among them.
    expect(run.failures.length).toBeGreaterThan(0)
    expect(run.failures.every(failure => failure.step === 'flag_unreadable')).toBe(true)
    expect(run.failures.map(failure => failure.jobType)).toContain('research')
    expect(run.failures.every(failure => /could not be read/.test(failure.message))).toBe(true)
  })

  it('CONTROL: a job type whose pass throws for any other reason is job_type_pass, not flag_unreadable', async () => {
    const fake = createFakeQueue([], {})
    fake.flags.set('queue_compose', true)

    const run = await runWorker({
      supabase: fake.client as never,
      workerId: 'w1',
      resolveExecutor: (jobType: JobType) => {
        if (jobType === 'compose') throw new Error('executor could not be built')
        return doneHandler()
      },
    })

    expect(run.failures).toEqual([
      expect.objectContaining({ step: 'job_type_pass', jobType: 'compose', message: 'executor could not be built' }),
    ])
  })

  it('a failed reclaim is reclaim, with no job type, and does not stop the pass', async () => {
    const fake = createFakeQueue([], { failRpc: { reclaim_expired_jobs: 'lock timeout' } })

    const run = await runWorker({
      supabase: fake.client as never,
      workerId: 'w1',
      resolveExecutor: () => doneHandler(),
    })

    expect(run.failures).toEqual([
      expect.objectContaining({ step: 'reclaim', jobType: null, message: expect.stringMatching(/lock timeout/) }),
    ])
    // CONTROL: the same pass with nothing failing records no failure at all.
    const clean = await runWorker({
      supabase: createFakeQueue([], {}).client as never,
      workerId: 'w2',
      resolveExecutor: () => doneHandler(),
    })
    expect(clean.failures).toEqual([])
  })
})

describe('the errors lists are views of one failures list', () => {
  it('the top-level errors are the failures\' own text, and a job type lists only its own messages', async () => {
    const fake = createFakeQueue([], { failRpc: { reclaim_expired_jobs: 'lock timeout' } })
    fake.flags.set('queue_compose', true)

    const run = await runWorker({
      supabase: fake.client as never,
      workerId: 'w1',
      resolveExecutor: (jobType: JobType) => {
        if (jobType === 'compose') throw new Error('executor could not be built')
        return doneHandler()
      },
    })

    expect(run.errors).toEqual(run.failures.map(failure => failure.text))
    expect(run.errors).toEqual([
      'reclaim failed: reclaim_expired_jobs failed: lock timeout',
      'compose: executor could not be built',
    ])
    // The job type carries its own message, without the job-type prefix it has always had.
    expect(run.byJobType.compose.errors).toEqual(['executor could not be built'])
    // CONTROL: a job type with no failure has no errors, and the reclaim is on no job type.
    expect(run.byJobType.research.errors).toEqual([])
    expect(run.ok).toBe(false)
  })
})
