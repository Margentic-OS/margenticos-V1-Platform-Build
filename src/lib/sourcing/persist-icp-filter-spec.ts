import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  deriveFilterSpec,
  FilterSpecRefusal,
  type IcpDocument,
  type ICPFilterSpec,
} from '@/lib/agents/icp-filter-spec'
import { inspectFilterSpec } from '@/lib/sourcing/inspect-filter-spec'
import { deriveBuyerCriterionWithVocabulary } from '@/agents/buyer-criterion-agent'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import type { SpecSeniority } from '@/lib/agents/icp-filter-spec'
import {
  resolveIcpGeography,
  type ResolvedGeography,
} from '@/lib/sourcing/resolve-icp-geography'
import { buildSpecRefusal, type SpecRefusalReason } from '@/lib/sourcing/spec-refusal'

/**
 * Derives and persists the ICP filter spec for a newly promoted strategy document.
 *
 * Loads the document, derives the spec from its ICP content, and updates the
 * strategy_documents row with icp_filter_spec. Non-ICP documents return early.
 * Failures are logged and reported to Sentry but do NOT fail the promotion itself.
 * NULL icp_filter_spec is a safe failure mode: the sourcing orchestrator will fail
 * loudly when it encounters a NULL spec.
 *
 * WHEN THE SPEC CANNOT BE BUILT, THE REASON IS WRITTEN ON THE DOCUMENT, in
 * icp_filter_spec_refusal, and the strategy page shows it to the operator. Every caller runs
 * this after the promotion has already been reported as a success, so without that column the
 * only record of a refusal was Sentry. See spec-refusal.ts.
 *
 * Also re-queues the organisation's previously REMOVED prospects for tiering, because
 * a new filter spec is the rule that removed them changing. This is the only thing in
 * the codebase that re-queues them. See ADR-037.
 *
 * Called from, always after the new version is live:
 *   - POST /api/suggestions/[id]/approve (in after())
 *   - POST /api/cron/auto-approve (after the RPC succeeds)
 *   - POST /api/documents/revise (in after())
 *   - POST /api/documents/revert
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
    let buyerCriterion: BuyerCriterion | null = null
    // No default and no fallback. deriveFilterSpec refuses on an empty set, which is the
    // point: the two fixed lists that used to stand in for this are what removed almost
    // everyone one live client's own job titles reached.
    let seniority: SpecSeniority = { bands: [], discarded: [], evidence: '' }
    // Kept so a refusal further down can name THIS as its cause. Seniority comes off the same
    // call, so when this fails the spec refuses for want of seniority, and a label saying
    // "no seniority" would send the reader to the wrong place.
    let criterionFailure: string | null = null
    try {
      // ONE CALL, TWO ANSWERS. The seniority bands come off the same request that derives
      // the criterion: it already carries every approved document and the whole intake,
      // which is the material the buyer's level is stated in. A second call would re-send
      // the same context to ask a question this one can answer.
      const derived = await deriveBuyerCriterionWithVocabulary({
        supabase,
        organisation_id: doc.organisation_id,
      })
      buyerCriterion = derived.criterion
      seniority = derived.seniority

      if (seniority.discarded.length > 0) {
        logger.warn('persistIcpFilterSpec: seniority values the provider would not honour', {
          operation_id: operationId,
          organisation_id: doc.organisation_id,
          discarded_count: seniority.discarded.length,
          kept_count: seniority.bands.length,
          consequence:
            'The derivation returned values outside the provider\'s vocabulary. They were ' +
            'dropped here rather than sent, because the provider drops an unrecognised ' +
            'value silently and a silently dropped filter looks exactly like one that worked.',
        })
      }

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
      criterionFailure = msg
      logger.error('persistIcpFilterSpec: buyer criterion derivation failed', {
        operation_id: operationId,
        document_id: documentId,
        organisation_id: doc.organisation_id,
        error: msg,
        consequence:
          'There is no buyer criterion and no seniority, because both come off this call, so ' +
          'the spec will be refused below and the refusal recorded on the document. Sourcing ' +
          'refuses to run for this client until an ICP is re-approved. Recoverable; nothing ' +
          'is spent.',
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
    // Geography fails CLOSED. A spec with no countries, or with the wrong ones, is a
    // legal exposure rather than a wasted send, and there is no value that could stand in
    // for a missing country list without guessing which markets a client sells to. So the
    // whole write is abandoned and icp_filter_spec stays NULL.
    //
    // NULL IS AN EXISTING, LOUD FAILURE and that is why it is reused rather than a new
    // mechanism being invented: the sourcing orchestrator already refuses to run on a NULL
    // spec with an operator-facing message. Nothing is sourced, nothing is spent, and the
    // document that caused it is named in this log, in Sentry, and on the document itself.
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
        tags: { component: 'persistIcpFilterSpec', step: 'geography', refusal_reason: 'geography_unresolved' },
        extra: {
          operation_id: operationId,
          document_id: documentId,
          organisation_id: doc.organisation_id,
        },
      })
      await recordSpecRefusal(supabase, documentId, operationId, 'geography_unresolved', msg)
      try {
        await Sentry.flush(2000)
      } catch {}
      return
    }

    // ── 3.2 The per-client revenue opt-in ─────────────────────────────────────
    //
    // Read HERE, when the spec is built, and never at search time: the stored spec must
    // describe the search it produces. So flipping the switch takes effect at the next ICP
    // approval, which the settings page says beside the control.
    //
    // A FAILED READ IS TREATED AS NOT OPTED IN. That is the direction that cannot remove
    // anybody the client did not ask to remove: the band is still read and recorded, only
    // switched off with the reason. Measured 2026-09-10: the provider's revenue filter drops
    // every company it holds no revenue figure for, 78% of one live client's search.
    const { data: orgRow, error: orgError } = await supabase
      .from('organisations')
      .select('sourcing_revenue_filter_enabled')
      .eq('id', doc.organisation_id)
      .single()
    if (orgError) {
      logger.warn('persistIcpFilterSpec: could not read the revenue opt-in, treating it as off', {
        operation_id: operationId,
        organisation_id: doc.organisation_id,
        error: orgError.message,
      })
    }
    const revenueFilterEnabled = !orgError && orgRow?.sourcing_revenue_filter_enabled === true

    // ── 3.25 Derive the filter spec from ICP content ───────────────────────────
    // deriveFilterSpec refuses on non-canonical industries, a missing seniority set, no
    // countries, and a headcount range with no usable bound. Each refusal is a
    // FilterSpecRefusal naming its rule.
    let spec: ICPFilterSpec
    try {
      spec = deriveFilterSpec(
        doc.content as IcpDocument, buyerCriterion, geography, seniority, { revenueFilterEnabled },
      )
    } catch (specError) {
      const msg = specError instanceof Error ? specError.message : String(specError)

      // THE LABEL IS THE CAUSE. This used to read "non-canonical industries" for every
      // refusal, whatever refused, and the one that reached Sentry on 2026-09-08 was a blank
      // headcount. The rule comes from the error itself. A failed criterion call is named
      // over the rule it tripped, because it is what emptied seniority; anything thrown that
      // is not a named refusal is 'unclassified', a true label rather than a guess.
      const rule: SpecRefusalReason =
        specError instanceof FilterSpecRefusal ? specError.reason : 'unclassified'
      const reason: SpecRefusalReason = criterionFailure ? 'buyer_criterion_failed' : rule
      const detail = criterionFailure
        ? `The buyer criterion call failed (${criterionFailure}), so the spec was refused: ${msg}`
        : msg

      logger.error(`persistIcpFilterSpec: deriveFilterSpec refused the ICP (${reason})`, {
        operation_id: operationId,
        document_id: documentId,
        refusal_reason: reason,
        refusal_rule: rule,
        error: msg,
      })
      Sentry.withScope((scope) => {
        scope.setExtra('operation_id', operationId)
        scope.setExtra('document_id', documentId)
        scope.setExtra('error_type', reason)
        scope.setContext('icp_content', { content_type: doc.content?.constructor.name })
        Sentry.captureException(specError, {
          extra: {
            operation_id: operationId,
            document_id: documentId,
            error_context: 'deriveFilterSpec validation',
            refusal_rule: rule,
          },
          tags: {
            component: 'persistIcpFilterSpec',
            refusal_reason: reason,
          },
        })
      })
      await recordSpecRefusal(supabase, documentId, operationId, reason, detail)
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
    // The refusal is cleared IN THE SAME WRITE, so a version can never carry a spec and a
    // stale refusal from an earlier attempt at once.
    const { error: updateError } = await supabase
      .from('strategy_documents')
      .update({ icp_filter_spec: spec, icp_filter_spec_refusal: null })
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
      await recordSpecRefusal(supabase, documentId, operationId, 'spec_write_failed', msg)
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
    await recordSpecRefusal(supabase, documentId, operationId, 'unexpected', msg)
    try {
      await Sentry.flush(2000)
    } catch {}
  }
}

/**
 * Write down, on the document itself, why this version has no usable search specification.
 *
 * NEVER THROWS. It runs inside failure handling, often when the database is the thing that is
 * unwell, and a recorder that could fail the promotion would be worse than none. When this
 * write fails, the log line and the Sentry event written just before it still stand.
 */
async function recordSpecRefusal(
  supabase: SupabaseClient,
  documentId: string,
  operationId: string,
  reason: SpecRefusalReason,
  detail: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('strategy_documents')
      .update({ icp_filter_spec_refusal: buildSpecRefusal(reason, detail) })
      .eq('id', documentId)

    if (error) {
      logger.error('persistIcpFilterSpec: could not record the refusal on the document', {
        operation_id: operationId,
        document_id: documentId,
        refusal_reason: reason,
        error: error.message,
      })
    }
  } catch (err) {
    logger.error('persistIcpFilterSpec: recording the refusal threw', {
      operation_id: operationId,
      document_id: documentId,
      refusal_reason: reason,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
