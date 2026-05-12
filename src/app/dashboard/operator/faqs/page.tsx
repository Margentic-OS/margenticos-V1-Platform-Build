// /dashboard/operator/faqs?client=<orgId>
//
// Operator-only. Two-panel FAQ curation surface:
//   Left: pending faq_extractions (extraction queue, 30s polling)
//   Right: approved/archived FAQs for the selected client (knowledge base)
//
// searchParams.client is the selected org ID — set by the sidebar client picker.
// Falls back to the first organisation if none selected.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { FaqCurationView } from './components/FaqCurationView'
import { ExtractionCardSkeleton } from './components/ExtractionCardSkeleton'
import { Suspense } from 'react'

export default async function FaqCurationPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()

  // ── Auth — belt-and-braces, layout already checks ────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // ── Resolve selected client org ───────────────────────────────────────────────
  const { client: clientParam } = await searchParams

  // Load all orgs to resolve a default when no client param is present.
  const { data: orgs } = await supabase
    .from('organisations')
    .select('id, name')
    .order('name')

  const orgList = orgs ?? []

  const selectedOrg = clientParam
    ? orgList.find(o => o.id === clientParam) ?? orgList[0] ?? null
    : orgList[0] ?? null

  if (!selectedOrg) {
    // No organisations exist yet.
    return (
      <>
        <OperatorTopbar
          eyebrow="Operator view"
          title="FAQ curation"
          subtitle="No clients yet"
          userEmail={user.email}
        />
        <div className="px-7 py-6">
          <div className="bg-surface-card border border-border-card rounded-[10px] px-5 py-8 text-center max-w-md">
            <p className="text-[13px] font-medium text-text-primary mb-1">No clients found</p>
            <p className="text-[12px] text-text-secondary">
              Add a client organisation before using FAQ curation.
            </p>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view — FAQ curation"
        title={selectedOrg.name}
        subtitle="Extraction queue and knowledge base"
        userEmail={user.email}
      />
      <Suspense
        fallback={
          <div className="flex flex-col gap-4 px-7 py-6">
            <ExtractionCardSkeleton />
            <ExtractionCardSkeleton />
          </div>
        }
      >
        <FaqCurationView orgId={selectedOrg.id} orgName={selectedOrg.name} />
      </Suspense>
    </>
  )
}
