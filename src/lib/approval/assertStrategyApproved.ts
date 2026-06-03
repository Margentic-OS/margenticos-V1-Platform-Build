// Single source of truth for the strategy-approval gate.
//
// All four documents for a hand-off must be client_approval_status='approved':
//   Segment-scoped (resolved to the given segmentId):  ICP, Messaging
//   Org-level (segment_id IS NULL):                    Positioning, TOV
//
// Callers resolve NULL-segment prospects to the primary segment BEFORE calling
// this helper — the helper takes the already-resolved id.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const DOC_LABELS: Record<string, string> = {
  icp: 'Prospect profile',
  messaging: 'Messaging',
  positioning: 'Positioning',
  tov: 'Voice guide',
}

export type ApprovalCheckResult =
  | { approved: true }
  | { approved: false; pendingDocs: string[] }

export async function assertStrategyApproved(
  supabase: SupabaseClient<Database>,
  orgId: string,
  segmentId: string | null,
): Promise<ApprovalCheckResult> {
  const pendingDocs: string[] = []

  // Segment-scoped docs: ICP and Messaging
  const segmentBaseQuery = supabase
    .from('strategy_documents')
    .select('document_type, client_approval_status')
    .eq('organisation_id', orgId)
    .in('status', ['active', 'approved'])
    .in('document_type', ['icp', 'messaging'])

  const { data: segmentDocs } = segmentId
    ? await segmentBaseQuery.eq('segment_id', segmentId)
    : await segmentBaseQuery.is('segment_id', null)

  for (const docType of ['icp', 'messaging'] as const) {
    const doc = (segmentDocs ?? []).find(d => d.document_type === docType)
    if (!doc || doc.client_approval_status !== 'approved') {
      pendingDocs.push(DOC_LABELS[docType])
    }
  }

  // Org-level docs: Positioning and TOV (always segment_id IS NULL)
  const { data: orgDocs } = await supabase
    .from('strategy_documents')
    .select('document_type, client_approval_status')
    .eq('organisation_id', orgId)
    .in('status', ['active', 'approved'])
    .in('document_type', ['positioning', 'tov'])
    .is('segment_id', null)

  for (const docType of ['positioning', 'tov'] as const) {
    const doc = (orgDocs ?? []).find(d => d.document_type === docType)
    if (!doc || doc.client_approval_status !== 'approved') {
      pendingDocs.push(DOC_LABELS[docType])
    }
  }

  if (pendingDocs.length > 0) {
    return { approved: false, pendingDocs }
  }

  return { approved: true }
}
