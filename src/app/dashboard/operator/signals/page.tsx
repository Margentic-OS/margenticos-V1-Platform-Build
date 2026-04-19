import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { SignalsLogView } from '@/components/dashboard/operator/SignalsLogView'

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

  // TODO: Replace with real query from signals table when it exists:
  // const { data: signals } = await supabase
  //   .from('signals')
  //   .select(`
  //     id, signal_type, detail, processed, created_at,
  //     organisations(name),
  //     prospects(first_name, last_name, company_name)
  //   `)
  //   .order('created_at', { ascending: false })
  //   .limit(200)

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Signals log"
        subtitle="All clients"
      />
      <WarningsRail />
      <SignalsLogView />
    </>
  )
}
