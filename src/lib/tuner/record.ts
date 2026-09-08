// Writing the run down, for a person to read and for a later mechanism to learn from.
//
// ─── WHAT IS STORED AND WHAT IS NOT ──────────────────────────────────────────
//
// Everything a reader would need to disagree with the tuner: what was tried, what each
// number did, what was decided and why, every judged row with its verdict and reason and
// whatever the lookup read, the terminal state, and what the run cost in model calls and in
// billable searches.
//
// NO LEARNING MECHANISM IS BUILT AND NONE IS BEING BUILT. The columns a human fills in
// afterwards are empty by design. They exist so that when somebody does build one there is
// something to learn from, and so that a person's disagreement lands in the same row as the
// conclusion they disagree with rather than in a thread nobody can query.
//
// ─── THE MARKER ──────────────────────────────────────────────────────────────
//
// Three columns, not a foreign key. A client's search settings are rebuilt from their
// document on every approval, revision and revert, and the document row is updated in place,
// so an id alone resolves fine forever while describing something that has moved. Measured:
// one live organisation's document went from version 4 to version 8 in a day and the
// population its search reaches fell from 142 to 1.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { TunerResult } from '@/lib/tuner/run-tuner'

export interface WriteRecordInput {
  supabase: SupabaseClient
  organisationId: string
  triggerType: 'operator_manual' | 'instruction'
  result: TunerResult
  startedAt: string
}

/**
 * Persist one run and its rounds.
 *
 * NEVER THROWS. A tuning run that completed and then failed to write its record should
 * report the run, not disappear: the caller already has the result in hand and an operator
 * seeing an outcome with a warning attached is better served than one seeing an error for
 * work that succeeded. The failure is logged loudly and the returned id is null.
 */
export async function writeTuningRecord(input: WriteRecordInput): Promise<{ runId: string | null }> {
  const { supabase, organisationId, triggerType, result, startedAt } = input

  try {
    const { data: run, error } = await supabase
      .from('tuning_runs')
      .insert({
        organisation_id: organisationId,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        trigger_type: triggerType,
        instruction_text: result.instruction?.text ?? null,
        instruction_resolution: result.instruction?.resolution ?? null,
        icp_document_id: result.documentMarker?.documentId ?? null,
        icp_document_version: result.documentMarker?.version ?? null,
        icp_document_updated_at: result.documentMarker?.updatedAt ?? null,
        terminal_state: result.terminalState,
        terminal_reason: result.terminalReason,
        baseline_population: result.baselinePopulation,
        ceiling_population: result.ceilingPopulation,
        rounds_run: result.rounds.length,
        model_calls: result.modelCalls,
        billable_searches: result.billableSearches,
        provider_calls: result.providerCalls,
        plan: result.plan ?? null,
      })
      .select('id')
      .single()

    if (error || !run) {
      logger.error('tuner: failed to write run record', {
        organisation_id: organisationId,
        terminal_state: result.terminalState,
        error: error?.message,
      })
      return { runId: null }
    }

    const runId = run.id as string

    if (result.rounds.length > 0) {
      const { error: roundError } = await supabase.from('tuning_rounds').insert(
        result.rounds.map(r => ({
          run_id: runId,
          round_index: r.index,
          kind: r.kind,
          completed_at: new Date().toISOString(),
          population: r.population,
          // WEAK AND REDUNDANT TRAVEL AS THEY WERE MEASURED, per item, and are not collapsed
          // into a single "did this matter" flag on the way in. Collapsing them here would
          // undo the whole point of measuring both.
          differencing: r.differencing ?? null,
          tier_counts: r.tierCounts ?? null,
          unresolved_fields: r.unresolvedFields ?? null,
          change_proposed: r.changeProposed ?? null,
          change_reason: r.changeReason,
          judged_sample: r.judged ?? null,
          judge_resolved_sample: r.judgeResolvedSample,
          judge_agreement: r.judgeAgreement,
          judge_reliable: r.judgeReliable,
          model_calls: r.modelCalls,
          billable_searches: r.billableSearches,
          provider_calls: r.providerCalls,
        })),
      )
      if (roundError) {
        logger.error('tuner: run recorded but rounds were not', {
          run_id: runId, error: roundError.message,
        })
      }
    }

    logger.info('tuner: run recorded', {
      run_id: runId,
      organisation_id: organisationId,
      terminal_state: result.terminalState,
      rounds: result.rounds.length,
      model_calls: result.modelCalls,
      billable_searches: result.billableSearches,
      provider_calls: result.providerCalls,
      consumed_by: 'nothing',
    })

    return { runId }
  } catch (err) {
    logger.error('tuner: record write threw', {
      organisation_id: organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { runId: null }
  }
}
