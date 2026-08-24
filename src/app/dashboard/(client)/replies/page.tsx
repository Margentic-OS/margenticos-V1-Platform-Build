import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getClientVisibleReplies } from '@/lib/reply-handling/get-client-visible-replies'
import type { ClientVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { logger } from '@/lib/logger'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { ClientRepliesView } from './components/ClientRepliesView'
import { ClientRepliesSkeleton } from './components/ClientRepliesSkeleton'

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

export default async function ClientRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Same org resolution as every other client page: a client is pinned to their own
  // organisation and ?client= is honoured only for an operator. This page used to redirect
  // operators away entirely, which meant Doug could not see what a client sees here.
  const { client: clientParam } = await searchParams
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)
  if (!organisationId) redirect('/login')

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', organisationId)
    .single()

  if (!org) redirect('/dashboard')

  // Whether anything has been sent at all, which decides what the empty state may claim.
  // campaigns is readable by a client session (clients_read_own_campaigns).
  const { data: campaignRows } = await supabase
    .from('campaigns')
    .select('sent_count')
    .eq('organisation_id', org.id)
  const outreachStarted = (campaignRows ?? []).some(c => (c.sent_count ?? 0) > 0)

  // No client is passed. The chokepoint builds its own service-role client, because
  // reply_handling_actions is operator-only under RLS and a session client reads zero rows
  // from it silently. That silence is why this page has shown every client an empty list
  // since it was written.
  let replies: ClientVisibleReply[]
  try {
    replies = await getClientVisibleReplies(org.id)
  } catch (err) {
    logger.error('Failed to load client replies', {
      organisation_id: org.id,
      error: err instanceof Error ? err.message : String(err),
    })
    replies = []
  }

  return (
    <>
      <DashboardTopbar
        eyebrow="Results"
        title={org.name}
        subtitle="Replies"
        statusLabel={`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
        statusVariant={replies.length > 0 ? 'live' : 'setup'}
        orgInitials={getOrgInitials(org.name)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[760px]">
          <p className="text-[12px] text-text-secondary leading-relaxed mb-5">
            Prospects who replied with interest, what they said, and anything sent back on
            your behalf. Replies that were not a fit, out-of-office messages, and opt-outs
            are handled for you and are not shown here.
          </p>

          <Suspense fallback={<ClientRepliesSkeleton />}>
            <ClientRepliesView replies={replies} outreachStarted={outreachStarted} />
          </Suspense>
        </div>
      </div>
    </>
  )
}
