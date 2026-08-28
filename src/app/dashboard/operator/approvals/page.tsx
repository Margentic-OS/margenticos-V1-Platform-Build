// Operator-only approvals page: document suggestions pending review.
// Clients do not have access to document_suggestions; this route redirects
// non-operators back to the main dashboard.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ApprovalsView from '@/components/approvals/ApprovalsView'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import type { PendingSuggestion } from '@/components/approvals/ApprovalCard'
import type { QueuedSuggestion } from '@/components/approvals/ApprovalsView'
import { findDrivingRejectionNotes } from '@/lib/approvals/driving-rejection-note'

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const { client: clientParam } = await searchParams

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role: checked on every request, not just at login ──────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') {
    redirect('/dashboard')
  }

  // ── 3. Resolve viewing org (operator can filter by client if clientParam provided) ──
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)

  // ── 4. Fetch pending suggestions filtered by organisation if provided ─────
  let query = supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, field_path, current_value, suggested_value, suggestion_reason, revision_note, update_trigger, created_at, organisations(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  // Apply client filter if clientParam provided
  if (organisationId && clientParam) {
    query = query.eq('organisation_id', organisationId)
  }

  const { data: raw } = await query

  const suggestions = (raw ?? []) as PendingSuggestion[]

  // ── 5. The operator's rejection note that drove each regeneration ──────────
  //
  // ADR-038 made this note reach the generation agents. It still reached no screen, so an
  // operator reviewing the replacement could not see the instruction it was answering.
  //
  // It is NOT a column on the pending row. Rejecting writes rejection_reason onto the row
  // being REPLACED and flips that row to 'rejected'; the regeneration creates a different
  // row. Adding rejection_reason to the select above would return NULL for every pending
  // row: it compiles, it looks like the fix, and it displays nothing. So the note is looked
  // up on the predecessor. See src/lib/approvals/driving-rejection-note.ts for what that
  // pairing can and cannot prove.
  const orgIds = [...new Set(suggestions.map(s => s.organisation_id))]
  const { data: rejectedRows } = orgIds.length > 0
    ? await supabase
        .from('document_suggestions')
        .select('organisation_id, document_type, rejection_reason, reviewed_at')
        .in('organisation_id', orgIds)
        .eq('status', 'rejected')
        .not('rejection_reason', 'is', null)
    : { data: [] }

  const drivingNotes = findDrivingRejectionNotes(suggestions, rejectedRows ?? [])

  const queued: QueuedSuggestion[] = suggestions.map(s => ({
    ...s,
    driving_rejection_note: drivingNotes.get(s.id)?.note ?? null,
    driving_rejection_at: drivingNotes.get(s.id)?.rejected_at ?? null,
  }))

  return <ApprovalsView initialSuggestions={queued} filteredClientId={organisationId && clientParam ? organisationId : null} />
}
