// MON-035's sweep: ask every blocklist about every sending domain, and prove the
// instrument answered in the same run.
//
// The resolver is INJECTED. Every branch below is reachable in a unit test with no DNS,
// which matters more here than usual: the failures this guards against are all failures of
// the instrument, and an instrument you can only exercise against the real world is one
// whose failure modes you test by hoping.

import {
  BLOCKLISTS,
  CLEAN_CONTROL_DOMAIN,
  classifyAnswer,
  queryNameFor,
  type Blocklist,
} from './lists'

/** Resolve A records for a name. MUST return [] for NXDOMAIN and throw only on real errors. */
export type ResolveA = (name: string) => Promise<string[]>

export interface BlocklistListing {
  domain: string
  list: string
  address: string
}

/**
 * A reason one list's answers cannot be trusted this run.
 *
 *   positive  the list did not return a listing for its own test point
 *   negative  the list returned a listing for a domain that must be clean
 *   error     the query threw
 */
export interface ControlFailure {
  list: string
  kind: 'positive' | 'negative' | 'error'
  detail: string
}

export interface BlocklistVerdict {
  /**
   * Total domains queried: sending plus brand.
   *
   * NOT the denominator mon_035 uses for its vacuous-truth check. See
   * sendingDomainsChecked, and the comment there for why folding the two together would
   * have retired an existing guard without anybody noticing.
   */
  domainsChecked: number
  /**
   * Sending domains queried. THE DENOMINATOR mon_035 reads to decide whether the sweep had
   * anything in scope.
   *
   * Counted apart from the brand domains for one specific reason: the brand list is a
   * non-empty hardcoded floor, so a combined count could never be zero, and
   * `domains_checked = 0` is what tells the monitor the sending-stats sync has stopped.
   * Adding the brand domain to the same count would have silently turned that guard into
   * dead code. Same shape as the parallel arrays and the `as` cast in CLAUDE.md: the
   * feature works and something quietly stops watching.
   */
  sendingDomainsChecked: number
  /** Brand domains queried, excluding any that also turned up as a sending domain. */
  brandDomainsChecked: number
  listsTotal: number
  listsTrusted: number
  listedCount: number
  listings: BlocklistListing[]
  controlFailures: ControlFailure[]
  /** Domain queries on a TRUSTED list that came back unrecognised, e.g. mid-run rate limiting. */
  refusedCount: number
  incomplete: boolean
  detail: string
}

export interface SweepInput {
  resolve: ResolveA
  /** Sending domains in use. An empty list is UNKNOWN downstream, never OK. */
  domains: readonly string[]
  /**
   * Domains to check regardless of whether they send, from brandDomainsFrom().
   *
   * Defaults to EMPTY here rather than to BRAND_DOMAINS, so the sweep stays a pure function
   * of what it is handed and no test silently acquires a live DNS query. The route supplies
   * the real list; brandDomainsFrom() is what guarantees it is never empty in production.
   */
  brandDomains?: readonly string[]
  lists?: ReadonlyArray<Blocklist>
}

/**
 * Run the sweep.
 *
 * Never throws for a DNS failure: a thrown query becomes a control failure and sets
 * `incomplete`, so a network problem is reported as a red monitor rather than as a crashed
 * cron whose snapshot silently goes stale.
 */
export async function runBlocklistSweep(input: SweepInput): Promise<BlocklistVerdict> {
  const lists = input.lists ?? BLOCKLISTS
  const sending = normalise(input.domains)
  // A brand domain that has started sending is counted as a sending domain and queried once,
  // not twice. The sending count is the one that must stay honest.
  const brand = normalise(input.brandDomains ?? []).filter(d => !sending.includes(d))
  const domains = [...new Set([...sending, ...brand])].sort()

  const listings: BlocklistListing[] = []
  const controlFailures: ControlFailure[] = []
  let refusedCount = 0
  let incomplete = false
  let listsTrusted = 0

  for (const list of lists) {
    // ── Controls first. Nothing this list says about a real domain counts until both pass.
    let positiveOk = false
    let negativeOk = false

    try {
      const positive = await input.resolve(queryNameFor(list, list.testPoint))
      const verdict = classifyAnswer(list, positive)
      positiveOk = verdict === 'listed'
      if (!positiveOk) {
        controlFailures.push({
          list: list.code,
          kind: 'positive',
          detail:
            `${list.label} did not report its own test point ${list.testPoint} as listed ` +
            `(answered ${positive.length ? positive.join(',') : 'nothing'}, read as ${verdict}). ` +
            `Its negative answers carry no information this run.`,
        })
      }
    } catch (err) {
      incomplete = true
      controlFailures.push({
        list: list.code,
        kind: 'error',
        detail: `${list.label} positive control query threw: ${errText(err)}`,
      })
    }

    try {
      const negative = await input.resolve(queryNameFor(list, CLEAN_CONTROL_DOMAIN))
      const verdict = classifyAnswer(list, negative)
      negativeOk = verdict === 'not_listed'
      if (!negativeOk) {
        controlFailures.push({
          list: list.code,
          kind: 'negative',
          detail:
            `${list.label} reported the clean control ${CLEAN_CONTROL_DOMAIN} as ${verdict} ` +
            `(answered ${negative.join(',')}). Something is answering every query, so a ` +
            `listing from this list would be a false alarm.`,
        })
      }
    } catch (err) {
      incomplete = true
      controlFailures.push({
        list: list.code,
        kind: 'error',
        detail: `${list.label} negative control query threw: ${errText(err)}`,
      })
    }

    if (!positiveOk || !negativeOk) continue
    listsTrusted++

    // ── Only now are this list's answers about our own domains worth reading.
    for (const domain of domains) {
      try {
        const answers = await input.resolve(queryNameFor(list, domain))
        const verdict = classifyAnswer(list, answers)
        if (verdict === 'listed') {
          listings.push({
            domain,
            list: list.code,
            address: answers.find(a => list.isListed(a)) ?? answers[0],
          })
        } else if (verdict === 'refused') {
          // The control passed and then this query did not. Most likely rate limiting part
          // way through. Counted, not ignored: "could not tell" is not "clean".
          refusedCount++
        }
      } catch (err) {
        incomplete = true
        controlFailures.push({
          list: list.code,
          kind: 'error',
          detail: `${list.label} query for ${domain} threw: ${errText(err)}`,
        })
      }
    }
  }

  return {
    domainsChecked: domains.length,
    sendingDomainsChecked: sending.length,
    brandDomainsChecked: brand.length,
    listsTotal: lists.length,
    listsTrusted,
    listedCount: listings.length,
    listings,
    controlFailures,
    refusedCount,
    incomplete,
    detail: describe({
      domains,
      sending,
      brand,
      lists,
      listsTrusted,
      listings,
      controlFailures,
      refusedCount,
      incomplete,
    }),
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Trim, lowercase, drop blanks, de-duplicate, sort. */
function normalise(domains: readonly string[]): string[] {
  return [...new Set(domains.map(d => d.trim().toLowerCase()).filter(Boolean))].sort()
}

/**
 * The sentence an operator reads on the monitor board.
 *
 * ALWAYS carries the denominators, both of them: how many domains and how many lists.
 * A bare "no listings" is exactly what a sweep that examined nothing also reports, and
 * this codebase has shipped that confusion more than once.
 */
function describe(v: {
  domains: readonly string[]
  sending: readonly string[]
  brand: readonly string[]
  lists: ReadonlyArray<Blocklist>
  listsTrusted: number
  listings: BlocklistListing[]
  controlFailures: ControlFailure[]
  refusedCount: number
  incomplete: boolean
}): string {
  const scope =
    `${v.sending.length} sending domain(s) and ${v.brand.length} brand domain(s) against ` +
    `${v.listsTrusted} of ${v.lists.length} blocklist(s) whose controls passed`

  if (v.domains.length === 0) {
    return (
      'No domains to check at all, so nothing was queried. This is not a pass: the sending ' +
      'list is derived from recent per-mailbox sending stats and the brand list is a ' +
      'hardcoded floor, so both being empty means the brand floor is not reaching this sweep.'
    )
  }

  const parts: string[] = []

  // Reported as a named problem rather than by an absent count, because the brand floor
  // means the total is never zero and the old "nothing in scope" reading is unavailable.
  if (v.sending.length === 0) {
    return (
      'NO SENDING DOMAIN IN SCOPE. No sending domain has appeared in the per-mailbox daily ' +
      `stats in the last 30 days, so only the ${v.brand.length} brand domain(s) ` +
      `(${v.brand.join(', ')}) were queried. That is not a pass: either nothing has sent for ` +
      'a month or the sending-stats sync has stopped. ' +
      describeFindings(v).replace(/^No listings\./, 'No listings on the brand domain(s).') +
      ` Checked ${scope}.`
    )
  }

  if (v.listings.length > 0) {
    const named = v.listings
      .map(l => `${l.domain} on ${l.list} (${l.address})`)
      .join('; ')
    parts.push(`LISTED: ${named}.`)
  }

  if (v.controlFailures.length > 0) {
    parts.push(
      `CONTROL FAILURES (${v.controlFailures.length}): ` +
        v.controlFailures.map(c => c.detail).join(' ') +
        ' A list whose control failed was not asked about our domains at all, because its ' +
        'answers would be meaningless.',
    )
  }

  if (v.refusedCount > 0) {
    parts.push(
      `${v.refusedCount} domain query(ies) returned an unrecognised answer on a list whose ` +
        `controls had passed, which usually means rate limiting part way through the run. ` +
        `Those domains are neither confirmed listed nor confirmed clean.`,
    )
  }

  if (v.incomplete) {
    parts.push('The run did not finish cleanly, so every count above is a floor, not a total.')
  }

  if (parts.length === 0) {
    return (
      `No listings. Checked ${scope}, and each of those lists was proved in this same run to ` +
      `return a listing for its own test point and nothing for a known-clean domain.`
    )
  }

  return `${parts.join(' ')} Checked ${scope}.`
}

/**
 * The findings half of the sentence, without the scope clause.
 *
 * Exists so the no-sending-domains branch above can still report a listing it found on a
 * brand domain. Before this split, an empty sending list returned early and a brand-domain
 * listing discovered in the same run was never mentioned in the detail line.
 */
function describeFindings(v: {
  listings: BlocklistListing[]
  controlFailures: ControlFailure[]
  refusedCount: number
  incomplete: boolean
}): string {
  const parts: string[] = []
  if (v.listings.length > 0) {
    parts.push(`LISTED: ${v.listings.map(l => `${l.domain} on ${l.list} (${l.address})`).join('; ')}.`)
  }
  if (v.controlFailures.length > 0) {
    parts.push(
      `CONTROL FAILURES (${v.controlFailures.length}): ` +
        v.controlFailures.map(c => c.detail).join(' '),
    )
  }
  if (v.refusedCount > 0) {
    parts.push(`${v.refusedCount} domain query(ies) returned an unrecognised answer.`)
  }
  if (v.incomplete) {
    parts.push('The run did not finish cleanly, so every count above is a floor.')
  }
  return parts.length === 0 ? 'No listings.' : parts.join(' ')
}
