import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/**
 * Validates that an ICP suggestion has a filter spec ready for approval.
 * Simple null check only — does not validate industries.
 *
 * Distinguishes two states when spec is missing:
 *   still_generating: agent_run exists and is recent (< 10 min old)
 *   needs_regeneration: no agent_run or stale (> 10 min old)
 *
 * Returns: { valid: boolean, reason?: string }
 *   valid=true: icp_filter_spec is present and ready
 *   valid=false, reason='still_generating': spec is NULL and agent actively running
 *   valid=false, reason='needs_regeneration': spec is NULL and no active agent
 */
export async function validateIcpFilterSpec(
  supabase: SupabaseClient,
  suggestionId: string
): Promise<{ valid: boolean; reason?: string }> {
  // Load the suggestion to check its content
  const { data: suggestion, error: fetchError } = await supabase
    .from('document_suggestions')
    .select('id, document_type, content')
    .eq('id', suggestionId)
    .single()

  if (fetchError || !suggestion) {
    logger.debug('validateIcpFilterSpec: suggestion not found', { suggestion_id: suggestionId })
    return { valid: true }  // If suggestion not found, allow approval (it will fail downstream)
  }

  // Only check ICPs
  if (suggestion.document_type !== 'icp') {
    return { valid: true }  // Non-ICP suggestions pass
  }

  // Check if filter spec is present in the suggestion content
  const content = suggestion.content as Record<string, unknown> | null
  const icp_filter_spec = content?.['icp_filter_spec']

  if (icp_filter_spec) {
    logger.debug('validateIcpFilterSpec: filter spec populated', { suggestion_id: suggestionId })
    return { valid: true }
  }

  // Filter spec is null — check if generation is currently running
  const GENERATION_THRESHOLD_MS = 10 * 60 * 1000  // 10 minutes

  const { data: recentRuns, error: runsError } = await supabase
    .from('agent_runs')
    .select('id, created_at, status')
    .eq('suggestion_id', suggestionId)
    .eq('document_type', 'icp')
    .in('status', ['running', 'completed'])
    .order('created_at', { ascending: false })
    .limit(1)

  if (!runsError && recentRuns && recentRuns.length > 0) {
    const lastRun = recentRuns[0]
    const ageMs = Date.now() - new Date(lastRun.created_at as string).getTime()

    if (ageMs < GENERATION_THRESHOLD_MS) {
      logger.debug('validateIcpFilterSpec: filter spec still generating', {
        suggestion_id: suggestionId,
        run_age_ms: ageMs,
      })
      return { valid: false, reason: 'still_generating' }
    }
  }

  // No recent generation attempt — spec is genuinely missing
  logger.debug('validateIcpFilterSpec: filter spec missing, needs regeneration', {
    suggestion_id: suggestionId,
  })
  return { valid: false, reason: 'needs_regeneration' }
}
