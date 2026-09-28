import { describe, it, expect } from 'vitest'
import {
  BANNED_RESOLVERS,
  DEFAULT_RESOLVERS,
  BannedResolverError,
  resolverAddressesFrom,
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
