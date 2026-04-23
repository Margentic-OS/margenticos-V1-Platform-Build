import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { SignalsLogView } from '@/components/dashboard/operator/SignalsLogView'
import { logger } from '@/lib/logger'
import type { SignalRow } from '@/components/dashboard/operator/SignalsLogView'

export default async function SignalsLogPage() {
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
    .from('signals')
    .select(`
      id, signal_type, processed, created_at,
      organisations(name),
      prospects(first_name, last_name, company_name)
    `)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    logger.error('SignalsLogPage: failed to fetch signals', { error: error.message })
  }

  const signals: SignalRow[] = (rows ?? []).map((row) => {
    const org = row.organisations as { name: string } | null
    const prospect = row.prospects as {
      first_name: string | null
      last_name: string | null
      company_name: string | null
    } | null

    const prospectName = prospect
      ? [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || null
      : null

    return {
      id: row.id,
      clientName: org?.name ?? '—',
      signalType: row.signal_type,
      prospectName,
      prospectCompany: prospect?.company_name ?? null,
      processed: row.processed,
      createdAt: row.created_at,
    }
  })

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Signals log"
        subtitle="All clients"
      />
      <WarningsRail />
      <SignalsLogView signals={signals} error={!!error} />
    </>
  )
}
