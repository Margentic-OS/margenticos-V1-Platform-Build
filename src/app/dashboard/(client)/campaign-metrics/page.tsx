import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { ClientCampaignMetricsView } from '@/components/dashboard/campaign-metrics/ClientCampaignMetricsView'
import { getClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

export default async function ClientCampaignMetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { client: clientParam } = await searchParams
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked, engagement_month')
    .eq('id', organisationId ?? '')
    .single()

  if (!org) redirect('/dashboard')

  // No supabase client is passed. The chokepoint builds its own service-role client:
  // client-facing metrics read protected tables, and the session client returns zero rows
  // on those silently. See the module header.
  const metrics = await getClientVisibleCampaignMetrics(org.id)

  const statusLabel = org.pipeline_unlocked ? 'Campaigns live' : 'Warming up'
  const statusVariant = org.pipeline_unlocked ? 'live' : 'warming'

  return (
    <>
      <DashboardTopbar
        eyebrow={`Month ${org.engagement_month}`}
        title={org.name}
        subtitle="Campaign health"
        statusLabel={statusLabel}
        statusVariant={statusVariant}
        orgInitials={getOrgInitials(org.name)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <ClientCampaignMetricsView metrics={metrics} />
        </div>
      </div>
    </>
  )
}
