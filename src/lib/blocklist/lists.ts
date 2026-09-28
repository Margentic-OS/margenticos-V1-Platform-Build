// The domain blocklists MON-035 queries, and how to read their answers.
//
// Pure data and pure functions, no DNS. The sweep in ./sweep.ts injects a resolver so the
// classification below can be tested without a network, which is the half that has to be
// right: every failure mode in this file looks like a clean result.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ONLY HARD PART: A REFUSED QUERY LOOKS EXACTLY LIKE A CLEAN DOMAIN
//
// These lists refuse queries from public resolvers and from high-volume clients, and they
// refuse in three different shapes. Two of the three are indistinguishable from "not
// listed" unless you know the codes.
//
// MEASURED 2026-09-28, each list's own test point, five resolvers:
//
//   resolver          dbl.spamhaus.org   multi.surbl.org   multi.uribl.com
//   system default    127.0.1.2   ok     127.0.0.254 ok    127.0.0.14  ok
//   9.9.9.9  Quad9    127.0.1.2   ok     127.0.0.254 ok    127.0.0.14  ok
//   8.8.8.8  Google   (EMPTY)     BAD    127.0.0.254 ok    127.0.0.1   BAD
//   1.1.1.1  CF       127.255.255.254 BAD (timed out) BAD  127.0.0.14  ok
//   208.67.222.222    127.0.1.2   ok     127.0.0.254 ok    127.0.0.1   BAD
//
// Read the 8.8.8.8 row. Spamhaus returned NOTHING for a domain it certainly lists. An
// "empty means clean" reading of that answer reports every domain on earth as clean, and
// the monitor goes green over a blocklisting it is built to find.
//
// THAT IS WHY THE POSITIVE CONTROL IS NOT OPTIONAL AND IS NOT DECORATION. A negative
// answer from these lists carries no information on its own. It only means "not listed"
// once the same list, in the same run, through the same resolver, has been seen to return
// a listing for a domain it is known to list. The control is what makes the negative
// meaningful, and without it this whole monitor is an expensive way to print OK.
//
// This is the shape CLAUDE.md names over and over: a check that returns nothing has not
// told you the world is empty, it has told you the check answered.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What one list said about one name.
 *
 *   listed      the list returned an address that means "this domain is on me"
 *   not_listed  the list returned nothing. ONLY trustworthy if the control passed.
 *   refused     the list returned something that is not a listing: a block code, a
 *               public-resolver rejection, or anything unrecognised.
 *
 * `refused` is deliberately separate from both. "We could not tell" and "it is fine" are
 * different answers, and rendering the first as the second is how a check becomes
 * decoration. Same reasoning as MON-026 treating `unreachable` as red.
 */
export type BlocklistAnswer = 'listed' | 'not_listed' | 'refused'

export interface Blocklist {
  /** Stable key, used in the stored snapshot and in alert text. */
  readonly code: string
  /** What an operator reads. */
  readonly label: string
  /** The DNS zone a query is appended to. */
  readonly zone: string
  /**
   * The list's OWN published test point: a name the list guarantees to return a listing
   * for. Each list publishes its own and they are not interchangeable, which is a real
   * trap: `dbltest.com` is Spamhaus's, and asking SURBL about it returns empty, which
   * would read as a broken control on a perfectly healthy list.
   */
  readonly testPoint: string
  /** True when this address, from THIS list, means the queried domain is listed. */
  readonly isListed: (address: string) => boolean
}

/**
 * A domain that must NOT be listed anywhere, queried in the same run as the positive
 * control.
 *
 * NOT part of the original brief, added because the positive control cannot see this
 * failure: a resolver or middlebox that answers every query with a wildcard address
 * passes the positive control perfectly and then reports all five sending domains as
 * listed. One extra query per list turns that from a five-domain false alarm into a named
 * control failure.
 *
 * Measured empty on all three lists, 2026-09-28.
 */
export const CLEAN_CONTROL_DOMAIN = 'example.com'

/** Last octet of a 127.0.0.x answer, or null if the address is not in that form. */
function lastOctetOf127(address: string, thirdOctet: number): number | null {
  const m = /^127\.0\.(\d+)\.(\d+)$/.exec(address.trim())
  if (!m) return null
  if (Number(m[1]) !== thirdOctet) return null
  const octet = Number(m[2])
  return Number.isFinite(octet) ? octet : null
}

/**
 * Spamhaus DBL. Listings are 127.0.1.2 through 127.0.1.99, one code per category.
 *
 * 127.0.1.255 is "typing error, not a domain" and 127.255.255.0/24 is the error range:
 * query via a public resolver, excessive volume, or blocked outright. 1.1.1.1 returned
 * 127.255.255.254 above. Neither is a listing, so both fall through to `refused`.
 *
 * https://www.spamhaus.org/faqs/dnsbl-usage/ documents the return codes.
 */
const spamhausDbl: Blocklist = {
  code: 'SPAMHAUS_DBL',
  label: 'Spamhaus DBL',
  zone: 'dbl.spamhaus.org',
  testPoint: 'dbltest.com',
  isListed: (address) => {
    const octet = lastOctetOf127(address, 1)
    return octet !== null && octet >= 2 && octet <= 99
  },
}

/**
 * SURBL. The last octet is a BITMASK, not a code, so a domain on several of its sublists
 * returns the sum. The abuse bit is 64, which is what both listed MargenticOS domains
 * returned on 2026-09-28 (`127.0.0.64`).
 *
 * The test point returns 127.0.0.254, every bit set. That was initially misread as a
 * refusal code during the 2026-09-28 investigation, and the thing that settled it was the
 * negative control coming back empty: a blanket refusal would have refused that too.
 *
 * Bit 1 is not a list bit on any of these lists, so a bare 127.0.0.1 is an error rather
 * than a listing and is left to fall through to `refused`.
 */
const surbl: Blocklist = {
  code: 'SURBL',
  label: 'SURBL',
  zone: 'multi.surbl.org',
  testPoint: 'test.surbl.org',
  isListed: (address) => {
    const octet = lastOctetOf127(address, 0)
    if (octet === null) return false
    // 8 phishing, 16 malware, 32 spam, 64 abuse, 128 cracked. 2 and 4 are retired
    // sublists and are accepted so an old listing is not read as an error.
    return (octet & 0b1111_1110) !== 0
  },
}

/**
 * URIBL. Also a bitmask: 2 black, 4 grey, 8 red. The test point returns 127.0.0.14,
 * which is 2|4|8.
 *
 * 127.0.0.1 is URIBL's documented "query refused" answer, returned when the query came
 * through a public resolver or over the free-tier limit. Both 8.8.8.8 and OpenDNS
 * returned exactly that above. It has no list bit set, so it classifies as `refused`
 * rather than as a listing, which is the difference between a false alarm on every
 * sending domain and a named control failure.
 */
const uribl: Blocklist = {
  code: 'URIBL',
  label: 'URIBL',
  zone: 'multi.uribl.com',
  testPoint: 'test.uribl.com',
  isListed: (address) => {
    const octet = lastOctetOf127(address, 0)
    if (octet === null) return false
    return (octet & 0b0000_1110) !== 0
  },
}

/**
 * ONE ARRAY, not a set of parallel lists.
 *
 * Every field a list needs travels with it, so there is no second list to keep in step
 * and no index arithmetic. This is the same fix as MONITORS in the monitor sweep, applied
 * before the drift rather than after it: there the code array and the view array diverged
 * and mon_019 was never read for weeks.
 */
export const BLOCKLISTS: ReadonlyArray<Blocklist> = [spamhausDbl, surbl, uribl] as const

/**
 * Spamhaus refuses the free public zone from datacenter ranges, which is where this runs.
 * Their Data Query Service gives a per-account zone that is not rate-limited the same way,
 * and swapping the zone is the whole of the change.
 *
 * If the key is absent the public zone is used and the control reports the truth about
 * whether it answered. That is the correct default: it fails loudly rather than quietly
 * dropping Spamhaus from the sweep.
 */
export function withSpamhausDqsKey(
  lists: ReadonlyArray<Blocklist>,
  dqsKey: string | undefined,
): ReadonlyArray<Blocklist> {
  const key = dqsKey?.trim()
  if (!key) return lists
  return lists.map(list =>
    list.code === 'SPAMHAUS_DBL' ? { ...list, zone: `${key}.dbl.dq.spamhaus.net` } : list,
  )
}

/**
 * Classify one list's answer for one name.
 *
 * Empty is `not_listed`: that is what a genuinely clean domain returns. It is also what a
 * silently blocked resolver returns, which is why the caller must weigh this against the
 * control and must never report a clean sweep whose control did not pass.
 *
 * Anything present but not recognisable as a listing is `refused`, never `not_listed`.
 * Failing closed here is deliberate: an unrecognised code is an instrument we do not
 * understand, and the one thing we must not do is call it clean.
 */
export function classifyAnswer(list: Blocklist, addresses: readonly string[]): BlocklistAnswer {
  if (addresses.length === 0) return 'not_listed'
  if (addresses.some(a => list.isListed(a))) return 'listed'
  return 'refused'
}

/** The name to query for `domain` on `list`. */
export function queryNameFor(list: Blocklist, domain: string): string {
  return `${domain.trim().toLowerCase()}.${list.zone}`
}
