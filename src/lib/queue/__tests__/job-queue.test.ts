// The RPC wrappers.
//
// These are thin by design, so the tests here guard the two things thinness can still
// get wrong: that the claim is a SINGLE atomic statement rather than a read followed by
// a write, and that recording spend can never throw.

import { describe, it, expect } from 'vitest'
import {
  claimJobs,
  completeJob,
  countInFlight,
  enqueueJob,
  enqueueJobsForProspects,
  failJob,
  getOrganisationBacklog,
  reclaimExpiredJobs,
  recordJobSpend,
} from '../job-queue'
import { QUEUE_CONFIG } from '../config'
import { createFakeQueue, makeJob } from './fake-queue'

describe('claimJobs — atomicity is not something the wrapper may undo', () => {
  it('issues exactly ONE rpc call and no separate select', async () => {
    // This is the regression guard that matters. Two workers taking disjoint sets
    // depends on the claim being a single UPDATE ... RETURNING with FOR UPDATE SKIP
    // LOCKED. If anyone ever "optimises" this into a select-then-update, the atomicity
    // is gone and nothing else in the codebase would notice. This test would.
    const fake = createFakeQueue([makeJob({ organisation_id: 'org-a' })])

    await claimJobs(fake.client, {
      jobType: 'research',
      organisationId: 'org-a',
      worker: 'worker-one',
    })

    expect(fake.rpcCalls).toHaveLength(1)
    expect(fake.rpcCalls[0].fn).toBe('claim_jobs')
    expect(fake.selectCalls).toHaveLength(0)
  })

  it('passes the configured lease and batch size for the job type', async () => {
    const fake = createFakeQueue([])
    await claimJobs(fake.client, { jobType: 'enrich', organisationId: 'o', worker: 'w' })

    expect(fake.rpcCalls[0].args).toMatchObject({
      p_lease_seconds: QUEUE_CONFIG.enrich.leaseSeconds,
      p_limit:         QUEUE_CONFIG.enrich.claimBatchSize,
    })
  })

  it('lets the caller override the limit for a partial slice', async () => {
    const fake = createFakeQueue([])
    await claimJobs(fake.client, { jobType: 'research', organisationId: 'o', worker: 'w', limit: 2 })
    expect(fake.rpcCalls[0].args.p_limit).toBe(2)
  })

  it('returns claimed rows carrying the worker and an incremented attempt', async () => {
    const fake = createFakeQueue([makeJob({ organisation_id: 'org-a', attempts: 0 })])
    const claimed = await claimJobs(fake.client, {
      jobType: 'research', organisationId: 'org-a', worker: 'worker-one',
    })

    expect(claimed).toHaveLength(1)
    expect(claimed[0].claimed_by).toBe('worker-one')
    expect(claimed[0].attempts).toBe(1)
    expect(claimed[0].state).toBe('claimed')
  })

  it('does not return a job whose backoff has not elapsed', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const fake = createFakeQueue([makeJob({ organisation_id: 'org-a', run_after: future })])

    const claimed = await claimJobs(fake.client, {
      jobType: 'research', organisationId: 'org-a', worker: 'w',
    })
    expect(claimed).toEqual([])
  })

  it('claims only from the requested organisation', async () => {
    const fake = createFakeQueue([
      makeJob({ organisation_id: 'org-a' }),
      makeJob({ organisation_id: 'org-b' }),
    ])

    const claimed = await claimJobs(fake.client, {
      jobType: 'research', organisationId: 'org-a', worker: 'w',
    })

    expect(claimed).toHaveLength(1)
    expect(claimed[0].organisation_id).toBe('org-a')
    // Agent isolation: org B's row is untouched.
    expect(fake.rows.find(r => r.organisation_id === 'org-b')!.state).toBe('queued')
  })

  it('throws when the database rejects the claim', async () => {
    const fake = createFakeQueue([], { failRpc: { claim_jobs: 'deadlock detected' } })
    await expect(
      claimJobs(fake.client, { jobType: 'research', organisationId: 'o', worker: 'w' }),
    ).rejects.toThrow(/claim_jobs failed: deadlock detected/)
  })
})

describe('enqueueJob — idempotency', () => {
  it('returns the row when it created one', async () => {
    const fake = createFakeQueue([])
    const row = await enqueueJob(fake.client, {
      jobType: 'research', organisationId: 'o', prospectId: 'p1', enqueuedBy: 'test',
    })
    expect(row).not.toBeNull()
    expect(row!.prospect_id).toBe('p1')
  })

  it('returns null rather than throwing when a live job already exists', async () => {
    const fake = createFakeQueue([])
    const args = { jobType: 'research' as const, organisationId: 'o', prospectId: 'p1', enqueuedBy: 'test' }

    expect(await enqueueJob(fake.client, args)).not.toBeNull()
    // Second call collapses at the partial unique index. A no-op, not an error: this is
    // what makes a double click safe.
    expect(await enqueueJob(fake.client, args)).toBeNull()
  })

  it('allows the same prospect under a different job type', async () => {
    const fake = createFakeQueue([])
    const base = { organisationId: 'o', prospectId: 'p1', enqueuedBy: 'test' }
    expect(await enqueueJob(fake.client, { ...base, jobType: 'research' })).not.toBeNull()
    expect(await enqueueJob(fake.client, { ...base, jobType: 'compose' })).not.toBeNull()
  })

  it('applies the job type default attempt cap', async () => {
    const fake = createFakeQueue([])
    await enqueueJob(fake.client, {
      jobType: 'research', organisationId: 'o', prospectId: 'p1', enqueuedBy: 'test',
    })
    // Research is capped tighter than the others because it is the most expensive job.
    expect(fake.rpcCalls[0].args.p_max_attempts).toBe(QUEUE_CONFIG.research.maxAttempts)
    expect(QUEUE_CONFIG.research.maxAttempts).toBeLessThan(QUEUE_CONFIG.enrich.maxAttempts)
  })
})

describe('enqueueJobsForProspects — batch reporting', () => {
  it('separates what it created from what was already queued', async () => {
    const fake = createFakeQueue([])
    const base = { jobType: 'research' as const, organisationId: 'o', enqueuedBy: 'test' }

    await enqueueJobsForProspects(fake.client, { ...base, prospectIds: ['p1', 'p2'] })
    const second = await enqueueJobsForProspects(fake.client, {
      ...base, prospectIds: ['p2', 'p3'],
    })

    // "Nothing happened because it was all already queued" must not look like
    // "nothing happened because something is broken".
    expect(second.created.map(r => r.prospect_id)).toEqual(['p3'])
    expect(second.alreadyQueued).toEqual(['p2'])
  })
})

describe('recordJobSpend — must never throw', () => {
  it('returns true on success and writes the stamp', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    expect(await recordJobSpend(fake.client, job.id, { credits: 3 })).toBe(true)
    expect(fake.get(job.id)!.spend_recorded_at).not.toBeNull()
  })

  it('returns false instead of throwing when the rpc errors', async () => {
    // This runs in the window between money leaving and work being recorded. An
    // exception here would abort the one write that prevents paying twice.
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job], { failRpc: { record_job_spend: 'connection lost' } })

    await expect(recordJobSpend(fake.client, job.id, { credits: 3 })).resolves.toBe(false)
  })

  it('returns false instead of throwing when the rpc itself throws', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job], {
      throwRpc: { record_job_spend: new Error('socket hang up') },
    })

    await expect(recordJobSpend(fake.client, job.id, { credits: 3 })).resolves.toBe(false)
  })
})

describe('failJob and completeJob', () => {
  it('sends the error class and the terminal flag through to the database', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    await failJob(fake.client, job.id, 'boom', 'permanent', true)

    expect(fake.rpcCalls[0].args).toMatchObject({
      p_error_class: 'permanent',
      p_force_terminal: true,
    })
  })

  it('truncates long error text to fit the column', async () => {
    const job = makeJob({ state: 'claimed' })
    const fake = createFakeQueue([job])

    await failJob(fake.client, job.id, 'x'.repeat(5000), 'transient')

    expect((fake.rpcCalls[0].args.p_error as string).length).toBeLessThanOrEqual(900)
  })

  it('returns null when the job was not claimed, rather than inventing a row', async () => {
    const job = makeJob({ state: 'queued' })
    const fake = createFakeQueue([job])
    expect(await completeJob(fake.client, job.id, 'summary')).toBeNull()
  })
})

describe('reclaimExpiredJobs', () => {
  it('requeues an expired lease under the attempt cap', async () => {
    const job = makeJob({
      state: 'claimed',
      claimed_by: 'dead-worker',
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      attempts: 1,
      max_attempts: 3,
    })
    const fake = createFakeQueue([job])

    const reclaimed = await reclaimExpiredJobs(fake.client)

    expect(reclaimed).toHaveLength(1)
    expect(fake.get(job.id)!.state).toBe('queued')
    expect(fake.get(job.id)!.claimed_by).toBeNull()
    // The dead worker is named so a repeating death is visible without opening the table.
    expect(fake.get(job.id)!.last_error).toContain('dead-worker')
  })

  it('terminates an expired lease that has used its attempts', async () => {
    const job = makeJob({
      state: 'claimed',
      claimed_by: 'dead-worker',
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      attempts: 3,
      max_attempts: 3,
    })
    const fake = createFakeQueue([job])

    await reclaimExpiredJobs(fake.client)
    expect(fake.get(job.id)!.state).toBe('failed')
  })

  it('leaves a live lease alone', async () => {
    const job = makeJob({
      state: 'claimed',
      claimed_by: 'busy-worker',
      lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
    })
    const fake = createFakeQueue([job])

    expect(await reclaimExpiredJobs(fake.client)).toEqual([])
    // Stealing a live worker's job is how a lease double-spends.
    expect(fake.get(job.id)!.state).toBe('claimed')
  })

  it('notes on the row when a reclaimed job was already paid for', async () => {
    const job = makeJob({
      state: 'claimed',
      claimed_by: 'dead-worker',
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      spend_recorded_at: '2026-08-24T10:00:00Z',
      attempts: 1,
      max_attempts: 3,
    })
    const fake = createFakeQueue([job])

    await reclaimExpiredJobs(fake.client)
    expect(fake.get(job.id)!.last_error).toMatch(/must not call the paid API again/i)
  })
})

describe('countInFlight — the pacing read', () => {
  it('counts only claimed jobs of the requested type', async () => {
    const fake = createFakeQueue([
      makeJob({ job_type: 'research', state: 'claimed' }),
      makeJob({ job_type: 'research', state: 'claimed' }),
      makeJob({ job_type: 'research', state: 'queued' }),
      makeJob({ job_type: 'research', state: 'done' }),
      makeJob({ job_type: 'compose',  state: 'claimed' }),
    ])

    expect(await countInFlight(fake.client, 'research')).toBe(2)
    expect(await countInFlight(fake.client, 'compose')).toBe(1)
  })
})

describe('getOrganisationBacklog', () => {
  it('groups queued work by organisation, oldest first', async () => {
    const older = new Date(Date.now() - 60_000).toISOString()
    const fake = createFakeQueue([
      makeJob({ organisation_id: 'org-b' }),
      makeJob({ organisation_id: 'org-a', created_at: older }),
      makeJob({ organisation_id: 'org-a', created_at: older }),
    ])

    const backlog = await getOrganisationBacklog(fake.client, 'research')

    expect(backlog[0].organisation_id).toBe('org-a')
    expect(backlog[0].depth).toBe(2)
  })
})
