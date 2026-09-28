import { describe, it, expect } from 'vitest'
import {
  BANNED_RESOLVERS,
  DEFAULT_RESOLVERS,
  BannedResolverError,
  makeResolver,
  resolverAddressesFrom,
  wrapResolve4,
} from '../resolver'

/**
 * A blocklist's answer depends on WHO ASKED, so the resolver is part of the instrument
 * rather than a deployment detail. Both directions: a banned resolver must be refused, and a
 * good one must be accepted, because a validator that rejects everything is an outage.
 */
describe('resolver selection', () => {
  it('refuses 1.1.1.1, which was named in the brief for this monitor', async () => {
    expect(() => resolverAddressesFrom('1.1.1.1')).toThrow(BannedResolverError)
    expect(() => resolverAddressesFrom('1.1.1.1')).toThrow(/Cloudflare/)
  })

  it('refuses every Cloudflare address, not just the memorable one', () => {
    for (const address of ['1.1.1.1', '1.0.0.1', '2606:4700:4700::1111', '2606:4700:4700::1001']) {
      expect(() => resolverAddressesFrom(address), address).toThrow(BannedResolverError)
    }
  })

  it('refuses Google, which was NOT in the brief and was added on measurement', () => {
    // 8.8.8.8 returned EMPTY for Spamhaus's own test point on 2026-09-28. That is the
    // dangerous direction: empty is what a clean domain returns, so Spamhaus would have gone
    // silently blind while the monitor read green.
    expect(() => resolverAddressesFrom('8.8.8.8')).toThrow(/Spamhaus returns EMPTY/)
    expect(() => resolverAddressesFrom('8.8.4.4')).toThrow(BannedResolverError)
  })

  it('refuses a list where only ONE entry is banned', () => {
    // The dangerous shape: a good primary hiding a bad secondary. resolve4 will fall through
    // to the secondary on any failure, so one bad entry is enough to poison the result.
    expect(() => resolverAddressesFrom('9.9.9.9,1.1.1.1')).toThrow(BannedResolverError)
    expect(() => resolverAddressesFrom('1.1.1.1,9.9.9.9')).toThrow(BannedResolverError)
  })

  it('is case-insensitive about IPv6 spelling', () => {
    expect(() => resolverAddressesFrom('2606:4700:4700::1111'.toUpperCase())).toThrow(
      BannedResolverError,
    )
  })

  // ── The other direction. A guard that blocks everything is an outage. ────────
  it('accepts Quad9, the only resolver measured to answer all three lists', () => {
    expect(resolverAddressesFrom('9.9.9.9')).toEqual(['9.9.9.9'])
    expect(resolverAddressesFrom('9.9.9.9,149.112.112.112')).toEqual([
      '9.9.9.9',
      '149.112.112.112',
    ])
  })

  it('defaults to Quad9 when nothing is configured', () => {
    for (const raw of [undefined, '', '   ', ',,']) {
      expect(resolverAddressesFrom(raw)).toEqual([...DEFAULT_RESOLVERS])
    }
  })

  it('trims whitespace around configured addresses', () => {
    expect(resolverAddressesFrom(' 9.9.9.9 , 149.112.112.112 ')).toEqual([
      '9.9.9.9',
      '149.112.112.112',
    ])
  })

  it('its own default is not banned, which would make the monitor unrunnable', () => {
    // A self-check: if somebody ever adds Quad9 to the ban list without changing the
    // default, every run throws before it queries anything.
    expect(() => resolverAddressesFrom(undefined)).not.toThrow()
    for (const address of DEFAULT_RESOLVERS) {
      expect(BANNED_RESOLVERS.has(address), `${address} is both default and banned`).toBe(false)
    }
  })

  it('every ban carries a reason, so a failure says why', () => {
    expect(BANNED_RESOLVERS.size).toBeGreaterThan(0)
    for (const [address, reason] of BANNED_RESOLVERS) {
      expect(reason, `${address} has no reason`).toBeTruthy()
      expect(reason.length, `${address} reason is too short to be useful`).toBeGreaterThan(20)
    }
  })
})

/**
 * THE GAP MUTATION TESTING FOUND.
 *
 * On 2026-09-28 this build was mutation-tested with eleven mutations. Ten went red. The one
 * that survived was replacing `throw err` with `return []` in the real resolver, which turns
 * every timeout and SERVFAIL into "not listed" and is the single most dangerous change
 * available to this monitor: it is the silent all-clear the whole check exists to prevent.
 *
 * It survived because the sweep's tests inject a fake resolver, so nothing ever exercised
 * the real one's decision about which failures mean "no records". These are that test.
 */
describe('which DNS failures mean "not listed", and which mean "we could not tell"', () => {
  function throwingWith(code: string | undefined): (name: string) => Promise<string[]> {
    return async () => {
      const err = new Error(`simulated ${code ?? 'no code'}`) as NodeJS.ErrnoException
      if (code) err.code = code
      throw err
    }
  }

  it('passes an answer straight through', async () => {
    const resolve = wrapResolve4(async () => ['127.0.0.64'])
    await expect(resolve('x')).resolves.toEqual(['127.0.0.64'])
  })

  it('treats ENOTFOUND and ENODATA as not listed, because the name genuinely is absent', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      const resolve = wrapResolve4(throwingWith(code))
      await expect(resolve('x'), code).resolves.toEqual([])
    }
  })

  it.each(['ETIMEOUT', 'ETIMEOUT', 'SERVFAIL', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED', 'ECANCELLED'])(
    'RETHROWS %s, because a failure to ask is not a clean answer',
    async (code) => {
      const resolve = wrapResolve4(throwingWith(code))
      await expect(resolve('x')).rejects.toThrow(/simulated/)
    },
  )

  it('rethrows an error with no code at all rather than assuming it is clean', async () => {
    const resolve = wrapResolve4(throwingWith(undefined))
    await expect(resolve('x')).rejects.toThrow(/simulated/)
  })

  it('rethrows a thrown non-Error, failing closed on anything unrecognised', async () => {
    const resolve = wrapResolve4(async () => {
      throw 'a bare string'
    })
    await expect(resolve('x')).rejects.toBeTruthy()
  })

  it('makeResolver returns something callable over the given servers', () => {
    // Construction only, no query: a real lookup here would make the suite depend on DNS.
    expect(typeof makeResolver(['9.9.9.9'])).toBe('function')
  })
})
