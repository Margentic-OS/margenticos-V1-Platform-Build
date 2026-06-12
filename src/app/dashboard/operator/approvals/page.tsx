// Operator-only approvals page: document suggestions pending review.
// Clients do not have access to document_suggestions; this route redirects
// non-operators back to the main dashboard.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ApprovalsView from '@/components/approvals/ApprovalsView'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import type { PendingSuggestion } from '@/components/approvals/ApprovalCard'

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

  return <ApprovalsView initialSuggestions={suggestions} filteredClientId={organisationId && clientParam ? organisationId : null} />
}
