import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { BenchmarksView } from '@/components/dashboard/benchmarks/BenchmarksView'
import { computeCampaignMetrics } from '@/lib/metrics/campaign-metrics'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

export default async function BenchmarksPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Await searchParams before access — required in Next.js 15 (searchParams is a Promise).
  const { client: clientParam } = await searchParams

  const { viewingOrgId } = await resolveViewingOrg(user.id, clientParam)

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, engagement_month')
    .eq('id', viewingOrgId)
    .single()

  if (!org) redirect('/dashboard')

  const metrics = await computeCampaignMetrics(org.id, supabase)

  return (
    <>
      <DashboardTopbar
        eyebrow={`Month ${org.engagement_month}`}
        title={org.name}
        subtitle="Benchmarks"
        statusLabel="Campaigns live"
        statusVariant="live"
        orgInitials={getOrgInitials(org.name)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <BenchmarksView metrics={metrics} />
        </div>
      </div>
    </>
  )
}
