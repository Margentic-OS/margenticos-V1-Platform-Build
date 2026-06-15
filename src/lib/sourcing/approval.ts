import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

interface ApprovalResult {
  approved_count: number
  timestamp: string
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
