// The five client-facing metric reads, and what happens when one of them does not answer.
//
// THE FAILURE THIS GUARDS. postgrest-js converts a refusal, a network failure and a
// timeout alike into { data: null, error }. It never throws. So `?? []` and `?? 0` turned
// all three into the same confident zero, and a client whose campaign is running could be
// shown a dashboard saying nothing had happened, with nothing anywhere recording that a
// read had failed. The numbers still degrade, because a page that renders beats a page
// that does not, but the failure now writes a row.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FAKE IS NOT KEYED BY RELATION, WHICH IS WHAT IT USED TO BE
//
// Reads 2, 4 and 5 ALL query reply_handling_actions. A fake keyed by relation is therefore
// structurally incapable of failing exactly one of them: setting that key fails all three.
// So no test could ever pin a recorded row to one of them alone, and a large share of this
// recorder's coverage was unproven. Deleting ['reply-signals', replySignalsResult] from
// the production loop went entirely unnoticed by this file.
//
// The old file hid that twice over. One test set `byRelation.signals`, a relation nothing
// queries, so it asserted a reply-signals row that nothing could produce. The other failed
// BOTH reply_handling_actions reads and then asserted only `recorded[0]`, so it passed
// while proving less than it appeared to.
//
// WHAT IT KEYS ON INSTEAD: the ORDINAL of the from() call. Every from() gets its own index
// by construction, so two reads cannot share a key however alike they are. Collision is
// not merely unlikely here, it is unexpressible.
//
// The price of an ordinal is that reordering the reads would silently retarget every test
// below. That price is paid by `relation` and `select` in the registry, which are asserted
// against what each query ACTUALLY issued. A read that is reordered, added, removed or
// reshaped fails the shape assertion loudly, rather than quietly changing what every other
// test in this file means.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const recorded: Array<Record<string, unknown>> = []
vi.mock('@/lib/dashboard/record-dashboard-failure', () => ({
  recordDashboardFailure: async (f: Record<string, unknown>) => { recorded.push(f) },
}))

/**
 * THE FIVE READS, IN THE ORDER getClientVisibleCampaignMetrics ISSUES THEM.
 *
 * `label` is the label the production recording loop pairs with each result, and is what
 * ends up in the recorded row's `source`. `relation` and `select` are what that read must
 * actually ask the database for, and are checked against the real query on every test.
 */
const READS = [
  {
    label: 'campaigns',
    relation: 'campaigns',
    // unsubscribed_count is NOT here, and its absence is load-bearing. The provider
    // counts unsubscribe link clicks; the opt-out card counts people who asked us to
    // stop, which is the fifth read below. Putting the column back turns this registry
    // assertion red.
    select: 'contacted_count, sent_count, replied_count, bounced_count',
  },
  {
    label: 'positive-replies',
    relation: 'reply_handling_actions',
    select: '*',
    options: { count: 'exact', head: true },
  },
  {
    label: 'meetings',
    relation: 'meetings',
    select: 'meeting_status',
  },
  {
    label: 'reply-signals',
    relation: 'reply_handling_actions',
    select: 'prospect_id',
  },
  {
    label: 'opt-outs',
    relation: 'reply_handling_actions',
    select: 'prospect_id',
  },
] as const

type ReadResult = { data: unknown; count: number | null; error: { message: string } | null }

/** A read that answered, with nothing in it. The default for every read a test leaves alone. */
const ANSWERED: ReadResult = { data: [], count: 0, error: null }
/** A read that did not answer. postgrest-js shape: data null, count null, error set. */
const refused = (message: string): ReadResult => ({ data: null, count: null, error: { message } })

/** What the chokepoint actually asked for, one entry per from() call, in call order. */
let issued: Array<{ relation: string; select: string }> = []
/** Result per read, addressed by ORDINAL. Anything unset answers healthily. */
let results: ReadResult[] = []

/** One canonical string per read, so registry and reality compare as plain values. */
const shapeOf = (r: { relation: string; select: string; options?: Record<string, unknown> }) =>
  `${r.relation}.select(${r.select}${r.options ? `, ${JSON.stringify(r.options)}` : ''})`

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (relation: string) => {
      // The ordinal. Assigned at from() time, which is synchronous and left-to-right
      // inside the Promise.all array literal, so it is the source order of the reads.
      const index = issued.length
      issued.push({ relation, select: '<select was never called>' })

      const chain: Record<string, unknown> = {}
      // select is RECORDED rather than swallowed. It is what proves this ordinal is the
      // read the test thinks it is.
      chain.select = (columns: string, options?: Record<string, unknown>) => {
        issued[index].select = `${columns}${options ? `, ${JSON.stringify(options)}` : ''}`
        return chain
      }
      for (const m of ['eq', 'in', 'not']) chain[m] = () => chain
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(results[index] ?? ANSWERED).then(onFulfilled)

      return new Proxy(chain, {
        get(t, p: string) {
          if (p in t) return t[p]
          throw new Error(`fake supabase: .${p}() is not implemented and was not honoured`)
        },
      })
    },
  }),
  SupabaseClient: class {},
}))

import { getClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

/** Index of a read by its production label. Throws rather than quietly returning -1. */
function readIndex(label: string): number {
  const i = READS.findIndex(r => r.label === label)
  if (i === -1) throw new Error(`campaign-metrics-failure test: no read labelled '${label}'`)
  return i
}

/**
 * THE REGISTRY CHECKED AGAINST THE WORLD.
 *
 * Every test calls this. Addressing reads by ordinal is only safe while the ordinals still
 * mean what READS says they mean, and this is the assertion that keeps that true. Without
 * it, adding a sixth read or swapping two of them would leave the whole file green while
 * every test silently pointed at the wrong query.
 */
function expectIssuedReadsMatchRegistry() {
  expect(
    issued.map(q => `${q.relation}.select(${q.select})`),
    'the reads this file addresses by ordinal are no longer the reads the chokepoint ' +
    'issues. Update READS, and re-check which test now targets which read.',
  ).toEqual(READS.map(shapeOf))
}

/** All five reads answering with nothing produces exactly this. */
const RENDERABLE_ZEROS = {
  contactedCount: 0,
  sentCount: 0,
  deliveredCount: 0,
  bouncedCount: 0,
  repliedCount: 0,
  peopleRepliedCount: 0,
  peopleOptedOutCount: 0,
  replyRate: null,
  positiveReplyCount: 0,
  meetingsBooked: 0,
  meetingsHeld: 0,
  meetingRate: null,
  hasData: false,
}

beforeEach(() => {
  recorded.length = 0
  issued = []
  results = []
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
})

describe('getClientVisibleCampaignMetrics failure recording', () => {
  it('issues exactly the five reads this file claims to cover', async () => {
    await getClientVisibleCampaignMetrics('org-1')
    expectIssuedReadsMatchRegistry()
    expect(issued, 'five reads, no more and no fewer').toHaveLength(5)
  })

  it('writes nothing when every read answers', async () => {
    await getClientVisibleCampaignMetrics('org-1')
    expectIssuedReadsMatchRegistry()
    expect(recorded).toEqual([])
  })

  // ───────────────────────────────────────────────────────────────────────────
  // ONE TEST PER READ, EACH FAILING THAT READ ALONE.
  //
  // This is the set the old relation-keyed fake could not express, and it is the whole
  // point of the rewrite: deleting any one pair from the production recording loop must
  // turn exactly one of these red. `detail` is asserted as well as `source`, because a
  // label asserted on its own would still pass if the loop paired a label with the WRONG
  // result — which is the other way this recorder can silently lose a read.
  for (const read of READS) {
    it(`records ONLY ${read.label} when only the ${read.label} read fails`, async () => {
      const message = `${read.label} did not answer`
      results[readIndex(read.label)] = refused(message)

      const metrics = await getClientVisibleCampaignMetrics('org-7')

      expectIssuedReadsMatchRegistry()
      expect(
        metrics,
        'the page must still render, whichever read failed',
      ).toEqual(RENDERABLE_ZEROS)
      expect(
        recorded,
        `a refused ${read.label} read wrote no row, or wrote more than its own. The ` +
        'failure reaches no monitor and the client is shown a confident zero instead.',
      ).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        kind: 'read',
        source: `client-visible-campaign-metrics:${read.label}`,
        organisationId: 'org-7',
        route: '/dashboard',
        // Proves the loop paired THIS label with THIS read's result, not another's.
        detail: message,
      })
    })
  }

  it('records EVERY failed read, not just the first', async () => {
    // Five reads run in one Promise.all. Reporting only the first would understate an
    // outage as a single-card problem.
    for (const read of READS) results[readIndex(read.label)] = refused(`${read.label} down`)

    await getClientVisibleCampaignMetrics('org-1')

    expectIssuedReadsMatchRegistry()
    expect(recorded.map(r => r.source).sort()).toEqual(
      READS.map(r => `client-visible-campaign-metrics:${r.label}`).slice().sort(),
    )
  })

  it('scopes EVERY failure row to the organisation that was being read', async () => {
    // Was: failed one relation, which failed two reads, and then asserted recorded[0]
    // only. It passed while leaving most rows unexamined. Every row is checked now, and
    // every read is failed so there is a row per read to check.
    for (const read of READS) results[readIndex(read.label)] = refused(`${read.label} down`)

    await getClientVisibleCampaignMetrics('org-42')

    expect(recorded).toHaveLength(READS.length)
    expect(
      recorded.map(r => r.organisationId),
      'a failure row scoped to the wrong organisation points MON-032 at the wrong client',
    ).toEqual(READS.map(() => 'org-42'))
  })
})
