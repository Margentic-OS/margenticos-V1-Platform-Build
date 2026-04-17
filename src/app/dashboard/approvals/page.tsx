// Operator-only approvals page — document suggestions pending review.
// Clients do not have access to document_suggestions; this route redirects
// non-operators back to the main dashboard.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ApprovalsView from '@/components/approvals/ApprovalsView'
import type { PendingSuggestion } from '@/components/approvals/ApprovalCard'

export default async function ApprovalsPage() {
  const supabase = await createClient()

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role — checked on every request, not just at login ─────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') {
    redirect('/dashboard')
  }

  // ── 3. Fetch pending suggestions across all clients ────────────────────────
  const { data: raw } = await supabase
    .from('document_suggestions')
    .select('id, document_type, field_path, current_value, suggested_value, suggestion_reason, organisations(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  const suggestions = (raw ?? []) as PendingSuggestion[]

  return <ApprovalsView initialSuggestions={suggestions} />
}
