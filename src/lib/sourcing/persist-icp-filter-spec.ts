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

    // ── 3. Derive the filter spec from ICP content ─────────────────────────────
    // deriveFilterSpec throws if industries are non-canonical.
    // Catch that explicitly and report the invalid names.
    let spec: ICPFilterSpec
    try {
      spec = deriveFilterSpec(doc.content as IcpDocument)
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

    // ── 3.25 Derive this client's buyer criterion ──────────────────────────────
    //
    // WHO the client emails, as opposed to what we ask the provider to search. Derived
    // from every approved document plus intake, not from the ICP alone: an ICP describes
    // a market, and the positioning document is what says which problem the client solves
    // and therefore who owns it.
    //
    // It rides in the spec, so it is approved with the ICP, regenerates with the ICP, and
    // is thawed by the same re-queue below. No new document and no new approval step.
    //
    // NEVER FAILS THE WRITE. A spec with no criterion makes the gate fail open and warn,
    // which is a pipeline that spends more than it should. A spec that failed to persist
    // makes sourcing fail outright. The first is recoverable by approving an ICP; the
    // second is not recoverable without an operator noticing.
    try {
      spec.buyer_criterion = await deriveBuyerCriterion({
        supabase,
        organisation_id: doc.organisation_id,
      })

      if (spec.buyer_criterion.status !== 'derived') {
        logger.warn('persistIcpFilterSpec: buyer criterion will not gate', {
          operation_id: operationId,
          document_id: documentId,
          organisation_id: doc.organisation_id,
          status: spec.buyer_criterion.status,
          reason:
            spec.buyer_criterion.unsettled_reason ??
            spec.buyer_criterion.sanity?.note ??
            null,
          consequence: 'Enrichment will run unfiltered for this client until it is resolved.',
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
          'The spec is stored WITHOUT a buyer criterion. Enrichment fails open and warns, ' +
          'so this client pays to enrich every approved prospect until an ICP is re-approved.',
      })
      Sentry.captureException(criterionError, {
        tags: { component: 'persistIcpFilterSpec', step: 'buyer_criterion' },
        extra: { operation_id: operationId, document_id: documentId },
      })
    }

    // ── 3.5 Inspect the spec we are about to write ─────────────────────────────
    // Report only. A finding here does NOT stop the write: a spec with a flaw is more
    // useful than a NULL one, which fails sourcing outright. This is the earliest point
    // an unclassifiable industry can be named, and naming it at write time is what stops
    // it being discovered later as an unexplained pile of `industry_not_consulting`.
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
