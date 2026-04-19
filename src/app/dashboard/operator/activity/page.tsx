import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { AgentActivityView } from '@/components/dashboard/operator/AgentActivityView'

export default async function AgentActivityPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // TODO: Replace with real query from agent_runs table when it exists:
  // const { data: runs } = await supabase
  //   .from('agent_runs')
  //   .select('id, started_at, status, duration_ms, output_summary, agent_name, organisations(name)')
  //   .order('started_at', { ascending: false })
  //   .limit(100)

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Agent activity"
        subtitle="All clients"
      />
      <WarningsRail />
      <AgentActivityView />
    </>
  )
}
