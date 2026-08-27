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

// Serialize any error (Error, Supabase, or unknown) to human-readable message
function serializeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    // Supabase error: has message, code, details, hint
    if (obj.message) {
      let msg = String(obj.message)
      if (obj.code) msg += ` [${obj.code}]`
      if (obj.details) msg += ` — details: ${JSON.stringify(obj.details)}`
      if (obj.hint) msg += ` — hint: ${obj.hint}`
      return msg
    }
    // Fallback: JSON stringify
    try {
      return JSON.stringify(obj)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/**
 * Prospect sourcing orchestrator - PRD-15 sourcing pipeline.
 *
 * Implements steps 1-9:
 * 1. Read approved ICP
 * 2. Validate spec exists
 * 3. Get active handler
 * 4. Manifest check (handler.supported_fields vs spec fields)
 * 4.5 Industry reachability gate (spec.industries vs handler.targeted_industries)
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
  const runStartedAt = new Date().toISOString()

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

    // ── Step 4.5: Industry reachability gate ────────────────────────────────
    //
    // WHAT THIS CATCHES. The manifest check above asks whether the handler
    // SUPPORTS a field. It does not ask whether the query the handler actually
    // sends has anything to do with what the client asked for. Since the Apollo
    // query became hardcoded, those are different questions: the manifest check
    // passes for every client, and a client whose ICP names schools would be
    // handed management consultancies with no error, no warning and a run
    // recorded as completed. That is the shape this gate exists to end.
    //
    // WHY IT RUNS HERE, BEFORE handler.execute(). Failing after the search would
    // still be loud, but it would be loud after the Apollo call, the pagination
    // and the runtime have been spent. Everything this gate reads is available
    // before the first request, so it costs nothing to ask first.
    //
    // WHAT IT CANNOT DO. This proves what we ASKED FOR, not what came back.
    // Apollo silently ignores a parameter it does not recognise, so a filter
    // that reads correctly here can still return an unfiltered result. Candidates
    // at this stage carry no industry to check against: the free api_search
    // response carries `has_industry` as a boolean and never the value, so there
    // is nothing here to compare. The returned rows are checked after enrichment,
    // in tiering-trigger.ts, which is the first point an industry value exists.
    const specIndustries = Array.isArray(spec.industries) ? spec.industries : []
    const targetedIndustries = handler.targeted_industries ?? []

    if (specIndustries.length === 0) {
      // Not a failure, and deliberately so. An empty industries list is the spec
      // declining to constrain industry, not a spec that disagrees with the query,
      // and there is no intersection to be empty. It is still worth saying out
      // loud, because the practical result is the same: the client takes whatever
      // the hardcoded filter targets and nothing recorded that they chose it.
      logger.warn('Sourcing orchestrator: ICP names no industries, handler targeting is unchecked', {
        operation_id: operationId,
        client_id,
        handler_name: capabilityRow.tool_name,
        handler_targets: targetedIndustries,
      })
    } else {
      const targetedLower = new Set(targetedIndustries.map(i => i.toLowerCase()))
      const reachable = specIndustries.filter(i => targetedLower.has(String(i).toLowerCase()))
      const unreachable = specIndustries.filter(i => !targetedLower.has(String(i).toLowerCase()))

      if (reachable.length === 0) {
        logger.error('Sourcing orchestrator: spec industries unreachable by handler query', {
          operation_id: operationId,
          client_id,
          handler_name: capabilityRow.tool_name,
          spec_industries: specIndustries,
          handler_targets: targetedIndustries,
        })
        throw new Error(
          `Sourcing refused for client ${client_id}: not one of the industries this ICP asks for is ` +
          `targeted by the ${capabilityRow.tool_name} handler's search query, so every prospect it ` +
          'returned would be off-specification. ' +
          `ICP asked for: ${specIndustries.join(', ')}. ` +
          `Handler targets: ${targetedIndustries.join(', ')}. ` +
          'The query is hardcoded rather than derived from the spec, so this cannot be fixed by ' +
          'editing the ICP: either the handler needs a query that serves this client, or this client ' +
          'needs a different handler.'
        )
      }

      if (unreachable.length > 0) {
        // Partial coverage is not a failure: the run can still return prospects in
        // the industries that ARE targeted. It is reported because the difference
        // between "we searched for the 15 industries you named" and "we searched
        // for 12 of them" is invisible in the results and matters to the operator.
        logger.warn('Sourcing orchestrator: some spec industries are not targeted by the handler query', {
          operation_id: operationId,
          client_id,
          handler_name: capabilityRow.tool_name,
          reachable_count: reachable.length,
          unreachable_count: unreachable.length,
          unreachable_industries: unreachable,
        })
      }

      logger.info('Sourcing orchestrator: industry reachability gate passed', {
        operation_id: operationId,
        client_id,
        handler_name: capabilityRow.tool_name,
        reachable_industries: reachable,
      })
    }

    // ── Step 5: Call handler to search ──────────────────────────────────────
    logger.info('Sourcing orchestrator: calling handler to search', {
      operation_id: operationId,
      client_id,
      handler_name: capabilityRow.tool_name,
    })

    let candidates: ProspectCandidate[] = []
    try {
      const result = await handler.execute(spec as unknown, target_batch_size)
      candidates = result as ProspectCandidate[]
    } catch (err) {
      const errorMsg = serializeError(err)
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
      const errorMsg = serializeError(err)
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
          first_name: candidate.first_name || null,
          job_title: candidate.job_title || null,
          company_name: candidate.company_name || null,
          sourcing_review_status: 'pending_review',
          sourced_tier: null,
          email: null,
          linkedin_url: null,
          linkedin_url_normalised: null,
          website_url: null,
          country: null, // Will be populated by enrichment agent
          company_headcount: null, // Will be populated by enrichment agent
          company_industry: null, // Will be populated by enrichment agent
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
        const errorMsg = serializeError(err)
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

    // ── Step 7.5: Validation guard — prevent empty-shell writes ────────────────
    if (writtenCount > 0) {
      const { data: writtenRows, error: checkError } = await supabase
        .from('prospects')
        .select('first_name, company_name')
        .eq('organisation_id', client_id)
        .eq('sourcing_review_status', 'pending_review')
        .order('created_at', { ascending: false })
        .limit(writtenCount)

      if (!checkError && writtenRows?.length === writtenCount) {
        const emptyCount = writtenRows.filter(
          row => !row.first_name && !row.company_name
        ).length

        if (emptyCount === writtenCount) {
          const msg = `All ${writtenCount} written prospects are empty shells (NULL first_name AND NULL company_name). This indicates a schema or mapping defect in the adapter.`
          logger.error('Sourcing orchestrator: empty-shell write detected', {
            operation_id: operationId,
            client_id,
            empty_count: emptyCount,
            total_written: writtenCount,
          })

          // Fail the run instead of treating empty-shell write as success
          throw new Error(`Sourcing validation failed: ${msg}`)
        }
      }
    }

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

    const runCompletedAt = new Date().toISOString()
    const durationMs = new Date(runCompletedAt).getTime() - new Date(runStartedAt).getTime()

    const { error: runError } = await supabase.from('agent_runs').insert({
      organisation_id: client_id,
      agent_name: 'sourcing_orchestrator',
      status: 'completed',
      started_at: runStartedAt,
      completed_at: runCompletedAt,
      duration_ms: durationMs,
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
    const errorMsg = serializeError(err)

    logger.error('Sourcing orchestrator: run failed', {
      operation_id: operationId,
      client_id,
      error: errorMsg,
    })

    // Log failure to agent_runs
    const runCompletedAt = new Date().toISOString()
    const durationMs = new Date(runCompletedAt).getTime() - new Date(runStartedAt).getTime()

    const { error: runError } = await supabase.from('agent_runs').insert({
      organisation_id: client_id,
      agent_name: 'sourcing_orchestrator',
      status: 'failed',
      started_at: runStartedAt,
      completed_at: runCompletedAt,
      duration_ms: durationMs,
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
