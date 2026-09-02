// The numbers on the pipeline review screen, computed in ONE place.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS MODULE EXISTS
//
// Two reasons, and they are separate defects that happened to share a page.
//
// 1. THE PAGE RENDERED A SNAPSHOT AND NEVER LOOKED AGAIN. Every count came from a React
//    Server Component, which runs once, during the request that produced the HTML. There
//    was no subscription, no interval and no revalidation. Observed seven times in one
//    session, twice on controls that spend money: "Awaiting approval 0" beside 100 pending,
//    a research pool reported as 14 when it was 31, "Nothing to research" while jobs were
//    running normally. Nothing was broken except that nobody asked the database twice.
//
// 2. THE SAME NUMBER WAS COMPUTED IN THREE AND FOUR PLACES. Pending review was counted in
//    the pipeline page, again by a separate query in the approve page, and twice more in
//    the approve component. The tier counts and the removed count each had three homes with
//    the predicate re-typed by hand. That is the shape CLAUDE.md calls parallel arrays: two
//    lists that must agree, kept in step by hand, free to drift silently.
//
// So: one function, called by the server render AND by the poll, so a refresh cannot
// disagree with a first paint, and no second copy of a predicate exists to drift.
//
// ═════════════════════════════════════════════════════════════════════════════
// COUNTED BY THE DATABASE, NOT IN JAVASCRIPT
//
// The old code fetched whole prospect rows and counted them with Array.filter. That is
// wrong in a way that would not have shown up for months: the count is then bounded by
// however many rows PostgREST is willing to return, so past that ceiling the page silently
// under-reports and a truncated batch looks exactly like a small one. At 148 prospects
// platform-wide it had not started biting yet.
//
// These are `head: true` counts. No rows cross the wire at all, the ceiling is irrelevant,
// and the arithmetic is Postgres's. They run in parallel per organisation.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE CLIENT MUST BE SERVICE-ROLE. See ADR-027 and research-verdict.ts: the research
// verdict reads job_queue and system_flags, and both have RLS on with zero policies and no
// authenticated grant.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getResearchVerdict,
  readResearchPath,
  type ResearchVerdict,
} from '@/lib/operator/research-verdict'
import {
  whyNotSendable,
  parseTieringReason,
  readVerificationFailure,
  VERIFICATION_MAX_ATTEMPTS,
  type NotSendableReason,
} from '@/lib/operator/prospect-status'

/**
 * One tier's headline number, and how much of it can actually be emailed.
 *
 * The two are separate fields rather than one because they answer different questions and
 * an operator needs both: total is how many prospects tiering kept, sendable is how many
 * of those a campaign can use. On production 2026-09-02 those were 93 and 73.
 */
export interface TierMetrics {
  total: number
  sendable: number
  /** Why the rest cannot be emailed. Empty when total === sendable. */
  notSendableByReason: Partial<Record<NotSendableReason, number>>
}

/** Verification that failed and, in most cases, has stopped retrying. */
export interface VerificationFailureMetrics {
  count: number
  /** Provider HTTP status to how many prospects hit it. No provider name; see prospect-status.ts. */
  byStatus: Record<string, number>
  /** How many have exhausted their attempts, so nothing will retry them without a nudge. */
  givenUp: number
}

/**
 * One sourcing run, and what became of the prospects it wrote.
 *
 * THE TABLE THE OPERATOR PREVIOUSLY HAD TO ASK SOMEONE TO RUN BY HAND. Every count here is
 * produced by countRow below, the SAME function that produces the organisation-wide
 * figures, walked over a subset of the same rows from the same read. A batch row and the
 * card above it cannot disagree about what "tier 1" or "removed" means, because there is
 * only one place either is decided.
 *
 * The tier totals live ONLY in `tiers`. They are deliberately not repeated as stage
 * counters: a second copy is a second thing to keep in step.
 */
export interface BatchFunnel {
  /** NULL identifies the unattributed group: prospects belonging to no recorded run. */
  sourcing_run_id: string | null
  /** NULL for the unattributed group, which has no run and therefore no times. */
  started_at: string | null
  completed_at: string | null
  status: string | null
  /** How many were asked for. NULL when the run predates the entry point that recorded it. */
  target_batch_size: number | null
  /** How many the vendor returned. NULL for the unattributed group. */
  candidates_returned: number | null
  /** How many were already known, by dedupe verdict. Empty when nothing was dropped. */
  dropped_by_reason: Record<string, number>
  error_message: string | null
  /**
   * True when this run's counts were reconstructed from a prose log line rather than
   * recorded as they happened. Rendered, never hidden: a reconstructed number and a
   * recorded one should not look identical.
   */
  backfilled: boolean

  /** Prospects from this run that still exist. Not the same as what the run wrote. */
  sourced: number
  pending_review: number
  approved: number
  enriched: number
  tiers: Record<'tier_1' | 'tier_2' | 'tier_3', TierMetrics>
  removed: number
  removed_by_reason: Record<string, number>
  verified: number
  eligible: number
  researched: number
  /** Researched AND carrying an opening line. The two differ; see the funnel. */
  personalised: number
  verification_failures: VerificationFailureMetrics
}

export interface PipelineMetrics {
  organisation_id: string
  organisation_name: string
  pending_review_count: number
  approved_unenriched_count: number
  /** Per tier: how many, and how many of those can be emailed. */
  tiers: Record<'tier_1' | 'tier_2' | 'tier_3', TierMetrics>
  /**
   * Enriched but not yet tiered.
   *
   * NOT RENDERED ANYWHERE. It was already unused when this moved here and it is carried
   * across unchanged rather than quietly dropped, because deleting a field is a decision
   * and this commit is about where numbers are computed, not which ones exist.
   */
  enriched_untiered_count: number
  /** Enriched, then removed by a tiering disqualifier. Not the same as not-yet-tiered. */
  removed_count: number
  /**
   * Which disqualifier removed them, keyed by the canonical code. Glossed at the point of
   * render, never here: the codes stay canonical in the payload.
   */
  removed_by_reason: Record<string, number>
  /** Verification that failed. Previously visible nowhere in the product. */
  verification_failures: VerificationFailureMetrics
  /**
   * True when the status read below hit its ceiling, so the breakdowns are of a SAMPLE.
   *
   * Declared rather than left to be inferred. A truncated breakdown that does not say it is
   * truncated is the silent-failure shape this file's header is about, one level down: the
   * headline counts would be right and the explanation of them quietly incomplete.
   */
  breakdowns_truncated: boolean
  /** What the research control would do if clicked. See research-verdict.ts. */
  research: ResearchVerdict

  /**
   * One line per sourcing run, newest first.
   *
   * Every count in here comes from countRow, the same function that produced the
   * organisation-wide figures above, so a batch line and a card cannot mean different
   * things by "tier 1".
   */
  batches: BatchFunnel[]
  /**
   * Prospects belonging to no recorded run. NULL when there are none.
   *
   * Shown, never hidden. 19 exist platform-wide: 12 in an organisation archived before run
   * logging existed and 7 test fixtures. If the batch lines and the cards ever fail to
   * reconcile, this is the first thing that explains the gap, and the screen says so
   * rather than leaving the operator to find it.
   */
  unattributed: BatchFunnel | null
}

/**
 * Ceiling on the per-organisation status read.
 *
 * The headline counts are head-only SQL counts and are not bounded by this. Only the
 * BREAKDOWNS are, because deriving them needs the verification verdict, which is a
 * TypeScript policy rather than a column. When the ceiling is reached the payload says so.
 */
export const STATUS_ROW_LIMIT = 2000

/**
 * How many prospects one page of the approval table shows.
 *
 * LIVES HERE, NOT IN THE PAGE THAT USES IT. Next.js validates a page module's exports and
 * rejects any name that is not one of its own recognised fields, so `export const
 * APPROVAL_PAGE_SIZE` inside approve/page.tsx fails the production build with
 * "is not a valid Page export field". `npx tsc --noEmit` passes on it, because that rule is
 * Next's rather than TypeScript's. This is the case CLAUDE.md keeps a local production
 * build in the receipts for.
 */
export const APPROVAL_PAGE_SIZE = 50

/**
 * The columns the breakdowns are derived from. One read, every answer.
 *
 * personalisation_trigger IS READ BUT NEVER RETURNED. It holds the prospect-specific
 * opening line, and this payload is polled every thirty seconds into a browser. Only
 * whether it is null survives the walk below, as a count. That is the same treatment
 * last_verification_error already gets for the same kind of reason: read it server-side,
 * reduce it to the fact you need, never put the value in the payload.
 */
const STATUS_COLUMNS =
  'sourcing_run_id, sourcing_review_status, ' +
  'sourced_tier, tiering_reason, enrichment_status, email_send_eligible, ' +
  'email_send_ineligible_reason, independent_verified_at, independent_email_status, ' +
  'verification_provider, second_pass_status, second_pass_provider, ' +
  'last_verification_error, verification_attempt_count, ' +
  'research_ran_at, personalisation_trigger'

interface StatusRow {
  sourcing_run_id: string | null
  sourcing_review_status: string | null
  research_ran_at: string | null
  personalisation_trigger: string | null
  sourced_tier: string | null
  tiering_reason: string | null
  enrichment_status: string | null
  email_send_eligible: boolean | null
  email_send_ineligible_reason: string | null
  independent_verified_at: string | null
  independent_email_status: string | null
  verification_provider: string | null
  second_pass_status: string | null
  second_pass_provider: string | null
  last_verification_error: string | null
  verification_attempt_count: number | null
}

function emptyTier(): TierMetrics {
  return { total: 0, sendable: 0, notSendableByReason: {} }
}

const TIER_KEYS = ['tier_1', 'tier_2', 'tier_3'] as const
type TierKey = (typeof TIER_KEYS)[number]

/** An empty funnel, with no run attached. Run detail is filled in by the caller. */
function emptyFunnel(sourcing_run_id: string | null): BatchFunnel {
  return {
    sourcing_run_id,
    started_at: null,
    completed_at: null,
    status: null,
    target_batch_size: null,
    candidates_returned: null,
    dropped_by_reason: {},
    error_message: null,
    backfilled: false,
    sourced: 0,
    pending_review: 0,
    approved: 0,
    enriched: 0,
    // Derived from TIER_KEYS, never a hand-written literal. See the `as` warning in
    // CLAUDE.md: an incomplete literal cast to a Record is what hid a missing job type
    // until thirty tests failed at once.
    tiers: Object.fromEntries(TIER_KEYS.map(k => [k, emptyTier()])) as Record<TierKey, TierMetrics>,
    removed: 0,
    removed_by_reason: {},
    verified: 0,
    eligible: 0,
    researched: 0,
    personalised: 0,
    verification_failures: { count: 0, byStatus: {}, givenUp: 0 },
  }
}

/**
 * Fold ONE prospect into ONE funnel.
 *
 * THIS IS THE ONLY PLACE ANY OF THESE NUMBERS IS DECIDED. It is called once per row for
 * the organisation total and once per row for that row's batch, so "tier 1" on a card and
 * "tier 1" on a batch line are the same predicate by construction rather than by two
 * people writing the same condition twice. That was the defect this module was created to
 * end, one level down: the counts stopped being computed in four places and the BATCH
 * counts were about to reintroduce it.
 */
function countRow(f: BatchFunnel, row: StatusRow): void {
  f.sourced += 1

  if (row.sourcing_review_status === 'pending_review') f.pending_review += 1
  if (row.sourcing_review_status === 'approved') f.approved += 1
  if (row.enrichment_status === 'enriched') f.enriched += 1

  const tierKey = TIER_KEYS.find(k => k === row.sourced_tier)
  if (tierKey) {
    const tier = f.tiers[tierKey]
    tier.total += 1
    const reason = whyNotSendable(row)
    if (reason === null) tier.sendable += 1
    else tier.notSendableByReason[reason] = (tier.notSendableByReason[reason] ?? 0) + 1
  } else if (row.enrichment_status === 'enriched' && row.tiering_reason !== null) {
    // Removed by a disqualifier, as opposed to not yet tiered. Both have sourced_tier NULL;
    // tiering_reason is the discriminator. parseTieringReason keeps an unrecognised value
    // visible under its own text rather than dropping it; the live data has one such
    // legacy code.
    f.removed += 1
    const verdict = parseTieringReason(row.tiering_reason)
    const code =
      verdict.kind === 'disqualified' ? verdict.code
      : verdict.kind === 'unrecognised' ? verdict.raw
      : row.tiering_reason
    f.removed_by_reason[code] = (f.removed_by_reason[code] ?? 0) + 1
  }

  if (row.independent_verified_at !== null) f.verified += 1
  if (row.email_send_eligible === true) f.eligible += 1
  if (row.research_ran_at !== null) f.researched += 1
  // The VALUE never leaves this function; only whether there is one. See STATUS_COLUMNS.
  if (row.personalisation_trigger !== null) f.personalised += 1

  const failure = readVerificationFailure(
    row.last_verification_error,
    row.verification_attempt_count,
    VERIFICATION_MAX_ATTEMPTS,
  )
  if (failure) {
    const v = f.verification_failures
    v.count += 1
    if (failure.givenUp) v.givenUp += 1
    const key = failure.status === null ? 'unknown' : String(failure.status)
    v.byStatus[key] = (v.byStatus[key] ?? 0) + 1
  }
}

/**
 * The organisation total and every batch, from ONE read and ONE counter.
 *
 * The run detail (times, target, dropped reasons) comes from a second small read of
 * sourcing_runs, because a run that wrote prospects which were later DELETED has no rows
 * left to be found by, and a run list built only from prospects would silently omit it.
 * Three such runs exist: they recorded 25 written each and have nothing present.
 */
async function readBreakdowns(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<{
  overall: BatchFunnel
  batches: BatchFunnel[]
  unattributed: BatchFunnel | null
  truncated: boolean
}> {
  const [{ data, error }, runsResult] = await Promise.all([
    supabase
      .from('prospects')
      .select(STATUS_COLUMNS)
      .eq('organisation_id', organisationId)
      .limit(STATUS_ROW_LIMIT),
    supabase
      .from('sourcing_runs')
      .select('id, started_at, completed_at, status, target_batch_size, ' +
              'candidates_returned, dropped_by_reason, error_message, backfilled_at')
      .eq('organisation_id', organisationId)
      .order('started_at', { ascending: false }),
  ])

  if (error) {
    throw new Error(`Could not read prospect status for ${organisationId}: ${error.message}`)
  }
  if (runsResult.error) {
    throw new Error(`Could not read sourcing runs for ${organisationId}: ${runsResult.error.message}`)
  }

  const rows = (data ?? []) as unknown as StatusRow[]
  // `as unknown as` for the same reason the row cast above needs it: this module takes an
  // untyped SupabaseClient, so PostgREST's select() widens to GenericStringError. The cast
  // asserts the SHAPE OF A QUERY RESULT, not the completeness of a literal, so it is not
  // the load-bearing-in-the-wrong-direction case CLAUDE.md warns about. The column list is
  // three lines above it.
  const runs = (runsResult.data ?? []) as unknown as Array<{
    id: string
    started_at: string
    completed_at: string | null
    status: string
    target_batch_size: number | null
    candidates_returned: number | null
    dropped_by_reason: Record<string, number> | null
    error_message: string | null
    backfilled_at: string | null
  }>

  const overall = emptyFunnel(null)

  // Seeded from the RUNS, not from the prospects. A run whose prospects were all deleted
  // still gets a line, reading written-then-nothing-present, because a run that vanishes
  // from the list is indistinguishable from a run that never happened.
  const byRun = new Map<string, BatchFunnel>()
  for (const run of runs) {
    const f = emptyFunnel(run.id)
    f.started_at = run.started_at
    f.completed_at = run.completed_at
    f.status = run.status
    f.target_batch_size = run.target_batch_size
    f.candidates_returned = run.candidates_returned
    f.dropped_by_reason = run.dropped_by_reason ?? {}
    f.error_message = run.error_message
    f.backfilled = run.backfilled_at !== null
    byRun.set(run.id, f)
  }

  let unattributed: BatchFunnel | null = null

  for (const row of rows) {
    countRow(overall, row)

    const runId = row.sourcing_run_id
    if (runId === null) {
      // NEVER SILENTLY DROPPED. A prospect belonging to no recorded run is a real state,
      // and a total that quietly omits it is the defect this whole change exists to remove.
      unattributed ??= emptyFunnel(null)
      countRow(unattributed, row)
      continue
    }

    // A prospect pointing at a run this organisation does not have should be impossible:
    // the foreign key is ON DELETE RESTRICT and the read above is scoped to the same
    // organisation. If it ever happens, it lands in the unattributed group rather than
    // being dropped on the floor.
    const funnel = byRun.get(runId)
    if (funnel) countRow(funnel, row)
    else {
      unattributed ??= emptyFunnel(null)
      countRow(unattributed, row)
    }
  }

  return {
    overall,
    batches: runs.map(r => byRun.get(r.id)!),
    unattributed,
    truncated: rows.length >= STATUS_ROW_LIMIT,
  }
}

/** One `head: true` count against prospects, scoped to an organisation. */
async function countProspects(
  supabase: SupabaseClient,
  organisationId: string,
  shape: (q: any) => any,
): Promise<number> {
  const base = supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', organisationId)

  const { count, error } = await shape(base)

  // FAIL LOUD. A count that returns 0 on error is the exact failure this module exists to
  // remove: "Awaiting approval 0" beside 100 pending rows is indistinguishable from an
  // empty queue, and an operator reads it as work being finished.
  if (error) {
    throw new Error(`Could not count prospects for ${organisationId}: ${error.message}`)
  }
  return count ?? 0
}

/** Every number the pipeline review screen renders, for every active organisation. */
export async function getSourcingMetrics(supabase: SupabaseClient): Promise<PipelineMetrics[]> {
  const { data: orgs, error } = await supabase
    .from('organisations')
    .select('id, name')
    .is('archived_at', null)
    .order('name')

  if (error) throw new Error(`Could not read organisations: ${error.message}`)
  if (!orgs || orgs.length === 0) return []

  return getMetricsForOrganisations(supabase, orgs as Array<{ id: string; name: string }>)
}

/**
 * The same numbers, for an explicit list of organisations.
 *
 * Split out from getSourcingMetrics because the caller that knows WHICH organisations it
 * wants should not have to re-resolve them, and because a test needs to scope itself to the
 * organisation it created rather than to every row in a shared fixture database.
 */
export async function getMetricsForOrganisations(
  supabase: SupabaseClient,
  orgs: Array<{ id: string; name: string }>,
): Promise<PipelineMetrics[]> {
  if (orgs.length === 0) return []

  // ONCE PER REQUEST, NOT ONCE PER ORGANISATION. The queue flags are global, and reading
  // them inside the loop below asked the same question up to three times per client for
  // three identical answers.
  const pathState = await readResearchPath(supabase)

  return Promise.all(
    orgs.map(async (org): Promise<PipelineMetrics> => {
      const [
        pendingReview,
        approvedUnenriched,
        enrichedUntiered,
        removed,
        breakdowns,
        research,
      ] = await Promise.all([
        countProspects(supabase, org.id, q => q.eq('sourcing_review_status', 'pending_review')),
        countProspects(supabase, org.id, q =>
          q.eq('sourcing_review_status', 'approved').is('enrichment_status', null)),
        countProspects(supabase, org.id, q =>
          q.eq('enrichment_status', 'enriched').is('sourced_tier', null)),
        // Removed by the tiering disqualifiers, as opposed to not yet tiered. Both have
        // sourced_tier NULL; tiering_reason is the discriminator, because classifyTier
        // writes one on every path and nothing else sets it. See tier-verdict.ts.
        countProspects(supabase, org.id, q =>
          q.eq('enrichment_status', 'enriched')
            .is('sourced_tier', null)
            .not('tiering_reason', 'is', null)),
        readBreakdowns(supabase, org.id),
        getResearchVerdict(supabase, org.id, 'unresearched', pathState),
      ])

      return {
        organisation_id: org.id,
        organisation_name: org.name,
        pending_review_count: pendingReview,
        approved_unenriched_count: approvedUnenriched,
        // From the SAME walk that produced every batch line below, so the cards are the
        // sum of the lines by construction rather than by a second query agreeing.
        tiers: breakdowns.overall.tiers,
        enriched_untiered_count: enrichedUntiered,
        removed_count: removed,
        removed_by_reason: breakdowns.overall.removed_by_reason,
        verification_failures: breakdowns.overall.verification_failures,
        breakdowns_truncated: breakdowns.truncated,
        research,
        batches: breakdowns.batches,
        unattributed: breakdowns.unattributed,
      }
    }),
  )
}
