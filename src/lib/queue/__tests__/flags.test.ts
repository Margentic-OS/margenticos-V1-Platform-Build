// Rollout flags. Every test here is really the same test: does it fail closed?
//
// A flag read that goes wrong must land on the INLINE path, because the inline path is
// the one already running in production. Silently switching execution onto new
// machinery because a select errored is the failure this module exists to prevent.

import { describe, it, expect } from 'vitest'
import { isQueueEnabled, setQueueFlag, QUEUE_FLAG_KEYS } from '../flags'
import { createFakeQueue } from './fake-queue'

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
    // These strings are also written by the migration's seed INSERT. If they drift, the
    // flag silently reads a missing row and every job type falls back to inline.
    expect(QUEUE_FLAG_KEYS).toEqual({
      enrich:   'queue_enrich',
      research: 'queue_research',
      compose:  'queue_compose',
    })
  })
})

describe('isQueueEnabled — failing closed', () => {
  it('falls back to the inline path when the select errors', async () => {
    const fake = createFakeQueue([], { failRpc: { 'select:system_flags': 'permission denied' } })
    expect(await isQueueEnabled(fake.client, 'enrich')).toBe(false)
  })

  it('falls back to the inline path when the flag row is missing', async () => {
    const fake = createFakeQueue([])
    // No row seeded. "No instruction" reads as "do what we did before".
    expect(await isQueueEnabled(fake.client, 'research')).toBe(false)
  })

  it('falls back to the inline path when the client throws', async () => {
    const exploding = {
      from() {
        throw new Error('client is not initialised')
      },
    } as never

    await expect(isQueueEnabled(exploding, 'compose')).resolves.toBe(false)
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

    // Unlike the read, the write must be loud: an operator who thinks they turned the
    // queue off, and did not, is worse off than one who sees an error.
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
