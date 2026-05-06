import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { TriageQueue } from './components/TriageQueue'
import { DraftCardSkeleton } from './components/DraftCardSkeleton'

export default async function TriagePage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Belt-and-braces role check — layout already verifies, but every operator page
  // does its own check per CLAUDE.md security requirements.
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Reply queue"
        subtitle="Replies awaiting your action"
        userEmail={user.email}
      />
      <WarningsRail />
      <Suspense
        fallback={
          <div className="flex flex-col gap-4 px-7 py-6">
            <DraftCardSkeleton />
            <DraftCardSkeleton />
          </div>
        }
      >
        <TriageQueue />
      </Suspense>
    </>
  )
}
