import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { getClientProspectTiers } from '@/lib/prospect-tiers-data'
import type { TierData, Prospect } from '@/lib/prospect-tiers-data'
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

interface ProspectWithTier extends Prospect {
  tier: 'tier_1' | 'tier_2' | 'tier_3'
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

  // Filter to tier_1 and tier_2 only (exclude tier_3 and untiered from client view)
  const tier1Data = tierData.find(t => t.tier === 'tier_1')
  const tier2Data = tierData.find(t => t.tier === 'tier_2')

  // Combine all prospects from tier_1 and tier_2, sorted tier_1 first
  const tier1Prospects: ProspectWithTier[] = (tier1Data?.prospects ?? []).map(p => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    company_name: p.company_name,
    job_title: p.job_title,
    linkedin_url: p.linkedin_url,
    website_url: p.website_url,
    client_review_status: p.client_review_status,
    client_review_reason: p.client_review_reason,
    tier: 'tier_1',
  }))

  const tier2Prospects: ProspectWithTier[] = (tier2Data?.prospects ?? []).map(p => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    company_name: p.company_name,
    job_title: p.job_title,
    linkedin_url: p.linkedin_url,
    website_url: p.website_url,
    client_review_status: p.client_review_status,
    client_review_reason: p.client_review_reason,
    tier: 'tier_2',
  }))

  const allProspects: ProspectWithTier[] = [...tier1Prospects, ...tier2Prospects]
  const pendingProspects = allProspects.filter(p => p.client_review_status === null || p.client_review_status === 'pending_review')
  const autoSanctionDate = tierData.length > 0 ? tierData[0].auto_sanction_at : null

  // Redirect to overview if no pending prospects (review is one-time handshake)
  if (pendingProspects.length === 0) {
    redirect('/dashboard')
  }

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
