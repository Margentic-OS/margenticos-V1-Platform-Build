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
        {/*
          ONLY 'unknown' IS GLOBAL NOW, and that is the whole change.

          This used to render every state on every operator screen. `enrichment_live` is
          true in production, so it was a permanent red banner warning about the normal
          working state of the system. A red banner that is always there, that nobody can
          act on, and that is correct every single time, teaches an operator to stop
          reading red. It spends the alarm on the state that needs no alarm.

          'live' and 'test' moved to the point where credits are about to be spent, where
          they are a fact about the button being pressed rather than wallpaper. See
          EnrichmentSpendNotice.

          'unknown' STAYS GLOBAL and stays loud, because it is the opposite kind of thing:
          it means the flag could not be read at all, so nobody knows whether enrichment is
          spending. It is rare rather than permanent, which is exactly what keeps it worth
          reading, and it is the state the banner was rewritten for after it once failed
          into a false "Test Mode Active" while the flag was live.
        */}
        {enrichmentMode === 'unknown' && (
          <div className="p-4 border-b bg-white">
            <EnrichmentModeBanner mode={enrichmentMode} />
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
