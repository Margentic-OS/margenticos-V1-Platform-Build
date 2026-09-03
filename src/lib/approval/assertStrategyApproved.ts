// Single source of truth for the strategy-document readiness gate.
//
// All four documents for a hand-off must EXIST and be live:
//   Segment-scoped (resolved to the given segmentId):  ICP, Messaging
//   Org-level (segment_id IS NULL):                    Positioning, TOV
//
// Callers resolve NULL-segment prospects to the primary segment BEFORE calling
// this helper — the helper takes the already-resolved id.
//
// ─── WHAT THIS USED TO CHECK, AND WHY IT NO LONGER DOES ──────────────────────
//
// Until 2026-09-03 this required client_approval_status = 'approved' on all four.
// Client approval on strategy documents has been removed: the conversation with the
// operator is the approval. See ADR-047.
//
// The missing-document half of the check is kept, and it is the half that was always
// doing the work. A client with no messaging document cannot have emails composed
// from it, and the failure without this gate is a composition error per prospect
// rather than one legible message naming what is absent.
//
// THIS FILE AND promote_strategy_doc_version MUST CHANGE TOGETHER. While promote
// inserted new versions as 'pending' and this file demanded 'approved', every
// regeneration silently blocked lead upload with nothing on screen to explain it.
// That coupling is the whole defect, so if one of them is ever edited, read the other.

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
    .select('document_type')
    .eq('organisation_id', orgId)
    .in('status', ['active', 'approved'])
    .in('document_type', ['icp', 'messaging'])

  const { data: segmentDocs } = segmentId
    ? await segmentBaseQuery.eq('segment_id', segmentId)
    : await segmentBaseQuery.is('segment_id', null)

  for (const docType of ['icp', 'messaging'] as const) {
    const doc = (segmentDocs ?? []).find(d => d.document_type === docType)
    if (!doc) {
      pendingDocs.push(DOC_LABELS[docType])
    }
  }

  // Org-level docs: Positioning and TOV (always segment_id IS NULL)
  const { data: orgDocs } = await supabase
    .from('strategy_documents')
    .select('document_type')
    .eq('organisation_id', orgId)
    .in('status', ['active', 'approved'])
    .in('document_type', ['positioning', 'tov'])
    .is('segment_id', null)

  for (const docType of ['positioning', 'tov'] as const) {
    const doc = (orgDocs ?? []).find(d => d.document_type === docType)
    if (!doc) {
      pendingDocs.push(DOC_LABELS[docType])
    }
  }

  if (pendingDocs.length > 0) {
    return { approved: false, pendingDocs }
  }

  return { approved: true }
}
