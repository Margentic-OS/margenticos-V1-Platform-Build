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
  domainsChecked: number
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
  const domains = [...new Set(input.domains.map(d => d.trim().toLowerCase()).filter(Boolean))].sort()

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
    listsTotal: lists.length,
    listsTrusted,
    listedCount: listings.length,
    listings,
    controlFailures,
    refusedCount,
    incomplete,
    detail: describe({
      domains,
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

/**
 * The sentence an operator reads on the monitor board.
 *
 * ALWAYS carries the denominators, both of them: how many domains and how many lists.
 * A bare "no listings" is exactly what a sweep that examined nothing also reports, and
 * this codebase has shipped that confusion more than once.
 */
function describe(v: {
  domains: readonly string[]
  lists: ReadonlyArray<Blocklist>
  listsTrusted: number
  listings: BlocklistListing[]
  controlFailures: ControlFailure[]
  refusedCount: number
  incomplete: boolean
}): string {
  const scope =
    `${v.domains.length} sending domain(s) against ${v.listsTrusted} of ${v.lists.length} ` +
    `blocklist(s) whose controls passed`

  if (v.domains.length === 0) {
    return (
      'No sending domains to check, so nothing was queried. This is not a pass: the domain ' +
      'list is derived from recent per-mailbox sending stats, and an empty list means ' +
      'either nothing has sent recently or that sync has stopped.'
    )
  }

  const parts: string[] = []

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
