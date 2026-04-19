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

  // Fetch all client organisations with the fields available in the current schema
  // TODO: Add payment_status and contract_status to this query when those columns
  // are added to the organisations table.
  const { data: orgs } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked, engagement_month')
    .order('name')

  const clients: ClientSummary[] = (orgs ?? []).map(o => ({
    id: o.id,
    name: o.name,
    pipeline_unlocked: o.pipeline_unlocked ?? false,
    engagement_month: o.engagement_month ?? null,
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
