import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorSidebar } from '@/components/dashboard/OperatorSidebar'

export default async function OperatorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  // ── 1. Authenticated ──────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role — checked on every request, not just at login ─────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // ── 3. Fetch all client organisations for the sidebar and views ────────────
  const { data: clients } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked')
    .order('name')

  return (
    <div className="flex min-h-screen bg-surface-shell">
      {/*
        OperatorSidebar uses useSearchParams() to track the selected client in the URL.
        Suspense is required by Next.js App Router whenever useSearchParams is used in
        a client component that lives inside a server layout.
      */}
      <Suspense fallback={
        <aside className="w-[210px] min-h-screen bg-brand-green-operator shrink-0" />
      }>
        <OperatorSidebar clients={clients ?? []} />
      </Suspense>
      <div className="flex-1 flex flex-col min-w-0">
        {children}
      </div>
    </div>
  )
}
