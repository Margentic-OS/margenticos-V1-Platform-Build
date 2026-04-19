import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { AllClientsView } from '@/components/dashboard/operator/AllClientsView'
import type { ClientSummary } from '@/components/dashboard/operator/AllClientsView'

export default async function OperatorPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Role verified in layout — this is a belt-and-braces check on the page itself
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // Fetch all client organisations and pending approval counts in parallel.
  // Explicit client_id filter on the suggestions query — do not rely on RLS alone.
  const [{ data: orgs }, { data: suggestions }] = await Promise.all([
    supabase
      .from('organisations')
      .select('id, name, pipeline_unlocked, engagement_month, payment_status, contract_status')
      .order('name'),
    supabase
      .from('document_suggestions')
      .select('organisation_id')
      .eq('status', 'pending'),
  ])

  // Build a per-org pending count from the flat suggestions list — single query, no N+1.
  const approvalCounts: Record<string, number> = {}
  for (const row of suggestions ?? []) {
    if (row.organisation_id) {
      approvalCounts[row.organisation_id] = (approvalCounts[row.organisation_id] ?? 0) + 1
    }
  }

  const clients: ClientSummary[] = (orgs ?? []).map(o => ({
    id: o.id,
    name: o.name,
    pipeline_unlocked: o.pipeline_unlocked ?? false,
    engagement_month: o.engagement_month ?? null,
    payment_status: o.payment_status ?? null,
    contract_status: o.contract_status ?? null,
    pendingApprovals: approvalCounts[o.id] ?? 0,
  }))

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="All clients"
        subtitle={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
      />
      <WarningsRail />
      <AllClientsView clients={clients} />
    </>
  )
}
