import { Suspense } from 'react'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/Sidebar'
import type { DashboardState } from '@/components/dashboard/Sidebar'
import { OperatorViewingBanner } from '@/components/dashboard/OperatorViewingBanner'

async function resolveDashboardState(orgId: string): Promise<DashboardState> {
  const supabase = await createClient()

  const [{ count: totalCritical }, { count: filledCritical }, { count: activeDocs }] =
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
    ])

  const intakeComplete =
    (totalCritical ?? 0) > 0 && filledCritical === totalCritical
  const allDocsActive = (activeDocs ?? 0) >= 4

  if (!intakeComplete) return 'intake_incomplete'
  if (allDocsActive) return 'documents_active'
  return 'strategy_in_review'
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read the pathname injected by middleware so we can skip the client layout
  // for /dashboard/operator/* routes — those routes have their own layout and
  // must not inherit the client sidebar or the "viewing client experience" banner.
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') ?? ''
  const isOperatorRoute = pathname.startsWith('/dashboard/operator')

  // Operator routes have their own layout — pass children through untouched.
  // Auth is enforced by /dashboard/operator/layout.tsx for those routes.
  if (isOperatorRoute) {
    return <>{children}</>
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Check whether the current user is an operator viewing the client experience.
  // This runs only on genuine client routes (/dashboard, /dashboard/pipeline, etc.).
  const { data: userRow } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  const isOperator = userRow?.role === 'operator'

  // Fetch all orgs so the operator banner can name the client being viewed.
  // Operators have read access to all organisations via operators_full_access_organisations RLS policy.
  const allOrgs = isOperator
    ? (await supabase.from('organisations').select('id, name').order('name')).data ?? []
    : []

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked')
    .eq('id', userRow?.organisation_id ?? '')
    .single()

  const dashboardState = org
    ? await resolveDashboardState(org.id)
    : 'intake_incomplete'

  return (
    <div className="flex min-h-screen bg-surface-shell">
      <Sidebar
        orgName={org?.name ?? ''}
        pipelineUnlocked={org?.pipeline_unlocked ?? false}
        dashboardState={dashboardState}
      />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Banner shown only when an operator has clicked "View as client" and is
            on a genuine client route. Never shown on /dashboard/operator/* — those
            routes are caught by the isOperatorRoute check above and short-circuit. */}
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
