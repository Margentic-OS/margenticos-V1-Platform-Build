import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/**
 * Validates that an ICP document has a filter spec ready for sourcing.
 * Simple null check only — does not validate industries.
 *
 * Returns: { valid: boolean, reason?: string }
 *   valid=true: icp_filter_spec is present and ready
 *   valid=false, reason='still_generating': icp_filter_spec is NULL
 */
export async function validateIcpFilterSpec(
  supabase: SupabaseClient,
  documentId: string
): Promise<{ valid: boolean; reason?: string }> {
  // Load the ICP document
  const { data: doc, error: fetchError } = await supabase
    .from('strategy_documents')
    .select('id, document_type, icp_filter_spec')
    .eq('id', documentId)
    .single()

  if (fetchError || !doc) {
    logger.debug('validateIcpFilterSpec: document not found', { document_id: documentId })
    return { valid: true }  // Non-ICP docs bypass check; ICP not found is not a blocker here
  }

  // Only check ICPs
  if (doc.document_type !== 'icp') {
    return { valid: true }  // Non-ICP documents pass
  }

  // Check if filter spec is present
  if (doc.icp_filter_spec) {
    logger.debug('validateIcpFilterSpec: filter spec populated', { document_id: documentId })
    return { valid: true }
  }

  // Filter spec is null — approval must wait until it's generated
  logger.debug('validateIcpFilterSpec: filter spec is null, still generating', { document_id: documentId })
  return { valid: false, reason: 'still_generating' }
}
