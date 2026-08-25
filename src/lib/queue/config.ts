// Per-job-type queue sizing.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THESE NUMBERS AND NOT OTHERS
//
// Every value here is derived from a MEASURED limit, not from a guess. Where a
// measurement is stale, the comment says how to re-take it.
//
// THE BINDING CONSTRAINT IS APIFY, NOT ANTHROPIC. This is worth stating loudly
// because the natural assumption is the opposite.
//
// Measured live 2026-08-24 from Anthropic response headers, identical across
// claude-haiku-4-5-20251001, claude-opus-4-6 and claude-sonnet-4-6:
//
//     anthropic-ratelimit-requests-limit       10000   per minute
//     anthropic-ratelimit-input-tokens-limit   10000000 per minute
//     anthropic-ratelimit-output-tokens-limit  2000000  per minute
//
// That is about 166 requests per second. Research makes roughly three Anthropic calls
// per prospect and composition makes one. Anthropic cannot be the bottleneck at any
// volume this platform will reach, so there is no request-rate governor here.
//
// Measured live 2026-08-24 from GET https://api.apify.com/v2/users/me/limits:
//
//     maxConcurrentActorJobs            25
//     maxMonthlyUsageUsd                10      (FREE plan, $5 included credit)
//     maxMonthlyActorComputeUnits       625
//
// The LinkedIn source runs ONE actor per prospect since 2026-08-25 (it ran two until the
// profile scraper was dropped), so concurrent research prospects must stay at or under 25
// to respect the 25-run ceiling. That is the real dial, and
// it is a CONCURRENCY cap rather than a request rate, because what Apify limits is
// simultaneous runs and monthly dollars. A token bucket would govern neither.
//
// Apollo is limited to 600 calls/hour and bills one credit per contact. bulk_match
// takes ten people per call, which is why ENRICH claims ten at a time.

import type { JobType } from './types'

export interface JobTypeConfig {
  /**
   * How long a claim is held before it can be reclaimed.
   *
   * Sized as (worst observed job duration + margin). Too short and a live worker's job
   * is stolen while it is still running, which double-spends. Too long and a dead
   * worker's job sits unavailable for that whole period. Erring long is the safe
   * direction: a stranded job is a delay, a stolen job is a duplicate charge.
   */
  leaseSeconds: number

  /**
   * Worst-case seconds for ONE job of this type, used by the worker's deadline budget
   * to decide whether another job can still be started before the 300s wall.
   */
  worstCaseSeconds: number

  /**
   * How many JOB ROWS one claim call takes from a single organisation.
   *
   * For ENRICH this is also the Apollo bulk_match page size: ten people per HTTP call.
   * For the other two it is the per-organisation slice that keeps one client's large
   * batch from starving another's small one.
   */
  claimBatchSize: number

  /**
   * Global ceiling on jobs of this type in the 'claimed' state at once, across every
   * worker invocation and every organisation.
   *
   * ── DENOMINATED IN JOB ROWS. NOT IN BATCHES. NOT IN API CALLS. ──
   *
   * This unit is load-bearing and it was wrong once. maxInFlight was originally set to
   * 3 for enrich meaning "three Apollo batches", with a comment claiming that was 30
   * contacts. But the only consumer, countInFlight in job-queue.ts, counts ROWS in
   * state='claimed'. So headroom was 3 rows, planClaims returned min(10, 3, depth) = 3,
   * and every Apollo call carried three contacts instead of ten. The ten-per-call
   * batching that claim_jobs' p_limit exists for never once happened.
   *
   * Every consumer must agree on this unit:
   *   countInFlight()      counts rows in state='claimed'          -> rows
   *   inFlightHeadroom()   maxInFlight - countInFlight             -> rows
   *   planClaims()         caps each slice by that headroom        -> rows
   *   claim_jobs p_limit   number of rows the UPDATE takes         -> rows
   *
   * To express "N concurrent API calls" for a batching job type, write
   * N * claimBatchSize here and say so.
   */
  maxInFlight: number

  /** Retry cap written onto each new job row. */
  maxAttempts: number
}

export const QUEUE_CONFIG: Record<JobType, JobTypeConfig> = {
  // Apollo bulk_match returns in seconds, so the lease is short and the batch is the
  // API's own page size of ten.
  //
  // maxInFlight 30 ROWS = three concurrent bulk_match calls of ten contacts each. It is
  // written as 3 x claimBatchSize on purpose: the unit is rows, and expressing a
  // call-count requires the multiplication to be visible. Three concurrent calls is
  // trivially inside Apollo's 600/hour ceiling even with every invocation overlapping.
  enrich: {
    leaseSeconds: 120,
    worstCaseSeconds: 60,
    claimBatchSize: 10,
    maxInFlight: 30,
    maxAttempts: 3,
  },

  // The expensive one. 46.8s per prospect of WALL CLOCK at concurrency 5
  // (FRESH_SECONDS_PER_PROSPECT in src/lib/operator/research-batch-entry.ts) means one
  // prospect occupies roughly 156 to 234 seconds of its own time. The lease covers the
  // worst case plus the full 300s invocation, because a worker killed at the wall must
  // not have its jobs stolen by the next tick while its own HTTP calls are still open.
  //
  // maxInFlight 20 ROWS is the Apify ceiling, not a preference. RAISED FROM 10 ON
  // 2026-08-25, when the LinkedIn profile actor was dropped and the per-prospect actor
  // count went from 2 to 1. The arithmetic is the ceiling divided by actors per prospect:
  //   before: 25 concurrent runs / 2 actors = 12, taken as 10 for margin
  //   now:    25 concurrent runs / 1 actor  = 25, taken as 20 for the same margin
  // This number MUST move with src/lib/agents/research/sources/linkedin.ts. If a second
  // actor is ever reinstated, halve it in the same commit or the next batch will exceed
  // Apify's concurrency limit and actor runs will start failing.
  //
  // HOW THE CEILING IS ACTUALLY ENFORCED, because the number only means something with
  // this attached. maxInFlight counts ROWS in state='claimed' across every worker
  // invocation, and invocations overlap: pg_cron fires every minute while a research pass
  // runs for 156 to 234 seconds. Within one invocation perJobExecutor runs its claimed
  // batch through Promise.all, so a slice of 5 is 5 concurrent prospects. The global
  // ceiling is therefore what bounds Apify concurrency, not the slice.
  //
  // WHAT THIS DOES NOT DO. It does not halve wall clock on a small batch. Ramp-up is
  // governed by claimBatchSize (5) and the one-minute tick, so twenty prospects take four
  // ticks to get in flight whatever this is set to. The gain arrives on sustained batches
  // large enough for the in-flight ceiling to be the binding constraint rather than the
  // claim rate.
  //
  // At a slice of 5 into a ceiling of 20, four organisations are now served per pass
  // rather than two, so raising this also bought fairness. The rotation cursor still
  // matters: it is what stops the fifth organisation waiting forever.
  research: {
    leaseSeconds: 360,
    worstCaseSeconds: 240,
    claimBatchSize: 5,
    maxInFlight: 20,
    maxAttempts: 2,
  },

  // One Haiku call per prospect, and only when a dateable signal exists. Cheap, fast,
  // and bounded by nothing external: Anthropic allows 10,000 requests/minute and this
  // draws single digits.
  //
  // claimBatchSize was 25 against a maxInFlight of 20, which is an impossible
  // configuration: the first organisation's slice consumed the entire global ceiling
  // and every other organisation was starved on every single pass. The assertions below
  // now make that shape a startup crash rather than a silent starvation.
  compose: {
    leaseSeconds: 120,
    worstCaseSeconds: 45,
    claimBatchSize: 10,
    maxInFlight: 40,
    maxAttempts: 3,
  },
}

/**
 * Total seconds a worker invocation will spend before it stops claiming NEW work.
 *
 * The platform kills the function at 300s (Hobby maximum, not a configurable default).
 * 20s is held back for the heartbeat insert, the Sentry check-in and its flush(2000), and
 * response serialisation, all of which run AFTER the last job finishes.
 *
 * ── WHY THIS IS 280 AND NOT 240 ──
 *
 * It was 240, mirroring RUNTIME_BUDGET_SECONDS in the inline research entry point. That
 * was wrong, because the two budgets answer different questions. The inline one has to
 * fit a WHOLE BATCH inside one request. This one only has to fit ONE MORE JOB.
 *
 * At 240 the queue could never run research at all. research.worstCaseSeconds is 240, and
 * the claim guard asks `elapsed + worstCase > budget`. Once any time at all had elapsed on
 * the reclaim and the flag reads, 240.3 > 240 was true, so a research job was never
 * claimed. The worker reported ok:true with a green heartbeat and claimed nothing, for
 * ever. A silent, permanent no-op.
 *
 * Caught by a probe before research was ever enabled in production, and now covered by a
 * regression test that claims a research job at the DEFAULT budget rather than an
 * invented one. The original budget tests all passed a deliberately small budget to prove
 * the refusal worked, and never checked that the real budget permits anything.
 */
export const WORKER_BUDGET_SECONDS = 280

/**
 * How far into an invocation a job type must still be startable for its configuration to
 * be usable.
 *
 * A job type whose worst case exactly equals the budget is startable only at elapsed
 * zero, which never happens: the reclaim and the flag reads always consume some time. So
 * "fits" is not enough. It has to fit with room to have got there.
 */
export const MIN_CLAIM_MARGIN_SECONDS = 30

/** How many expired leases one worker invocation will reclaim before doing other work. */
export const RECLAIM_BATCH_SIZE = 100

// ═════════════════════════════════════════════════════════════════════════════
// CONFIG INVARIANTS, ASSERTED AT MODULE LOAD
//
// Both the enrich and the compose bugs were IMPOSSIBLE CONFIGURATIONS that the code
// tolerated silently. Nothing crashed, nothing logged, nothing failed a test. enrich
// quietly sent Apollo batches of three, and compose quietly starved every organisation
// but the first, and both would have kept doing it in production indefinitely.
//
// The lesson is not "check these two numbers". It is that a configuration which cannot
// possibly satisfy the design must be a LOUD failure at startup, not a quiet
// degradation at runtime. These run on import, so an impossible config takes the
// process down on the first request rather than producing a slow queue nobody can
// explain.
//
// Deliberately NOT a test-only check. A test asserts the values committed today; this
// asserts the values actually loaded, including any future edit made in a hurry.

function assertQueueConfig(): void {
  const problems: string[] = []

  for (const [jobType, config] of Object.entries(QUEUE_CONFIG)) {
    const { claimBatchSize, maxInFlight, leaseSeconds, worstCaseSeconds, maxAttempts } = config

    // 1. A slice must exist at all.
    if (claimBatchSize < 1) {
      problems.push(`${jobType}: claimBatchSize ${claimBatchSize} must be at least 1.`)
    }

    // 2. A slice must fit inside the ceiling. Otherwise the first organisation's claim
    //    consumes the entire global headroom and no other organisation is ever served.
    //    This is exactly what compose did with claimBatchSize 25 and maxInFlight 20.
    if (claimBatchSize > maxInFlight) {
      problems.push(
        `${jobType}: claimBatchSize ${claimBatchSize} exceeds maxInFlight ${maxInFlight}. ` +
        'The first organisation would take the whole ceiling and starve every other one. ' +
        'Both are denominated in JOB ROWS.',
      )
    }

    // 3. The ceiling must admit at least two organisations per pass, or per-organisation
    //    fairness is impossible at the configuration level however good the planner is.
    //    enrich failed this with maxInFlight 3 against claimBatchSize 10.
    const orgsPerPass = Math.floor(maxInFlight / Math.max(claimBatchSize, 1))
    if (orgsPerPass < 2) {
      problems.push(
        `${jobType}: maxInFlight ${maxInFlight} over claimBatchSize ${claimBatchSize} admits ` +
        `only ${orgsPerPass} organisation(s) per pass. Fairness needs at least 2. ` +
        'Raise maxInFlight to a multiple of claimBatchSize, or shrink the slice.',
      )
    }

    // 4. A lease shorter than the work steals a LIVE worker's job mid-run, which is how
    //    a lease turns into a double charge.
    if (leaseSeconds <= worstCaseSeconds) {
      problems.push(
        `${jobType}: leaseSeconds ${leaseSeconds} does not exceed worstCaseSeconds ` +
        `${worstCaseSeconds}. A live worker's job would become reclaimable while it runs.`,
      )
    }

    // 5. A job that cannot fit the worker's budget can never be started at all, so it
    //    would sit queued forever with nothing reporting why.
    //
    //    THE MARGIN IS THE POINT, not the comparison. This check used to read
    //    `worstCaseSeconds > WORKER_BUDGET_SECONDS`, which passes at exact equality. That
    //    is precisely the unusable case: the claim guard asks
    //    `elapsed + worstCase > budget`, and elapsed is never zero, so a job type whose
    //    worst case equals the budget is never claimed. research sat at 240 against a
    //    240s budget and would have silently never run.
    if (worstCaseSeconds + MIN_CLAIM_MARGIN_SECONDS > WORKER_BUDGET_SECONDS) {
      problems.push(
        `${jobType}: worstCaseSeconds ${worstCaseSeconds} leaves less than ` +
        `${MIN_CLAIM_MARGIN_SECONDS}s of margin inside the ${WORKER_BUDGET_SECONDS}s worker ` +
        'budget, so a job of this type could only be started in the first instants of an ' +
        'invocation, and in practice never would be.',
      )
    }

    // 6. Zero attempts means a job is claimed and immediately terminal.
    if (maxAttempts < 1) {
      problems.push(`${jobType}: maxAttempts ${maxAttempts} must be at least 1.`)
    }
  }

  // 7. The one externally imposed ceiling. Apify allowed 25 concurrent actor runs when
  //    measured on 2026-08-24, and the LinkedIn source runs APIFY_ACTORS_PER_RESEARCH_PROSPECT
  //    actors per prospect (1 since 2026-08-25, 2 before).
  //    Raising research.maxInFlight without raising the Apify plan buys actor-run
  //    rejections rather than throughput, so it fails here instead.
  const researchActorRuns = QUEUE_CONFIG.research.maxInFlight * APIFY_ACTORS_PER_RESEARCH_PROSPECT
  if (researchActorRuns > APIFY_MAX_CONCURRENT_ACTOR_RUNS) {
    problems.push(
      `research: maxInFlight ${QUEUE_CONFIG.research.maxInFlight} x ` +
      `${APIFY_ACTORS_PER_RESEARCH_PROSPECT} actors = ${researchActorRuns} concurrent Apify ` +
      `actor runs, over the measured ceiling of ${APIFY_MAX_CONCURRENT_ACTOR_RUNS}.`,
    )
  }

  if (problems.length > 0) {
    throw new Error(
      'Impossible queue configuration in src/lib/queue/config.ts:\n  ' + problems.join('\n  '),
    )
  }
}

/** Measured live 2026-08-24 from GET https://api.apify.com/v2/users/me/limits. */
export const APIFY_MAX_CONCURRENT_ACTOR_RUNS = 25

/**
 * The LinkedIn research source starts ONE actor per prospect.
 *
 * Was 2 until 2026-08-25, when harvestapi~linkedin-profile-scraper was dropped for
 * producing 1 candidate in 147, never selected, at twice the price of the posts actor.
 * Halving this is what let research.maxInFlight go from 10 to 20.
 *
 * THIS CONSTANT IS THE GUARD, and it worked: raising maxInFlight first made
 * assertQueueConfig throw at import, because 20 x 2 = 40 exceeds the 25-run ceiling. Keep
 * it honest. If a second actor is ever added back, set this to 2 in the same commit and
 * the assertion will refuse to start until maxInFlight comes back down.
 */
export const APIFY_ACTORS_PER_RESEARCH_PROSPECT = 1

/** Apollo people/bulk_match accepts ten details[] entries per call. */
export const APOLLO_BULK_MATCH_PAGE_SIZE = 10

assertQueueConfig()

export { assertQueueConfig }
