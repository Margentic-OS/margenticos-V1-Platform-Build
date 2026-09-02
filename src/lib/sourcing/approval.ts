import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

interface ApprovalResult {
  approved_count: number
  timestamp: string
}

/**
 * Approve every prospect this organisation has awaiting review.
 *
 * ── WHY THIS EXISTS RATHER THAN THE UI SENDING EVERY ID ──
 *
 * The approval screen is paginated, so the browser holds one page. Building an
 * "approve everything" action out of the ids it happens to have loaded makes the action's
 * scope depend on what a tab fetched, which is exactly the defect the pagination was
 * fixing: before it, the header checkbox selected 50 rows nobody could see, because the
 * server had sent them and the table had sliced them away.
 *
 * So the wide action is defined by a PREDICATE, evaluated here, against the database as it
 * is at the moment of the click. It approves what is pending, not what was pending when
 * the page was rendered.
 *
 * SCOPED BY organisation_id AND status, both, in the one statement. There is no id list to
 * get wrong and no way for a caller to widen it.
 */
export async function approveAllPendingProspects(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<ApprovalResult> {
  const operationId = `approve-all-${organisationId.slice(0, 8)}-${Date.now()}`
  const now = new Date().toISOString()

  logger.info('approval: approve-all started', {
    operation_id: operationId,
    organisation_id: organisationId,
  })

  const { error, data } = await supabase
    .from('prospects')
    .update({ sourcing_review_status: 'approved', qualified_at: now })
    .eq('organisation_id', organisationId)
    .eq('sourcing_review_status', 'pending_review')
    .select('id')

  if (error) {
    logger.error('approval: approve-all failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: error.message,
    })
    throw new Error(`Approval failed: ${error.message}`)
  }

  const approvedCount = (data || []).length

  logger.info('approval: approve-all complete', {
    operation_id: operationId,
    organisation_id: organisationId,
    approved_count: approvedCount,
  })

  return { approved_count: approvedCount, timestamp: now }
}

export async function approveProspects(
  supabase: SupabaseClient,
  organisationId: string,
  prospectIds: string[],
): Promise<ApprovalResult> {
  const operationId = `approve-${organisationId.slice(0, 8)}-${Date.now()}`

  logger.info('approval: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    prospect_count: prospectIds.length,
  })

  if (!prospectIds || prospectIds.length === 0) {
    logger.info('approval: no prospects to approve', {
      operation_id: operationId,
      organisation_id: organisationId,
    })
    return {
      approved_count: 0,
      timestamp: new Date().toISOString(),
    }
  }

  try {
    const now = new Date().toISOString()

    const { error: updateError, data } = await supabase
      .from('prospects')
      .update({
        sourcing_review_status: 'approved',
        qualified_at: now,
      })
      .eq('organisation_id', organisationId)
      .in('id', prospectIds)
      .select('id')

    if (updateError) {
      logger.error('approval: update failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: updateError.message,
      })
      throw new Error(`Approval failed: ${updateError.message}`)
    }

    const approvedCount = (data || []).length

    logger.info('approval: run complete', {
      operation_id: operationId,
      organisation_id: organisationId,
      approved_count: approvedCount,
    })

    return {
      approved_count: approvedCount,
      timestamp: now,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('approval: run failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: errorMsg,
    })

    throw new Error(`Approval operation failed: ${errorMsg}`)
  }
}
