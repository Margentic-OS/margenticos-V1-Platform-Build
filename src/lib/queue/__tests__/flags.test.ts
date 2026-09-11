// Rollout flags. Three answers, and the third is the reason this file was rewritten.
//
//   genuinely off   returns false, and says NOTHING: no Sentry event, no log line
//   genuinely on    returns true
//   unreadable      THROWS, and reports to Sentry. It never returns false.
//
// Until 2026-09-11 an unreadable switch returned false, which is the same answer as a
// genuine off. For the queue worker that meant a skipped minute of work with a warning nobody
// reads, and it happened forty times in one day. See the header of flags.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Sentry from '@sentry/nextjs'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  isQueueEnabled,
  setQueueFlag,
  QUEUE_FLAG_KEYS,
  QueueFlagUnreadableError,
} from '../flags'
import { JOB_TYPES } from '../types'
import { createFakeQueue } from './fake-queue'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

beforeEach(() => vi.clearAllMocks())

describe('isQueueEnabled — reading the flag', () => {
  it('returns true only when the row says enabled', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_enrich', true)
    expect(await isQueueEnabled(fake.client, 'enrich')).toBe(true)
  })

  it('returns false when the row says disabled', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_enrich', false)
    expect(await isQueueEnabled(fake.client, 'enrich')).toBe(false)
  })

  it('reads a different key per job type', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_enrich', true)
    fake.flags.set('queue_research', false)

    // One job type being live must never imply another is.
    expect(await isQueueEnabled(fake.client, 'enrich')).toBe(true)
    expect(await isQueueEnabled(fake.client, 'research')).toBe(false)
  })

  it('maps each job type to its documented key', () => {
    // These strings are also written by the migrations' seed INSERTs. If they drift, the
    // flag reads a missing row and the job type reads as switched off.
    expect(QUEUE_FLAG_KEYS).toEqual({
      enrich:           'queue_enrich',
      research:         'queue_research',
      compose:          'queue_compose',
      research_sources: 'queue_research_sources',
      research_collect: 'queue_research_collect',
    })
  })

  it('gives EVERY job type a key, checked against JOB_TYPES rather than a copy of it', () => {
    // The assertion above is a literal, so it can only fail once someone has already
    // added a job type AND remembered to come here. This one fails the moment JOB_TYPES
    // grows: a job type with no flag key reads undefined, isQueueEnabled queries for a
    // row that cannot exist, and the type reads as off for ever with nothing saying why.
    for (const jobType of JOB_TYPES) {
      expect(QUEUE_FLAG_KEYS[jobType], `no flag key for job type '${jobType}'`).toBeTruthy()
    }
    expect(Object.keys(QUEUE_FLAG_KEYS).sort()).toEqual([...JOB_TYPES].sort())
  })

  it('the two research paths read DIFFERENT keys, so one cannot imply the other', async () => {
    // queue_research_sources is the switch and queue_research is the old path. If these
    // ever collapsed onto one key, rolling back would be impossible: turning the batch
    // path off would turn the proven path off with it.
    expect(QUEUE_FLAG_KEYS.research).not.toBe(QUEUE_FLAG_KEYS.research_sources)

    const fake = createFakeQueue([])
    fake.flags.set('queue_research', true)
    fake.flags.set('queue_research_sources', false)
    expect(await isQueueEnabled(fake.client, 'research')).toBe(true)
    expect(await isQueueEnabled(fake.client, 'research_sources')).toBe(false)
  })

  it('the drain valve is independent of the switch', async () => {
    // Rollback is: queue_research_sources OFF, queue_research_collect LEFT ON, so
    // batches already submitted and already paid for still get collected. If collect
    // were gated on sources this would be impossible and the money would be lost.
    const fake = createFakeQueue([])
    fake.flags.set('queue_research_sources', false)
    fake.flags.set('queue_research_collect', true)

    expect(await isQueueEnabled(fake.client, 'research_sources')).toBe(false)
    expect(await isQueueEnabled(fake.client, 'research_collect')).toBe(true)
  })
})

describe('isQueueEnabled — the three answers', () => {
  it('GENUINELY OFF is quiet: false, no Sentry event, no log line', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_compose', false)

    expect(await isQueueEnabled(fake.client, 'compose')).toBe(false)
    expect(Sentry.captureException).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('GENUINELY ON runs: true, and also quiet', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_compose', true)

    expect(await isQueueEnabled(fake.client, 'compose')).toBe(true)
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  it('UNREADABLE raises: a failed select throws, and is reported to Sentry', async () => {
    const fake = createFakeQueue([], { failRpc: { 'select:system_flags': 'permission denied' } })
    fake.flags.set('queue_enrich', true)

    const read = isQueueEnabled(fake.client, 'enrich')
    await expect(read).rejects.toBeInstanceOf(QueueFlagUnreadableError)
    await expect(read).rejects.toThrow(/queue_enrich could not be read.*permission denied/)

    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    const [reported, context] = vi.mocked(Sentry.captureException).mock.calls[0]
    expect(reported).toBeInstanceOf(QueueFlagUnreadableError)
    expect(context).toMatchObject({ tags: { flag_key: 'queue_enrich', job_type: 'enrich' } })
  })

  it('UNREADABLE raises when the client itself throws, and is reported to Sentry', async () => {
    const exploding = {
      from() {
        throw new Error('client is not initialised')
      },
    } as never

    await expect(isQueueEnabled(exploding, 'compose'))
      .rejects.toThrow(/queue_compose could not be read.*client is not initialised/)
    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
  })

  it('UNREADABLE never reads as off, even when the stored value WAS off', async () => {
    // The old behaviour was indistinguishable from this row's real value. The new one must
    // not be: an operator reading "false" here would be told something nobody measured.
    const fake = createFakeQueue([], { failRpc: { 'select:system_flags': 'Gateway Timeout' } })
    fake.flags.set('queue_research', false)

    await expect(isQueueEnabled(fake.client, 'research')).rejects.toBeInstanceOf(QueueFlagUnreadableError)
  })

  it('an unreadable switch cut by an empty 504 names the status, through the real client', async () => {
    // The real incident, reproduced below the fake: the gateway cut, read through
    // postgrest-js, not through a stub that returns a message nobody would have received.
    const client = createClient('https://example.supabase.co', 'test-anon-key', {
      global: {
        fetch: async () => new Response(null, { status: 504, statusText: 'Gateway Timeout' }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    await expect(isQueueEnabled(client, 'research'))
      .rejects.toThrow(/queue_research could not be read.*HTTP 504 Gateway Timeout/)
  })
})

describe('isQueueEnabled — the two states that are not failed reads', () => {
  it('a missing flag row reads as off, with a warning and no Sentry event', async () => {
    const fake = createFakeQueue([])
    // No row seeded. The read succeeded and found no instruction.
    expect(await isQueueEnabled(fake.client, 'research')).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/flag row missing/),
      expect.objectContaining({ flag_key: 'queue_research' }),
    )
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  it('treats a non-boolean value as disabled', async () => {
    const weird = {
      from: () => ({
        select: () => ({
          eq: function () { return this },
          maybeSingle: async () => ({ data: { enabled: 'yes' }, error: null }),
        }),
      }),
    } as never

    // Strict === true. A truthy string must not switch a money-spending path on.
    await expect(isQueueEnabled(weird, 'enrich')).resolves.toBe(false)
  })
})

describe('setQueueFlag', () => {
  it('writes the new value against the right key', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_research', false)
    await setQueueFlag(fake.client, 'research', true, 'operator:doug')
    expect(fake.flags.get('queue_research')).toBe(true)
  })

  it('can turn a flag back off, which is the rollback', async () => {
    const fake = createFakeQueue([])
    fake.flags.set('queue_research', false)
    await setQueueFlag(fake.client, 'research', true, 'operator:doug')
    await setQueueFlag(fake.client, 'research', false, 'circuit-breaker:apify-exhausted')
    expect(fake.flags.get('queue_research')).toBe(false)
  })

  it('throws when the write errors, because a silent no-op here is dangerous', async () => {
    const fake = createFakeQueue([], { failRpc: { 'update:system_flags': 'read only transaction' } })
    fake.flags.set('queue_enrich', true)

    // The write is loud for the same reason the read now is: an operator who thinks they
    // turned the queue off, and did not, is worse off than one who sees an error.
    await expect(setQueueFlag(fake.client, 'enrich', false, 'operator:doug'))
      .rejects.toThrow(/Failed to set queue_enrich to false/)
  })

  it('THROWS when the update matched ZERO rows, rather than reporting success', async () => {
    // The circuit-breaker bug. A bare .update().eq() returns error null when it matched
    // nothing, so a missing or misnamed flag row reported success while changing nothing.
    // If that happens to the credit-exhaustion breaker, the breaker does not exist: the
    // worker believes it stopped the job type and keeps hammering a dry account.
    const fake = createFakeQueue([])
    // No row seeded, so nothing matches.
    await expect(setQueueFlag(fake.client, 'research', false, 'circuit-breaker:apify-exhausted'))
      .rejects.toThrow(/no system_flags row matched/)
  })

  it('the zero-row throw names the consequence for the circuit breaker', async () => {
    const fake = createFakeQueue([])
    await expect(setQueueFlag(fake.client, 'enrich', false, 'circuit-breaker'))
      .rejects.toThrow(/job type is still running/)
  })
})
