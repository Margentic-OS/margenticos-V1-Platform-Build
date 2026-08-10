import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { getClientProspectTiers } from '@/lib/prospect-tiers-data'
import type { TierData } from '@/lib/prospect-tiers-data'
import { ProspectReviewClient } from './components/ProspectReviewClient'
import { logger } from '@/lib/logger'

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

export default async function ProspectTiersPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/prospect-tiers')

  const { organisationId } = await resolveViewingOrg(supabase, user, undefined)

  if (!organisationId) {
    redirect('/login')
  }

  // Fetch organisation name
  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', organisationId)
    .single()

  const organisationName = org?.name || 'Organisation'

  // Fetch tier data directly (no HTTP, no fetch)
  let tierData: TierData[] = []
  let fetchError: string | null = null
  try {
    tierData = await getClientProspectTiers(supabase)
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
    logger.error('prospect-tiers page: failed to fetch tier data', {
      organisation_id: organisationId,
      error: fetchError,
    })
  }

  // Filter to tiers with prospects
  const nonEmptyTiers = tierData.filter(t => t.total_count > 0)
  const allProspects = nonEmptyTiers.flatMap(t => t.prospects.map(p => ({ ...p, tier: t.tier })))
  const pendingProspects = allProspects.filter(p => p.client_review_status === null || p.client_review_status === 'pending_review')
  const autoSanctionDate = nonEmptyTiers.length > 0 ? nonEmptyTiers[0].auto_sanction_at : null

  return (
    <>
      <DashboardTopbar
        eyebrow="Ready to deploy"
        title="Review prospects"
        subtitle={organisationName}
        statusLabel="Waiting for approval"
        statusVariant="setup"
        orgInitials={getOrgInitials(organisationName)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1400px]">
          {fetchError ? (
            <div className="bg-[#FDEEE8] rounded-[10px] border border-[#EFBCAA] p-6">
              <p className="text-sm text-[#8B2020] font-medium mb-2">Unable to load prospects</p>
              <p className="text-xs text-[#8B2020] mb-3">We could not load your prospects. Please refresh the page or contact support if the problem persists.</p>
              <p className="text-xs text-[#8B2020] font-mono bg-[#FFF0E8] p-2 rounded break-all">{fetchError}</p>
            </div>
          ) : allProspects.length === 0 ? (
            <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
              <p className="text-sm text-[#7A4800]">No prospects awaiting your review.</p>
            </div>
          ) : (
            <ProspectReviewClient
              prospects={allProspects}
              pendingCount={pendingProspects.length}
              autoSanctionDate={autoSanctionDate}
              organisationId={organisationId}
            />
          )}
        </div>
      </div>
    </>
  )
}
