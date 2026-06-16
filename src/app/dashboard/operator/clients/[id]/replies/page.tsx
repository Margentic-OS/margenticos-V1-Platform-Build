import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getAllRepliesForOrg } from '@/lib/reply-handling/get-client-visible-replies'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { OperatorRepliesView } from './components/OperatorRepliesView'
import { OperatorRepliesSkeleton } from './components/OperatorRepliesSkeleton'
import { logger } from '@/lib/logger'

async function loadAllReplies(orgId: string) {
  const supabase = await createClient()
  try {
    return await getAllRepliesForOrg(supabase, orgId)
  } catch (err) {
    logger.error('Failed to load operator replies', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export default async function OperatorClientRepliesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // Fetch the client org so we can show their name
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', id)
    .single()

  if (!org) {
    redirect('/dashboard/operator')
  }

  const replies = await loadAllReplies(id)

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title={`Replies — ${org.name}`}
        subtitle="All reply activity, all intents"
        userEmail={user.email}
      />
      <Suspense fallback={<OperatorRepliesSkeleton />}>
        <OperatorRepliesView replies={replies} clientName={org.name} />
      </Suspense>
    </>
  )
}
