import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  deriveFilterSpec,
  type IcpDocument,
} from '@/lib/agents/icp-filter-spec'

/**
 * Derives and persists the ICP filter spec for a newly promoted strategy document.
 *
 * Loads the document, derives the spec from its ICP content, and updates the
 * strategy_documents row with icp_filter_spec. Non-ICP documents return early.
 * Failures are logged and reported to Sentry but do NOT fail the promotion itself.
 * NULL icp_filter_spec is a safe failure mode: the sourcing orchestrator will fail
 * loudly when it encounters a NULL spec, providing clear operator feedback.
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
      .select('id, document_type, content')
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
    let spec
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
