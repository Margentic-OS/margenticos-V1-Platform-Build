import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorSidebar } from '@/components/dashboard/OperatorSidebar'
import { EnrichmentModeBanner } from '@/components/operator/enrichment-mode-banner'
import { resolveEnrichmentMode } from '@/lib/sourcing/enrichment-mode'

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
    .is('archived_at', null)
    .order('name')

  // ── 4. Enrichment mode for the banner ─────────────────────────────────────
  // Resolved here rather than inside the banner because this is where an operator
  // session exists. The banner used to fetch it itself with the anon key, which
  // cannot read integrations_registry, and swallowed the failure as "test mode".
  const enrichmentMode = await resolveEnrichmentMode(supabase)

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
        <div className="p-4 border-b bg-white">
          <EnrichmentModeBanner mode={enrichmentMode} />
        </div>
        {children}
      </div>
    </div>
  )
}
