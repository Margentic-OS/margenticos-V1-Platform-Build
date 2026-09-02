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
}

/**
 * Ceiling on the per-organisation status read.
 *
 * The headline counts are head-only SQL counts and are not bounded by this. Only the
 * BREAKDOWNS are, because deriving them needs the verification verdict, which is a
 * TypeScript policy rather than a column. When the ceiling is reached the payload says so.
 */
export const STATUS_ROW_LIMIT = 2000

/** The columns the breakdowns are derived from. One read, three answers. */
const STATUS_COLUMNS =
  'sourced_tier, tiering_reason, enrichment_status, email_send_eligible, ' +
  'email_send_ineligible_reason, independent_verified_at, independent_email_status, ' +
  'verification_provider, second_pass_status, second_pass_provider, ' +
  'last_verification_error, verification_attempt_count'

interface StatusRow {
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

/**
 * Sendability, removal reasons and verification failures, from one read.
 *
 * The three tiers are built from a DERIVED list rather than a literal, so a fourth tier
 * cannot be added upstream and silently have no slot here. See the `as` warning in
 * CLAUDE.md: a hand-written literal cast to a Record is exactly the shape that hid a
 * missing job type until thirty tests failed at once.
 */
async function readBreakdowns(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<{
  tiers: Record<'tier_1' | 'tier_2' | 'tier_3', TierMetrics>
  removedByReason: Record<string, number>
  verificationFailures: VerificationFailureMetrics
  truncated: boolean
}> {
  const TIER_KEYS = ['tier_1', 'tier_2', 'tier_3'] as const

  const { data, error } = await supabase
    .from('prospects')
    .select(STATUS_COLUMNS)
    .eq('organisation_id', organisationId)
    .limit(STATUS_ROW_LIMIT)

  if (error) {
    throw new Error(`Could not read prospect status for ${organisationId}: ${error.message}`)
  }

  const rows = (data ?? []) as unknown as StatusRow[]

  const tiers = Object.fromEntries(
    TIER_KEYS.map(key => [key, emptyTier()]),
  ) as Record<(typeof TIER_KEYS)[number], TierMetrics>

  const removedByReason: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let failureCount = 0
  let givenUp = 0

  for (const row of rows) {
    const tierKey = TIER_KEYS.find(k => k === row.sourced_tier)
    if (tierKey) {
      const tier = tiers[tierKey]
      tier.total += 1
      const reason = whyNotSendable(row)
      if (reason === null) tier.sendable += 1
      else tier.notSendableByReason[reason] = (tier.notSendableByReason[reason] ?? 0) + 1
    } else if (row.enrichment_status === 'enriched' && row.tiering_reason !== null) {
      // Removed by a disqualifier. parseTieringReason keeps an unrecognised value visible
      // under its own text rather than dropping it; the live data has one such legacy code.
      const verdict = parseTieringReason(row.tiering_reason)
      const code =
        verdict.kind === 'disqualified' ? verdict.code
        : verdict.kind === 'unrecognised' ? verdict.raw
        : row.tiering_reason
      removedByReason[code] = (removedByReason[code] ?? 0) + 1
    }

    const failure = readVerificationFailure(
      row.last_verification_error,
      row.verification_attempt_count,
      VERIFICATION_MAX_ATTEMPTS,
    )
    if (failure) {
      failureCount += 1
      if (failure.givenUp) givenUp += 1
      const key = failure.status === null ? 'unknown' : String(failure.status)
      byStatus[key] = (byStatus[key] ?? 0) + 1
    }
  }

  return {
    tiers,
    removedByReason,
    verificationFailures: { count: failureCount, byStatus, givenUp },
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
        tiers: breakdowns.tiers,
        enriched_untiered_count: enrichedUntiered,
        removed_count: removed,
        removed_by_reason: breakdowns.removedByReason,
        verification_failures: breakdowns.verificationFailures,
        breakdowns_truncated: breakdowns.truncated,
        research,
      }
    }),
  )
}
