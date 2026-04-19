import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { SettingsView } from '@/components/dashboard/operator/SettingsView'

export default async function OperatorSettingsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // TODO: Fetch real settings per client from integrations_registry and
  // organisations table when per-client settings columns are added.
  // Pass as props to SettingsView once the data model is ready.

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Settings"
        subtitle="Per-client configuration"
      />
      <WarningsRail />
      <SettingsView />
    </>
  )
}
