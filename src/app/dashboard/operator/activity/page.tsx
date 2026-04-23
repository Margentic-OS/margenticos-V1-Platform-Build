import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { AgentActivityView } from '@/components/dashboard/operator/AgentActivityView'
import { logger } from '@/lib/logger'
import type { AgentRun } from '@/components/dashboard/operator/AgentActivityView'

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

  const { data: rows, error } = await supabase
    .from('agent_runs')
    .select('id, agent_name, status, started_at, duration_ms, output_summary, error_message, organisations(name)')
    .order('started_at', { ascending: false })
    .limit(100)

  if (error) {
    logger.error('AgentActivityPage: failed to fetch agent_runs', { error: error.message })
  }

  const runs: AgentRun[] = (rows ?? []).map((row) => {
    const org = row.organisations as { name: string } | null
    return {
      id: row.id,
      clientName: org?.name ?? '—',
      agentName: row.agent_name,
      status: row.status as AgentRun['status'],
      durationMs: row.duration_ms ?? null,
      outputSummary: row.output_summary ?? row.error_message ?? '—',
      startedAt: row.started_at,
    }
  })

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Agent activity"
        subtitle="All clients"
      />
      <WarningsRail />
      <AgentActivityView runs={runs} error={!!error} />
    </>
  )
}
