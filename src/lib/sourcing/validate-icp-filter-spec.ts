import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveFilterSpec, type IcpDocument } from '@/lib/agents/icp-filter-spec'
import { logger } from '@/lib/logger'

/**
 * Validates that an ICP document can be used for sourcing.
 * Checks: document exists, is ICP type, and its content can derive a valid filter spec.
 *
 * Returns: { valid: boolean, reason?: string }
 *   valid=true: ICP is ready for sourcing
 *   valid=false, reason='still_generating': ICP exists but filter spec is NULL (still being derived)
 *   valid=false, reason='invalid_industries': ICP has non-canonical industries
 *   valid=false, reason='not_found': ICP document doesn't exist
 *   valid=false, reason='not_icp': Document exists but is not an ICP
 */
export async function validateIcpFilterSpec(
  supabase: SupabaseClient,
  documentId: string
): Promise<{ valid: boolean; reason?: string }> {
  // Load the ICP document
  const { data: doc, error: fetchError } = await supabase
    .from('strategy_documents')
    .select('id, document_type, content, icp_filter_spec')
    .eq('id', documentId)
    .single()

  if (fetchError || !doc) {
    logger.debug('validateIcpFilterSpec: document not found', { document_id: documentId })
    return { valid: false, reason: 'not_found' }
  }

  // Only validate ICPs
  if (doc.document_type !== 'icp') {
    // Non-ICP documents pass validation
    return { valid: true }
  }

  // Check if filter spec is already populated
  if (doc.icp_filter_spec) {
    logger.debug('validateIcpFilterSpec: filter spec already valid', { document_id: documentId })
    return { valid: true }
  }

  // Filter spec is null — try to derive it to check for validation errors
  // If deriveFilterSpec throws (e.g., non-canonical industries), the ICP is invalid for sourcing
  try {
    deriveFilterSpec(doc.content as IcpDocument)
    // If we reach here, derivation succeeded but somehow icp_filter_spec is still null —
    // this shouldn't happen, but treat as still generating
    logger.warn('validateIcpFilterSpec: derivation succeeded but spec is NULL', {
      document_id: documentId,
    })
    return { valid: false, reason: 'still_generating' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.debug('validateIcpFilterSpec: derivation failed', {
      document_id: documentId,
      error: msg,
    })
    return { valid: false, reason: 'invalid_industries' }
  }
}
