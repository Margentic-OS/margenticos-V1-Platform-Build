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

export interface PipelineMetrics {
  organisation_id: string
  organisation_name: string
  pending_review_count: number
  approved_unenriched_count: number
  tier_1_count: number
  tier_2_count: number
  tier_3_count: number
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
  /** What the research control would do if clicked. See research-verdict.ts. */
  research: ResearchVerdict
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
        tier1,
        tier2,
        tier3,
        enrichedUntiered,
        removed,
        research,
      ] = await Promise.all([
        countProspects(supabase, org.id, q => q.eq('sourcing_review_status', 'pending_review')),
        countProspects(supabase, org.id, q =>
          q.eq('sourcing_review_status', 'approved').is('enrichment_status', null)),
        countProspects(supabase, org.id, q => q.eq('sourced_tier', 'tier_1')),
        countProspects(supabase, org.id, q => q.eq('sourced_tier', 'tier_2')),
        countProspects(supabase, org.id, q => q.eq('sourced_tier', 'tier_3')),
        countProspects(supabase, org.id, q =>
          q.eq('enrichment_status', 'enriched').is('sourced_tier', null)),
        // Removed by the tiering disqualifiers, as opposed to not yet tiered. Both have
        // sourced_tier NULL; tiering_reason is the discriminator, because classifyTier
        // writes one on every path and nothing else sets it. See tier-verdict.ts.
        countProspects(supabase, org.id, q =>
          q.eq('enrichment_status', 'enriched')
            .is('sourced_tier', null)
            .not('tiering_reason', 'is', null)),
        getResearchVerdict(supabase, org.id, 'unresearched', pathState),
      ])

      return {
        organisation_id: org.id,
        organisation_name: org.name,
        pending_review_count: pendingReview,
        approved_unenriched_count: approvedUnenriched,
        tier_1_count: tier1,
        tier_2_count: tier2,
        tier_3_count: tier3,
        enriched_untiered_count: enrichedUntiered,
        removed_count: removed,
        research,
      }
    }),
  )
}
