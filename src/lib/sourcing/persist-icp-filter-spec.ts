import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  deriveFilterSpec,
  type IcpDocument,
  type ICPFilterSpec,
} from '@/lib/agents/icp-filter-spec'
import { inspectFilterSpec } from '@/lib/sourcing/inspect-filter-spec'
import { deriveBuyerCriterion } from '@/agents/buyer-criterion-agent'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import {
  resolveIcpGeography,
  type ResolvedGeography,
} from '@/lib/sourcing/resolve-icp-geography'

/**
 * Derives and persists the ICP filter spec for a newly promoted strategy document.
 *
 * Loads the document, derives the spec from its ICP content, and updates the
 * strategy_documents row with icp_filter_spec. Non-ICP documents return early.
 * Failures are logged and reported to Sentry but do NOT fail the promotion itself.
 * NULL icp_filter_spec is a safe failure mode: the sourcing orchestrator will fail
 * loudly when it encounters a NULL spec, providing clear operator feedback.
 *
 * Also re-queues the organisation's previously REMOVED prospects for tiering, because
 * a new filter spec is the rule that removed them changing. This is the only thing in
 * the codebase that re-queues them. See ADR-037.
 *
 * Called from:
 *   - POST /api/suggestions/[id]/approve (in after() handler)
 *   - POST /api/cron/auto-approve (after RPC succeeds)
 *
 * Never throws. Always logs. Sentry.flush() called in serverless contexts.
 */
export async function persistIcpFilterSpec(
  supabase: SupabaseClient,
  documentId: string
): Promise<void> {
  const operationId = `persist-icp-spec-${documentId.slice(0, 8)}`

  try {
    // ── 1. Load the newly promoted document ────────────────────────────────────
    const { data: doc, error: fetchError } = await supabase
      .from('strategy_documents')
      .select('id, document_type, content, organisation_id')
      .eq('id', documentId)
      .single()

    if (fetchError || !doc) {
      const msg = fetchError?.message ?? 'Document not found'
      logger.warn('persistIcpFilterSpec: failed to load document', {
        operation_id: operationId,
        document_id: documentId,
        error: msg,
      })
      Sentry.withScope((scope) => {
        scope.setExtra('operation_id', operationId)
        scope.setExtra('document_id', documentId)
        Sentry.captureMessage(
          `persistIcpFilterSpec: could not load document ${documentId}`,
          'warning'
        )
      })
      return
    }

    // ── 2. Return early if not an ICP ──────────────────────────────────────────
    if (doc.document_type !== 'icp') {
      logger.debug('persistIcpFilterSpec: skipping non-ICP document', {
        operation_id: operationId,
        document_type: doc.document_type,
      })
      return
    }

    // ── 3. Derive this client's buyer criterion FIRST ──────────────────────────
    //
    // ORDER IS LOAD-BEARING AND IT CHANGED. The criterion used to be derived after the
    // spec and attached to it. It now runs first, because deriveFilterSpec reads it:
    // `job_titles` and `job_titles_excluded` are the criterion's accept and reject
    // fragments, rather than sixteen literals naming one market's roles.
    //
    // WHO the client emails, as opposed to what we ask the provider to search. Derived
    // from every approved document plus intake, not from the ICP alone: an ICP describes
    // a market, and the positioning document is what says which problem the client solves
    // and therefore who owns it.
    //
    // It rides in the spec, so it is approved with the ICP, regenerates with the ICP, and
    // is thawed by the same re-queue below. No new document and no new approval step.
    //
    // NEVER FAILS THE WRITE, and that is now a LARGER consequence than it was. A spec
    // with no criterion has no job titles either, so it cannot build a people search and
    // the sourcing handler refuses to run on it. That is deliberate: a refusal is
    // recoverable by approving an ICP, and sourcing a default set of titles is not
    // recoverable at all once the emails are sent. The old comment said this client
    // "pays to enrich every approved prospect"; that is still true of the enrichment
    // gate, which still fails open, and sourcing now stops before reaching it.
    let buyerCriterion: BuyerCriterion | null = null
    try {
      buyerCriterion = await deriveBuyerCriterion({
        supabase,
        organisation_id: doc.organisation_id,
      })

      if (buyerCriterion.status !== 'derived') {
        logger.warn('persistIcpFilterSpec: buyer criterion will not gate', {
          operation_id: operationId,
          document_id: documentId,
          organisation_id: doc.organisation_id,
          status: buyerCriterion.status,
          reason:
            buyerCriterion.unsettled_reason ??
            buyerCriterion.sanity?.note ??
            null,
          consequence:
            'Enrichment will run unfiltered for this client until it is resolved. Its ' +
            'title fragments are still used to build the sourcing query.',
        })
      }
    } catch (criterionError) {
      const msg = criterionError instanceof Error ? criterionError.message : String(criterionError)
      logger.error('persistIcpFilterSpec: buyer criterion derivation failed', {
        operation_id: operationId,
        document_id: documentId,
        organisation_id: doc.organisation_id,
        error: msg,
        consequence:
          'The spec is stored WITHOUT a buyer criterion and therefore WITHOUT job titles. ' +
          'Sourcing will refuse to run for this client, and tiering will withhold a tier, ' +
          'until an ICP is re-approved. Both are recoverable; neither spends money.',
      })
      Sentry.captureException(criterionError, {
        tags: { component: 'persistIcpFilterSpec', step: 'buyer_criterion' },
        extra: { operation_id: operationId, document_id: documentId },
      })
    }

    // ── 3.2 Resolve this client's geography, and FAIL CLOSED if it cannot ──────
    //
    // DIFFERENT FAILURE POLICY FROM THE BUYER CRITERION ABOVE, deliberately.
    //
    // A missing buyer criterion fails OPEN: the spec is written without job titles and
    // the sourcing handler refuses it later. That is right for titles, because the cost
    // of being wrong is commercial and the refusal is recoverable.
    //
    // Geography fails CLOSED. A spec with no countries, or with the wrong ones, is a
    // legal exposure rather than a wasted send, and there is no value that could stand in
    // for a missing country list without guessing which markets a client sells to. So the
    // whole write is abandoned and icp_filter_spec stays NULL.
    //
    // NULL IS AN EXISTING, LOUD FAILURE and that is why it is reused rather than a new
    // mechanism being invented: the sourcing orchestrator already refuses to run on a NULL
    // spec with an operator-facing message. Nothing is sourced, nothing is spent, and the
    // document that caused it is named in this log and in Sentry.
    //
    // WHAT THIS DOES NOT DO, per ADR-034: it governs the NEXT spec. Prospects already
    // sourced, enriched or uploaded under the previous spec are untouched, and no code
    // path recalls anything already handed to the sending provider.
    let geography: ResolvedGeography
    try {
      geography = await resolveIcpGeography({ supabase, doc: doc.content as IcpDocument })
    } catch (geoError) {
      const msg = geoError instanceof Error ? geoError.message : String(geoError)
      logger.error('persistIcpFilterSpec: geography could not be resolved', {
        operation_id: operationId,
        document_id: documentId,
        organisation_id: doc.organisation_id,
        error: msg,
        consequence:
          'The filter spec is NOT written and stays NULL. Sourcing will refuse to run for ' +
          'this client until the ICP is fixed and re-approved. This is deliberate: there ' +
          'is no default country list, and a spec written without one would either target ' +
          'nowhere or target somewhere this client never asked for.',
      })
      Sentry.captureException(geoError, {
        tags: { component: 'persistIcpFilterSpec', step: 'geography' },
        extra: {
          operation_id: operationId,
          document_id: documentId,
          organisation_id: doc.organisation_id,
        },
      })
      try {
        await Sentry.flush(2000)
      } catch {}
      return
    }

    // ── 3.25 Derive the filter spec from ICP content ───────────────────────────
    // deriveFilterSpec throws if industries are non-canonical.
    // Catch that explicitly and report the invalid names.
    let spec: ICPFilterSpec
    try {
      spec = deriveFilterSpec(doc.content as IcpDocument, buyerCriterion, geography)
    } catch (specError) {
      const msg = specError instanceof Error ? specError.message : String(specError)
      logger.error('persistIcpFilterSpec: deriveFilterSpec failed (non-canonical industries)', {
        operation_id: operationId,
        document_id: documentId,
        error: msg,
      })
      Sentry.withScope((scope) => {
        scope.setExtra('operation_id', operationId)
        scope.setExtra('document_id', documentId)
        scope.setExtra('error_type', 'non_canonical_industry')
        scope.setContext('icp_content', { content_type: doc.content?.constructor.name })
        Sentry.captureException(specError, {
          extra: {
            operation_id: operationId,
            document_id: documentId,
            error_context: 'deriveFilterSpec validation',
          },
          tags: {
            component: 'persistIcpFilterSpec',
          },
        })
      })
      try {
        await Sentry.flush(2000)
      } catch {}
      return
    }

    if (buyerCriterion) spec.buyer_criterion = buyerCriterion

    // ── 3.5 Inspect the spec we are about to write ─────────────────────────────
    // Report only. A finding here does NOT stop the write: a spec with a flaw is more
    // useful than a NULL one, which fails sourcing outright. This is the earliest point
    // an unclassifiable industry can be named, and naming it at write time is what stops
    // it being discovered later as an unexplained pile of `industry_off_target`.
    const writeFindings = inspectFilterSpec(spec)
    if (writeFindings.length > 0) {
      logger.warn('persistIcpFilterSpec: derived spec has findings', {
        operation_id: operationId,
        document_id: documentId,
        finding_count: writeFindings.length,
        findings: writeFindings,
      })
    }

    // ── 4. Update strategy_documents with the derived spec ──────────────────────
    const { error: updateError } = await supabase
      .from('strategy_documents')
      .update({ icp_filter_spec: spec })
      .eq('id', documentId)

    if (updateError) {
      const msg = updateError.message
      logger.error('persistIcpFilterSpec: failed to update strategy_documents', {
        operation_id: operationId,
        document_id: documentId,
        error: msg,
      })
      Sentry.withScope((scope) => {
        scope.setExtra('operation_id', operationId)
        scope.setExtra('document_id', documentId)
        Sentry.captureMessage(
          `persistIcpFilterSpec: update failed for ${documentId}`,
          'error'
        )
      })
      try {
        await Sentry.flush(2000)
      } catch {}
      return
    }

    logger.info('persistIcpFilterSpec: spec persisted successfully', {
      operation_id: operationId,
      document_id: documentId,
    })

    // ── 5. Put previously removed prospects back in the tiering queue ──────────
    //
    // THE THIRD LAYER ADR-034 SAYS IS MISSING, for this one rule. tierEnrichedBatch
    // skips any prospect that already carries a tiering_reason, which is what stops
    // decided rows eating the batch cap. The cost of that filter is that a removal
    // becomes a FROZEN VERDICT: the rule can change and the rows that the old rule
    // removed never hear about it.
    //
    // A new filter spec IS that rule changing. So the moment a new one is stored,
    // the rows the old one removed are cleared back to unclassified and the next
    // tiering run re-decides them against the spec that is actually in force.
    //
    // THIS NOW ALSO THAWS THE PRE-ENRICHMENT BUYER GATE, with no second column to
    // clear. A prospect that gate rejects carries its verdict in tiering_reason and
    // leaves enrichment_status NULL, so clearing tiering_reason returns it to
    // enrichment eligibility as well as to tiering. That was the design constraint:
    // a half-thaw that freed the reason and left the row unenrichable would look
    // like it had worked.
    //
    // SCOPE, deliberately narrow. Only this organisation, only rows with no tier,
    // only rows that were actually classified. A survivor keeps its tier and is not
    // touched, because re-tiering something already published to a client is a
    // different decision with different consequences.
    //
    // COST, deliberately loud. This is free of API spend at the moment it runs, but
    // it commits the next tiering runs to real work, and each re-tiered survivor
    // goes on to cost research money downstream. At ramp volume one spec change can
    // re-queue four figures of rows. The operator should see that number when they
    // cause it, not infer it later from a bill, so a non-zero re-queue logs at warn.
    //
    // Never throws. A failure here must not fail the promotion, and the filter spec
    // is already stored by this point.
    try {
      const { data: requeued, error: requeueError } = await supabase
        .from('prospects')
        .update({ tiering_reason: null })
        .eq('organisation_id', doc.organisation_id)
        .is('sourced_tier', null)
        .not('tiering_reason', 'is', null)
        .select('id')

      if (requeueError) {
        logger.error('persistIcpFilterSpec: failed to re-queue removed prospects', {
          operation_id: operationId,
          document_id: documentId,
          organisation_id: doc.organisation_id,
          error: requeueError.message,
          consequence:
            'Prospects removed under the PREVIOUS filter spec keep their old verdict and ' +
            'will not be re-tiered against the new one. Nothing else re-queues them.',
        })
      } else {
        const requeuedCount = requeued?.length ?? 0

        if (requeuedCount > 0) {
          logger.warn('persistIcpFilterSpec: removed prospects re-queued for tiering', {
            operation_id: operationId,
            document_id: documentId,
            organisation_id: doc.organisation_id,
            requeued_count: requeuedCount,
          })
        } else {
          logger.info('persistIcpFilterSpec: no removed prospects to re-queue', {
            operation_id: operationId,
            document_id: documentId,
            organisation_id: doc.organisation_id,
          })
        }
      }
    } catch (requeueErr) {
      const msg = requeueErr instanceof Error ? requeueErr.message : String(requeueErr)
      logger.error('persistIcpFilterSpec: re-queue threw', {
        operation_id: operationId,
        document_id: documentId,
        error: msg,
      })
    }
  } catch (err) {
    // Catch-all for unexpected errors.
    // Never let this fail the promotion itself, but capture for visibility.
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('persistIcpFilterSpec: unexpected error', {
      operation_id: operationId,
      document_id: documentId,
      error: msg,
    })
    Sentry.captureException(err, {
      extra: {
        operation_id: operationId,
        document_id: documentId,
      },
      tags: {
        component: 'persistIcpFilterSpec',
      },
    })
    try {
      await Sentry.flush(2000)
    } catch {}
  }
}
