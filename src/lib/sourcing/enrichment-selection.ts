// What makes a prospect eligible for enrichment, and the buyer gate that runs before
// we pay for one.
//
// ═════════════════════════════════════════════════════════════════════════════
// ONE DEFINITION OF ELIGIBLE, READ BY BOTH ENRICHMENT PATHS
//
// There are two paths, chosen by system_flags.queue_enrich, and they used to carry
// two copies of the same four predicates with a comment on one asking the next person
// to keep them in step. That is the parallel-array shape CLAUDE.md warns about: the
// copies drift, nothing errors, and flipping the flag quietly changes WHICH prospects
// get enriched rather than only HOW.
//
// applyEnrichmentEligibility is now the only place those predicates are written.
//
// THE LOCK CLAUSE IS NOT IN HERE, DELIBERATELY. The inline path holds a lock in the
// enrichment_locked_at column; the queue path uses the queue itself as the lock, since
// job_queue's partial unique index already guarantees one live job per prospect.
// Giving both paths a column lock would give one prospect two competing notions of
// "in progress" that can disagree. So the inline path adds its own .or() clause after
// calling this, and that difference is intended.

import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  evaluateBuyerCriterion,
  type BuyerCriterion,
} from '@/lib/sourcing/buyer-criterion'
import type { RemovalReason } from '@/lib/sourcing/tier-classification'

/**
 * Start the query for enrichment-eligible prospects, with every eligibility predicate
 * already applied. The caller chains whatever else it needs and awaits it.
 *
 *   organisation_id                          agent isolation, level 2
 *   sourcing_review_status = 'approved'      the operator approved this prospect
 *   enrichment_status IS NULL                no enrichment verdict has been reached
 *   enrichment_credit_consumed_at IS NULL    we have never paid for this person
 *   tiering_reason IS NULL                   no classification verdict has been reached
 *
 * THE FIFTH IS WHAT STOPS THE RETRY LOOP. A prospect the buyer gate rejects keeps
 * enrichment_status NULL, because nothing was enriched and writing a verdict into a
 * column that means "we paid and this is what we got" would be a lie that also feeds
 * unenriched rows to verification, which selects on that exact value. tiering_reason is
 * what carries the rejection, and excluding it here is what stops the next run selecting
 * the same prospect forever.
 *
 * It also makes the thaw work by itself. persistIcpFilterSpec clears tiering_reason for
 * an organisation's removed prospects whenever a new filter spec is stored (ADR-037),
 * and that single UPDATE now returns gate-rejected prospects to enrichment eligibility
 * as well. There is no second column to remember to clear, so there is no half-thaw
 * where the reason is freed and the row stays unenrichable.
 *
 * BUILT FROM THE CLIENT RATHER THAN TAKING A BUILDER. Passing a part-built query into a
 * helper meant type-checking Supabase's deeply generic builder against a hand-written
 * interface, which the compiler refused with TS2589. Starting the query here keeps the
 * whole chain inferred, so the caller's `.or()` and `.limit()` stay typed.
 */
export function selectEnrichmentEligible(supabase: SupabaseClient, organisationId: string) {
  return supabase
    .from('prospects')
    .select('id, source_person_key, job_title')
    .eq('organisation_id', organisationId)
    .eq('sourcing_review_status', 'approved')
    .is('enrichment_status', null)
    .is('enrichment_credit_consumed_at', null)
    .is('tiering_reason', null)
}

export interface SelectedProspect {
  id: string
  source_person_key: string
  job_title: string | null
}

export interface BuyerGateResult {
  /** Prospects that may be enriched. */
  passed: SelectedProspect[]
  /** Prospects rejected by the client's buyer criterion, before any spend. */
  rejected: SelectedProspect[]
  /**
   * Operator-facing text when the gate did NOT run. Null when it did.
   * The caller puts this in its HTTP response so the warning reaches the person who
   * clicked the button, not only a log stream nobody is watching.
   */
  warning: string | null
}

/**
 * Load one organisation's buyer criterion from its active ICP filter spec.
 *
 * Returns null when there is no spec, no criterion, or the read fails. Every one of
 * those is "we do not have a criterion", and the gate fails open on all of them.
 */
export async function loadBuyerCriterion(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<BuyerCriterion | null> {
  // NEVER THROWS, and the try/catch is the load-bearing part rather than defensive
  // habit. Everything about this gate is designed to fail OPEN, but an exception escaping
  // here would propagate into the enrichment run and abort the whole batch, which is
  // failing CLOSED by accident in the one path that must not. Returning null is what
  // makes "the criterion could not be read" reach the same warn-and-continue branch as
  // "there is no criterion".
  try {
    const { data, error } = await supabase
      .from('strategy_documents')
      .select('icp_filter_spec')
      .eq('organisation_id', organisationId) // explicit isolation filter
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .not('icp_filter_spec', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      logger.warn('buyer-gate: could not read filter spec', {
        organisation_id: organisationId,
        error: error.message,
      })
      return null
    }

    const spec = data?.icp_filter_spec as { buyer_criterion?: BuyerCriterion } | null
    return spec?.buyer_criterion ?? null
  } catch (err) {
    logger.warn('buyer-gate: filter spec read threw', {
      organisation_id: organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Apply the client's buyer criterion to selected prospects BEFORE any enrichment spend,
 * and record a real verdict for the ones it rejects.
 *
 * A rejected prospect gets exactly what every other rejection gets: sourced_tier stays
 * NULL and tiering_reason carries a REMOVAL_REASONS code. It therefore appears in the
 * operator's Removed list and in removed_by_reason under the same bucket as the same
 * rejection arriving after enrichment, which is the point: the rule did not change, only
 * when it runs.
 *
 * FAILS OPEN. With no usable criterion every prospect passes and a warning is returned
 * and raised. Failing closed would stop a client's pipeline with no error anyone would
 * think to look for.
 */
export async function gateProspectsBeforeEnrichment(
  supabase: SupabaseClient,
  organisationId: string,
  prospects: SelectedProspect[],
): Promise<BuyerGateResult> {
  if (prospects.length === 0) {
    return { passed: [], rejected: [], warning: null }
  }

  const criterion = await loadBuyerCriterion(supabase, organisationId)

  // ── Fail open, loudly ─────────────────────────────────────────────────────
  const probe = evaluateBuyerCriterion(criterion, 'x')
  if (probe.decision === 'no_criterion') {
    const why =
      probe.why === 'absent'
        ? 'this client has no buyer criterion yet'
        : probe.why === 'unsettled'
          ? 'this client\'s documents do not settle who the buyer is'
          : 'this client\'s buyer criterion is outside the sanity band and has not been applied'

    const warning =
      `Enriching every approved prospect without a buyer check, because ${why}. ` +
      `${prospects.length} prospect(s) will be enriched unfiltered. ` +
      'Approving a new ICP re-derives the criterion.'

    logger.warn('buyer-gate: no criterion, failing open', {
      organisation_id: organisationId,
      reason: probe.why,
      prospects_passed_unfiltered: prospects.length,
    })

    // The operator alerting channel, not only the log stream.
    Sentry.withScope(scope => {
      scope.setLevel('warning')
      scope.setTag('component', 'buyer-gate')
      scope.setExtra('organisation_id', organisationId)
      scope.setExtra('reason', probe.why)
      scope.setExtra('prospects_passed_unfiltered', prospects.length)
      Sentry.captureMessage(
        `buyer-gate: enrichment ran with no buyer criterion (${probe.why})`,
        'warning',
      )
    })

    return { passed: prospects, rejected: [], warning }
  }

  const passed: SelectedProspect[] = []
  const rejected: SelectedProspect[] = []

  for (const prospect of prospects) {
    const verdict = evaluateBuyerCriterion(criterion, prospect.job_title)
    // A missing title is not judged here. It has its own rule, and guessing from an
    // absent title is how a gate starts rejecting people for the wrong reason.
    if (verdict.decision === 'reject') rejected.push(prospect)
    else passed.push(prospect)
  }

  if (rejected.length > 0) {
    const { error } = await supabase
      .from('prospects')
      .update({ tiering_reason: 'not_decision_maker' satisfies RemovalReason })
      .in('id', rejected.map(p => p.id))
      .eq('organisation_id', organisationId) // isolation, on the write as well as the read

    if (error) {
      // The verdict did not persist, so these prospects would be selected again next
      // run. Passing them through unenriched would be worse: they would look decided
      // and never be enriched OR rejected. So the run continues with the survivors and
      // the failure is loud.
      logger.error('buyer-gate: failed to record rejections', {
        organisation_id: organisationId,
        rejected_count: rejected.length,
        error: error.message,
        consequence:
          'These prospects keep no verdict and will be re-selected on the next run. ' +
          'They were NOT enriched, so no credit was spent.',
      })
      Sentry.captureMessage('buyer-gate: rejection write failed', 'error')
    }
  }

  logger.info('buyer-gate: applied before enrichment', {
    organisation_id: organisationId,
    considered: prospects.length,
    passed: passed.length,
    rejected_before_spend: rejected.length,
  })

  return { passed, rejected, warning: null }
}
