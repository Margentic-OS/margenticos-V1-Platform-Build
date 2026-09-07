import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/Sidebar'
import type { DashboardState } from '@/components/dashboard/Sidebar'
import { OperatorViewingBanner } from '@/components/dashboard/OperatorViewingBanner'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getProspectNavCounts } from '@/lib/dashboard/prospect-nav-counts'
import { deriveStrategyNavState } from '@/lib/dashboard/strategy-nav-state'
import type { StrategyNavState } from '@/lib/dashboard/strategy-nav-state'

async function resolveDashboardState(
  orgId: string
): Promise<{
  state: DashboardState
  pendingProspectsCount: number
  rosterProspectsCount: number
  outreachStarted: boolean
  strategyNav: StrategyNavState
}> {
  const supabase = await createClient()

  // PROSPECTS IS NOT READABLE BY A CLIENT SESSION. The RLS policy
  // clients_read_own_prospects_denied has USING (false), so every SELECT a client session
  // makes against this table returns zero rows AND NO ERROR. Counting through it does not
  // fail, it silently answers 0, which is why the Prospects nav entry has never once
  // appeared for a real client login.
  //
  // Same trap the comment in (client)/page.tsx already records for reply_handling_actions.
  // The fix there was a service-role client; this is the same fix for the same reason.
  // The counts come from one shared module so the layout and the nav-counts route cannot
  // drift. See prospect-nav-counts.ts for why the route exists at all.
  const prospectReader = await createServiceRoleClient()
  const navCountsPromise = getProspectNavCounts(prospectReader, orgId)

  const [
    { count: totalCritical },
    { count: filledCritical },
    { count: activeDocs },
    navCounts,
    campaignsResult,
    strategyDocsResult,
    pendingSuggestionsResult,
  ] =
    await Promise.all([
      supabase
        .from('intake_responses')
        .select('*', { count: 'exact', head: true })
        .eq('organisation_id', orgId)
        .eq('is_critical', true),
      supabase
        .from('intake_responses')
        .select('*', { count: 'exact', head: true })
        .eq('organisation_id', orgId)
        .eq('is_critical', true)
        .not('response_value', 'is', null)
        .neq('response_value', ''),
      supabase
        .from('strategy_documents')
        .select('*', { count: 'exact', head: true })
        .eq('organisation_id', orgId)
        .in('status', ['approved', 'active']),
      navCountsPromise,
    // campaigns is one of the few tables a client session CAN read
      // (clients_read_own_campaigns), so the session client is correct here.
      supabase
        .from('campaigns')
        .select('sent_count')
        .eq('organisation_id', orgId),
      // Same filter assertStrategyApproved uses, so the sidebar and the upload gate are
      // reading the same set of documents. Both tables are readable by a client session
      // (clients_read_own_active_strategy_docs, clients_read_own_document_suggestions).
      supabase
        .from('strategy_documents')
        .select('document_type')
        .eq('organisation_id', orgId)
        .in('status', ['active', 'approved']),
      supabase
        .from('document_suggestions')
        .select('document_type')
        .eq('organisation_id', orgId)
        .eq('status', 'pending'),
    ])

  const intakeComplete =
    (totalCritical ?? 0) > 0 && filledCritical === totalCritical
  const allDocsActive = (activeDocs ?? 0) >= 4

  let state: DashboardState
  if (!intakeComplete) state = 'intake_incomplete'
  else if (allDocsActive) state = 'documents_active'
  else state = 'strategy_in_review'

  // One email is the whole test. The setup checklist in the sidebar cannot answer
  // "are campaigns live" from state alone, because documents_active covers both the day
  // the documents were approved and six weeks later with a sequence running.
  const outreachStarted = (campaignsResult.data ?? []).some(c => (c.sent_count ?? 0) > 0)

  const strategyNav = deriveStrategyNavState(
    strategyDocsResult.data ?? [],
    (pendingSuggestionsResult.data ?? []).map(r => r.document_type),
  )

  return {
    state,
    pendingProspectsCount: navCounts.pendingProspectsCount,
    rosterProspectsCount: navCounts.rosterProspectsCount,
    outreachStarted,
    strategyNav,
  }
}

export default async function ClientLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  const isOperator = userRow?.role === 'operator'

  // Fetch all orgs so the operator banner can name the client being viewed.
  // Operators have read access to all organisations via operators_full_access_organisations RLS policy.
  // Exclude archived orgs from the list.
  const allOrgs = isOperator
    ? (await supabase.from('organisations').select('id, name').is('archived_at', null).order('name')).data ?? []
    : []

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked')
    .eq('id', userRow?.organisation_id ?? '')
    .single()

  const dashboardStateResult = org
    ? await resolveDashboardState(org.id)
    : {
        state: 'intake_incomplete' as const,
        pendingProspectsCount: 0,
        rosterProspectsCount: 0,
        outreachStarted: false,
        // No org resolved means nothing is approved, so the section stays open. Erring
        // toward expanded is the safe direction: the failure mode of collapsing is a
        // hidden blocker.
        strategyNav: {
          collapsedByDefault: false,
          reason: 'blocking_upload' as const,
          needsAttention: [],
        },
      }

  return (
    <div className="flex min-h-screen bg-surface-shell">
      {/* Sidebar uses useSearchParams to resolve the org name and preserve ?client=
          in nav links when an operator is viewing a client. Suspense is required. */}
      <Suspense fallback={<aside className="w-[210px] min-h-screen bg-brand-green shrink-0" />}>
        <Sidebar
          orgName={org?.name ?? ''}
          pipelineUnlocked={org?.pipeline_unlocked ?? false}
          dashboardState={dashboardStateResult.state}
          pendingProspectsCount={dashboardStateResult.pendingProspectsCount}
          rosterProspectsCount={dashboardStateResult.rosterProspectsCount}
          outreachStarted={dashboardStateResult.outreachStarted}
          strategyNav={dashboardStateResult.strategyNav}
          allOrgs={allOrgs}
        />
      </Suspense>
      <div className="flex-1 flex flex-col min-w-0">
        {/* Banner shown only when an operator has clicked "View as client" and is
            on a genuine client route. The (client) route group guarantees we are
            never on an operator/ route here. */}
        {isOperator && (
          <Suspense fallback={
            <div className="flex items-center px-7 py-2 bg-[#FEF7E6] border-b border-[#F0D080] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0 mr-2" />
              <span className="text-[11px] text-[#7A4800]">You are viewing the client experience</span>
            </div>
          }>
            <OperatorViewingBanner clients={allOrgs} />
          </Suspense>
        )}
        {children}
      </div>
    </div>
  )
}
