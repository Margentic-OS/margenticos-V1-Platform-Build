import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getOperatorRepliesForOrg } from '@/lib/reply-handling/get-operator-replies'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { OperatorRepliesView } from './components/OperatorRepliesView'
import { OperatorRepliesSkeleton } from './components/OperatorRepliesSkeleton'
import { logger } from '@/lib/logger'
import type { OperatorRepliesForOrg } from '@/lib/reply-handling/get-operator-replies'

const EMPTY: OperatorRepliesForOrg = { total: 0, hiddenFromClientCount: 0, groups: [] }

async function loadReplies(orgId: string): Promise<OperatorRepliesForOrg> {
  try {
    // No Supabase client is passed in. getOperatorRepliesForOrg builds its own
    // service-role client so the session client cannot be handed to it by mistake and
    // return zero rows in silence. See ADR-027 and the header of that file.
    return await getOperatorRepliesForOrg(orgId)
  } catch (err) {
    logger.error('Failed to load operator replies', {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    })
    return EMPTY
  }
}

export default async function OperatorClientRepliesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // The session client's only job here: prove who this is and that they are an operator.
  // It reads none of the reply data.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', id)
    .single()

  if (!org) {
    redirect('/dashboard/operator')
  }

  const replies = await loadReplies(id)

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title={`Replies — ${org.name}`}
        subtitle="Every reply, every intent, including the ones the client never sees"
        userEmail={user.email}
      />
      <Suspense fallback={<OperatorRepliesSkeleton />}>
        <OperatorRepliesView replies={replies} clientName={org.name} />
      </Suspense>
    </>
  )
}
