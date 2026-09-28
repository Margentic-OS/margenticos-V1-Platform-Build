// The DNS resolver MON-035 queries blocklists through, and the resolvers it refuses to use.
//
// Separate from sweep.ts so the sweep stays pure and testable. This is the only file here
// that touches the network.

import { Resolver } from 'node:dns/promises'
import type { ResolveA } from './sweep'

/**
 * Resolvers that must never be used, with the measurement that disqualified each.
 *
 * A blocklist's answer depends on WHO ASKED. These lists reject queries arriving via large
 * public resolvers, and they reject them in ways that read as clean. So the resolver is not
 * a detail of deployment, it is part of the instrument, and a wrong one silently disables
 * the whole check.
 *
 * MEASURED 2026-09-28 against each list's own test point:
 *
 *   1.1.1.1 / 1.0.0.1   Cloudflare. Spamhaus answered 127.255.255.254, which is its
 *                       "blocked / public resolver" code, and SURBL TIMED OUT entirely.
 *                       Named in the brief for this monitor and banned outright.
 *
 *   8.8.8.8 / 8.8.4.4   Google. NOT in the brief, added on measurement. Spamhaus returned
 *                       EMPTY for a domain it certainly lists, and URIBL returned
 *                       127.0.0.1, its refusal code. The Spamhaus answer is the dangerous
 *                       one: empty is exactly what a clean domain returns, so two of three
 *                       lists would have gone quietly blind.
 *
 * The control in sweep.ts would catch all of these, and that is the point of it. This list
 * is the second layer, so a known-bad resolver fails at configuration time with a named
 * reason rather than as a red monitor somebody has to diagnose.
 */
export const BANNED_RESOLVERS: ReadonlyMap<string, string> = new Map([
  ['1.1.1.1', 'Cloudflare: Spamhaus returns its blocked code 127.255.255.254 and SURBL times out'],
  ['1.0.0.1', 'Cloudflare secondary: same as 1.1.1.1'],
  ['2606:4700:4700::1111', 'Cloudflare IPv6: same as 1.1.1.1'],
  ['2606:4700:4700::1001', 'Cloudflare IPv6 secondary: same as 1.1.1.1'],
  ['8.8.8.8', 'Google: Spamhaus returns EMPTY for a listed domain, URIBL returns its refusal code'],
  ['8.8.4.4', 'Google secondary: same as 8.8.8.8'],
])

/**
 * Quad9. The only resolver measured on 2026-09-28 that returned the correct listing for all
 * THREE test points. The system default also worked, but a serverless runtime's default
 * resolver is not ours to rely on, so it is named explicitly.
 */
export const DEFAULT_RESOLVERS: ReadonlyArray<string> = ['9.9.9.9', '149.112.112.112']

export class BannedResolverError extends Error {}

/**
 * Parse and validate the resolver list.
 *
 * Throws rather than falling back to the default, because a silent fallback would turn a
 * misconfiguration into a working monitor that is not measuring what the operator told it
 * to measure.
 */
export function resolverAddressesFrom(raw: string | undefined): string[] {
  const configured = (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const addresses = configured.length > 0 ? configured : [...DEFAULT_RESOLVERS]

  for (const address of addresses) {
    const reason = BANNED_RESOLVERS.get(address.toLowerCase())
    if (reason) {
      throw new BannedResolverError(
        `Refusing to query blocklists through ${address}. ${reason}. ` +
          `Use one of ${DEFAULT_RESOLVERS.join(', ')}, or a resolver you have verified ` +
          `answers all three test points.`,
      )
    }
  }

  return addresses
}

/**
 * An A-record resolver over the given servers.
 *
 * NXDOMAIN and NODATA return [], which is how "not listed" reaches the classifier. EVERY
 * OTHER ERROR THROWS, and the sweep turns that into a control failure. Collapsing a
 * timeout or a SERVFAIL into [] would be the exact bug this monitor exists to prevent: an
 * instrument failure rendered as a clean result.
 */
export function makeResolver(addresses: readonly string[], timeoutMs = 5000): ResolveA {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 })
  resolver.setServers([...addresses])

  return async (name: string): Promise<string[]> => {
    try {
      return await resolver.resolve4(name)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOTFOUND' || code === 'ENODATA') return []
      throw err
    }
  }
}
