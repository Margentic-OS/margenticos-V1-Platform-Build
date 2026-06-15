import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type {
  SourcingTriggerType,
  SourcingRunResult,
  SourcingHandler,
} from '@/lib/sourcing/types'
import { FILTER_FIELDS } from '@/lib/sourcing/types'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'
import { checkCandidates, type ProspectCandidate } from '@/lib/sourcing/dedupe'

/**
 * Prospect sourcing orchestrator - PRD-15 sourcing pipeline.
 *
 * Implements steps 1-9:
 * 1. Read approved ICP
 * 2. Validate spec exists
 * 3. Get active handler
 * 4. Manifest check (handler.supported_fields vs spec fields)
 * 5. Call handler to search
 * 6. Dedupe candidates (suppressed, duplicate person_key, linkedin, email)
 * 7. Write survivors as pending_review prospect rows (untiered)
 * 8. Log run with dedupe breakdown
 * 9. Return result
 *
 * Sourcing must never run on a document the client has not approved.
 * Fails loudly if spec is NULL (occurs when deriveFilterSpec threw on non-canonical industries).
 *
 * All logs carry client_id for traceability.
 * Logs to agent_runs table.
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
    // Get handler and validate it supports all populated spec fields.
    // Note: handler resolution uses tool_name, not api_handler_ref (which is intentionally unused for dispatch).
    const handlerDispatch: Record<string, SourcingHandler> = {
      'apollo': apolloHandler as SourcingHandler,
    }
    const handler = handlerDispatch[capabilityRow.tool_name]
    if (!handler) {
      logger.error('Sourcing orchestrator: no handler registered for tool', {
        operation_id: operationId,
        client_id,
        tool_name: capabilityRow.tool_name,
      })
      throw new Error(
        `Sourcing failed: no handler registered for tool '${capabilityRow.tool_name}'. ` +
        'Contact platform operator.'
      )
    }

    // Check handler.supported_fields against populated spec fields
    const unsupportedFields: string[] = []
    const populatedFields: string[] = []

    for (const field of FILTER_FIELDS) {
      const value = spec[field as keyof ICPFilterSpec]
      const isPopulated =
        value != null &&
        (Array.isArray(value) ? value.length > 0 : String(value).length > 0)

      if (isPopulated) {
        populatedFields.push(field)
        if (!handler.supported_fields.includes(field)) {
          unsupportedFields.push(field)
        }
      }
    }

    if (unsupportedFields.length > 0) {
      const msg = unsupportedFields.join(', ')
      logger.error('Sourcing orchestrator: handler missing required fields', {
        operation_id: operationId,
        client_id,
        unsupported_fields: msg,
        handler_name: capabilityRow.tool_name,
      })
      throw new Error(
        `Handler ${capabilityRow.tool_name} does not support required filter fields: ${msg}. ` +
        'Contact platform operator to configure sourcing for this client.'
      )
    }

    logger.info('Sourcing orchestrator: manifest check passed', {
      operation_id: operationId,
      client_id,
      handler_name: capabilityRow.tool_name,
      populated_fields: populatedFields,
    })

    // ── Step 5: Call handler to search ──────────────────────────────────────
    logger.info('Sourcing orchestrator: calling handler to search', {
      operation_id: operationId,
      client_id,
      handler_name: capabilityRow.tool_name,
    })

    let candidates: ProspectCandidate[] = []
    try {
      const result = await handler.execute(spec as unknown)
      candidates = result as ProspectCandidate[]
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error('Sourcing orchestrator: handler search failed', {
        operation_id: operationId,
        client_id,
        error: errorMsg,
      })

      // Log failure to agent_runs
      await supabase.from('agent_runs').insert({
        organisation_id: client_id,
        agent_name: 'sourcing_orchestrator',
        status: 'failed',
        output_summary: null,
        error_message: `Handler search failed: ${errorMsg}`,
      })

      throw new Error(`Sourcing failed at search step: ${errorMsg}`)
    }

    logger.info('Sourcing orchestrator: search returned candidates', {
      operation_id: operationId,
      client_id,
      candidate_count: candidates.length,
    })

    // ── Step 6: Dedupe candidates ───────────────────────────────────────────
    logger.info('Sourcing orchestrator: running dedupe check', {
      operation_id: operationId,
      client_id,
      candidates_to_check: candidates.length,
    })

    let verdicts: Map<string, string>
    try {
      verdicts = await checkCandidates(supabase, client_id, candidates)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error('Sourcing orchestrator: dedupe check failed', {
        operation_id: operationId,
        client_id,
        error: errorMsg,
      })

      await supabase.from('agent_runs').insert({
        organisation_id: client_id,
        agent_name: 'sourcing_orchestrator',
        status: 'failed',
        output_summary: null,
        error_message: `Dedupe check failed: ${errorMsg}`,
      })

      throw new Error(`Sourcing failed at dedupe step: ${errorMsg}`)
    }

    // Count verdicts by type
    const verdictCounts = {
      new: 0,
      suppressed_match: 0,
      duplicate_person_key: 0,
      duplicate_linkedin: 0,
      duplicate_email: 0,
    }

    for (const verdict of verdicts.values()) {
      const v = verdict as string
      if (v in verdictCounts) {
        verdictCounts[v as keyof typeof verdictCounts]++
      }
    }

    logger.info('Sourcing orchestrator: dedupe check complete', {
      operation_id: operationId,
      client_id,
      new: verdictCounts.new,
      suppressed: verdictCounts.suppressed_match,
      duplicate_person_key: verdictCounts.duplicate_person_key,
      duplicate_linkedin: verdictCounts.duplicate_linkedin,
      duplicate_email: verdictCounts.duplicate_email,
    })

    // ── Step 7: Write survivors to prospects table ──────────────────────────
    logger.info('Sourcing orchestrator: writing survivor candidates to prospects', {
      operation_id: operationId,
      client_id,
      survivors: verdictCounts.new,
    })

    let writtenCount = 0
    const now = new Date().toISOString()

    for (const candidate of candidates) {
      const verdict = verdicts.get(candidate.source_person_key)
      if (verdict !== 'new') {
        continue
      }

      try {
        const { error: insertError } = await supabase.from('prospects').insert({
          organisation_id: client_id,
          source_person_key: candidate.source_person_key,
          sourcing_review_status: 'pending_review',
          sourced_tier: null,
          email: null,
          linkedin_url: null,
          linkedin_url_normalised: null,
          website_url: null,
        })

        if (insertError) {
          logger.error('Sourcing orchestrator: failed to insert prospect', {
            operation_id: operationId,
            client_id,
            source_person_key: candidate.source_person_key,
            error: insertError.message,
          })
          throw insertError
        }

        writtenCount++
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        logger.error('Sourcing orchestrator: prospect insert failed', {
          operation_id: operationId,
          client_id,
          error: errorMsg,
        })

        await supabase.from('agent_runs').insert({
          organisation_id: client_id,
          agent_name: 'sourcing_orchestrator',
          status: 'failed',
          output_summary: null,
          error_message: `Prospect write failed: ${errorMsg}`,
        })

        throw new Error(`Sourcing failed at prospect write step: ${errorMsg}`)
      }
    }

    logger.info('Sourcing orchestrator: prospects written', {
      operation_id: operationId,
      client_id,
      written_count: writtenCount,
    })

    // ── Step 8: Log run with breakdown ──────────────────────────────────────
    const droppedCount =
      verdictCounts.suppressed_match +
      verdictCounts.duplicate_person_key +
      verdictCounts.duplicate_linkedin +
      verdictCounts.duplicate_email

    const outputSummary =
      `candidates returned ${candidates.length}, ` +
      `written ${writtenCount}, ` +
      `dropped ${droppedCount} ` +
      `(suppressed: ${verdictCounts.suppressed_match}, ` +
      `duplicate_person_key: ${verdictCounts.duplicate_person_key}, ` +
      `duplicate_linkedin: ${verdictCounts.duplicate_linkedin}, ` +
      `duplicate_email: ${verdictCounts.duplicate_email})`

    logger.info('Sourcing orchestrator: run complete', {
      operation_id: operationId,
      client_id,
      summary: outputSummary,
    })

    const { error: runError } = await supabase.from('agent_runs').insert({
      organisation_id: client_id,
      agent_name: 'sourcing_orchestrator',
      status: 'success',
      output_summary: outputSummary,
      error_message: null,
    })

    if (runError) {
      logger.warn('Sourcing orchestrator: failed to log run to agent_runs', {
        operation_id: operationId,
        client_id,
        error: runError.message,
      })
    }

    // ── Step 9: Return result ───────────────────────────────────────────────
    return {
      organisation_id: client_id,
      trigger_type,
      candidates_sourced: candidates.length,
      candidates_qualified: writtenCount,
      run_timestamp: now,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('Sourcing orchestrator: run failed', {
      operation_id: operationId,
      client_id,
      error: errorMsg,
    })

    // Log failure to agent_runs
    const { error: runError } = await supabase.from('agent_runs').insert({
      organisation_id: client_id,
      agent_name: 'sourcing_orchestrator',
      status: 'failed',
      output_summary: null,
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
