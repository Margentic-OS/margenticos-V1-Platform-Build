import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getClientVisibleReplies } from '@/lib/reply-handling/get-client-visible-replies'
import { ClientRepliesView } from './components/ClientRepliesView'
import { ClientRepliesSkeleton } from './components/ClientRepliesSkeleton'

async function loadClientReplies(orgId: string) {
  const supabase = await createClient()
  try {
    return await getClientVisibleReplies(supabase, orgId)
  } catch (err) {
    console.error('Failed to load client replies:', err)
    return []
  }
}

export default async function ClientRepliesPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('organisation_id, role')
    .eq('id', user.id)
    .single()

  if (!userRow?.organisation_id) redirect('/login')
  if (userRow.role === 'operator') redirect('/dashboard/operator')

  const replies = await loadClientReplies(userRow.organisation_id)

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="px-7 py-6">
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-widest text-secondary-text mb-2">
            Results
          </p>
          <h1 className="text-[18px] font-medium text-primary-text">
            Replies from prospects
          </h1>
          <p className="text-[12px] text-secondary-text mt-1">
            Interested prospects reaching out
          </p>
        </div>

        <Suspense fallback={<ClientRepliesSkeleton />}>
          <ClientRepliesView replies={replies} />
        </Suspense>
      </div>
    </div>
  )
}
