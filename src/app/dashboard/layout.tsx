import { Suspense } from 'react'
import Link from 'next/link'
import { headers, cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/Sidebar'
import type { DashboardState } from '@/components/dashboard/Sidebar'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'

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
  const headersList = await headers()
  const cookieStore = await cookies()
  const pathname = headersList.get('x-pathname') ?? ''
  const isOperatorRoute = pathname.startsWith('/dashboard/operator')

  // Operator routes have their own layout — pass children through untouched.
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

  // Read view-as-client from cookie set by middleware. The role check inside
  // resolveViewingOrg determines whether it is ever acted upon.
  const clientParam = cookieStore.get('view-as-client')?.value || undefined

  // Single call that both resolves the correct org_id AND surfaces the role.
  // cache() ensures the layout and all pages sharing this request share one DB
  // round-trip — they must call the same function with the same args.
  const { viewingOrgId, isOperator } = await resolveViewingOrg(user.id, clientParam)

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked')
    .eq('id', viewingOrgId)
    .single()

  const dashboardState = org
    ? await resolveDashboardState(org.id)
    : 'intake_incomplete'

  // True when the operator is actively viewing a different org (not their own).
  const isViewingAsClient = isOperator && !!clientParam

  return (
    <div className="flex min-h-screen bg-surface-shell">
      {/*
        Sidebar uses useSearchParams() to preserve ?client= through nav link clicks.
        Suspense is required by Next.js App Router for client components that call
        useSearchParams inside a server layout.
      */}
      <Suspense fallback={
        <aside className="w-[210px] min-h-screen bg-brand-green shrink-0" />
      }>
        <Sidebar
          orgName={org?.name ?? ''}
          pipelineUnlocked={org?.pipeline_unlocked ?? false}
          dashboardState={dashboardState}
        />
      </Suspense>
      <div className="flex-1 flex flex-col min-w-0">
        {/* Banner shown only when an operator is on a genuine client route. */}
        {isOperator && (
          <div className="flex items-center justify-between px-7 py-2 bg-[#FEF7E6] border-b border-[#F0D080] shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
              <span className="text-[11px] text-[#7A4800]">
                {isViewingAsClient && org?.name
                  ? `Viewing as ${org.name}`
                  : 'You are viewing the client experience'}
              </span>
            </div>
            <Link
              href={isViewingAsClient && clientParam
                ? `/dashboard/operator?client=${clientParam}`
                : '/dashboard/operator'}
              className="text-[11px] font-medium text-[#7A4800] hover:underline"
            >
              Return to operator view →
            </Link>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
