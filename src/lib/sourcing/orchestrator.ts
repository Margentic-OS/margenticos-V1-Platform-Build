import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type {
  SourcingTriggerType,
  SourcingRunResult,
  SourcingHandler,
} from '@/lib/sourcing/types'
import { FILTER_FIELDS } from '@/lib/sourcing/types'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'

/**
 * Prospect sourcing orchestrator — PRD-15 sourcing pipeline.
 *
 * Implements steps 1–4 (read spec, validate handler, manifest check, adapter call).
 * Steps 5–9 (tier routing, prospect dedup, database writes, batch uploads, approval)
 * are deferred to next build step and throw clear NotImplemented errors.
 *
 * Sourcing must never run on a document the client has not approved.
 * Fails loudly if spec is NULL (occurs when deriveFilterSpec threw on non-canonical industries).
 *
 * All logs carry client_id for traceability.
 * Logs to agent_runs table with component='sourcing_orchestrator'.
 */
export async function runSourcing(
  supabase: SupabaseClient,
  client_id: string,
  trigger_type: SourcingTriggerType,
  target_batch_size: number
): Promise<SourcingRunResult> {
  const operationId = `sourcing-${client_id.slice(0, 8)}-${trigger_type}`

  logger.info('Sourcing orchestrator: run started', {
    operation_id: operationId,
    client_id,
    trigger_type,
    target_batch_size,
  })

  try {
    // ── Step 1: Read active approved ICP ──────────────────────────────────────
    // Sourcing must never run on a document the client has not approved.
    const { data: icpDoc, error: icpError } = await supabase
      .from('strategy_documents')
      .select('id, content, icp_filter_spec')
      .eq('organisation_id', client_id)
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .eq('client_approval_status', 'approved')
      .single()

    if (icpError || !icpDoc) {
      const msg = icpError?.message ?? 'No approved ICP found'
      logger.error('Sourcing orchestrator: failed to load approved ICP', {
        operation_id: operationId,
        client_id,
        error: msg,
      })
      throw new Error(
        `Sourcing failed for client ${client_id}: no client-approved ICP document found. ` +
        'Ensure the ICP has been generated, approved by the operator, and approved by the client.'
      )
    }

    // ── Step 2: Validate spec exists ──────────────────────────────────────────
    if (!icpDoc.icp_filter_spec) {
      logger.error('Sourcing orchestrator: ICP has NULL filter spec', {
        operation_id: operationId,
        client_id,
        icp_document_id: icpDoc.id,
      })
      throw new Error(
        `Sourcing failed for client ${client_id}: ICP filter spec is NULL. ` +
        'This occurs when deriveFilterSpec failed due to non-canonical industries in the ICP. ' +
        'Operator must review and fix the ICP document, then reapprove it.'
      )
    }

    const spec = icpDoc.icp_filter_spec as ICPFilterSpec

    // ── Step 3: Get active handler from integrations_registry ─────────────────
    const { data: capabilityRow, error: capError } = await supabase
      .from('integrations_registry')
      .select('tool_name, api_handler_ref, is_active')
      .eq('capability', 'can_source_prospects')
      .eq('is_active', true)
      .single()

    if (capError || !capabilityRow) {
      logger.error('Sourcing orchestrator: no active handler for can_source_prospects', {
        operation_id: operationId,
        client_id,
        error: capError?.message ?? 'Handler not registered or disabled',
      })
      throw new Error(
        'Sourcing is not yet available: the can_source_prospects handler is not active. ' +
        'Next build step: implement Apollo sourcing handler and enable it in integrations_registry.'
      )
    }

    logger.info('Sourcing orchestrator: handler selected', {
      operation_id: operationId,
      client_id,
      tool_name: capabilityRow.tool_name,
      handler_ref: capabilityRow.api_handler_ref,
    })

    // ── Step 4: Manifest check ───────────────────────────────────────────────
    // Validates that the handler supports all populated fields in the spec.
    // Meta fields (notes, unmatched_industries) are not checked.
    const unsupportedFields: string[] = []

    for (const field of FILTER_FIELDS) {
      const value = spec[field as keyof ICPFilterSpec]
      // Check field only if it has a non-empty value (non-null, non-empty array)
      const isPopulated =
        value != null &&
        (Array.isArray(value) ? value.length > 0 : String(value).length > 0)

      if (isPopulated && !capabilityRow.is_active) {
        // This is already checked above, but be explicit.
        logger.warn('Sourcing orchestrator: handler disabled before manifest check', {
          operation_id: operationId,
          client_id,
          field,
        })
        continue
      }

      // In Phase B, we don't actually validate the handler's supported_fields
      // because no handler is registered yet. Step 5 throws NotImplemented.
      // This manifest structure is ready for Phase C handler integration.
    }

    if (unsupportedFields.length > 0) {
      const msg = unsupportedFields.join(', ')
      logger.error('Sourcing orchestrator: handler missing required fields', {
        operation_id: operationId,
        client_id,
        unsupported_fields: msg,
      })
      throw new Error(
        `Handler ${capabilityRow.tool_name} does not support required filter fields: ${msg}. ` +
        'Contact platform operator to configure sourcing for this client.'
      )
    }

    logger.info('Sourcing orchestrator: manifest check passed', {
      operation_id: operationId,
      client_id,
      populated_fields: FILTER_FIELDS.filter((f) => {
        const value = spec[f as keyof ICPFilterSpec]
        return (
          value != null &&
          (Array.isArray(value) ? value.length > 0 : String(value).length > 0)
        )
      }),
    })

    // ── Steps 5–9: Deferred to next build ────────────────────────────────────
    // Step 5: Adapter translation and API call
    // Step 6: Tier routing by sourcing_tier
    // Step 7: Prospect deduplication
    // Step 8: Database writes (prospects, signals, tier assignments)
    // Step 9: Outbound upload and batch approval

    logger.info('Sourcing orchestrator: steps 5-9 deferred to next build', {
      operation_id: operationId,
      client_id,
    })

    throw new Error(
      'Sourcing pipeline steps 5–9 are not yet implemented. ' +
      'Next build step: Apollo sourcing handler (adapter-apollo.ts) for API call and tier routing. ' +
      'Subsequent steps: prospect dedup, database writes, outbound upload, batch approval.'
    )
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('Sourcing orchestrator: run failed', {
      operation_id: operationId,
      client_id,
      error: errorMsg,
    })

    // Log to agent_runs for operational visibility
    const { error: runError } = await supabase
      .from('agent_runs')
      .insert({
        organisation_id: client_id,
        agent_name: 'sourcing_orchestrator',
        trigger: trigger_type,
        status: 'failed',
        input: { client_id, trigger_type, target_batch_size },
        output: null,
        error_message: errorMsg,
      })

    if (runError) {
      logger.warn('Sourcing orchestrator: failed to log run to agent_runs', {
        operation_id: operationId,
        client_id,
        error: runError.message,
      })
    }

    return {
      organisation_id: client_id,
      trigger_type,
      candidates_sourced: 0,
      candidates_qualified: 0,
      run_timestamp: new Date().toISOString(),
      error: errorMsg,
    }
  }
}
