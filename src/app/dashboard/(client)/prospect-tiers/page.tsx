import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { getClientProspectTiers } from '@/lib/prospect-tiers-data'
import type { TierData, Prospect } from '@/lib/prospect-tiers-data'
import { ProspectReviewClient } from './components/ProspectReviewClient'
import { buildRosterGroups, countPending, countRoster } from '@/lib/dashboard/prospect-roster'
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
  const withTier = (list: Prospect[], tier: ProspectWithTier['tier']): ProspectWithTier[] =>
    list.map(p => ({ ...p, tier }))

  const allProspects: ProspectWithTier[] = [
    ...withTier(tier1Data?.prospects ?? [], 'tier_1'),
    ...withTier(tier2Data?.prospects ?? [], 'tier_2'),
  ]

  // The roster decides what the client sees. It excludes only prospects the client
  // rejected, and pending prospects we cannot currently email. Everything else appears,
  // grouped by the batch it entered the campaign with.
  const groups = buildRosterGroups(allProspects)
  const pendingCount = countPending(groups)
  const rosterCount = countRoster(groups)
  const autoSanctionDate = tierData.length > 0 ? tierData[0].auto_sanction_at : null

  // NO REDIRECT WHEN NOTHING IS PENDING. This page used to send the client to /dashboard
  // once approval completed, which made the list of people being contacted on their
  // behalf unreachable. It is a permanent record now, so it stays. See Decisions Log
  // 2026-09-07, superseding the 2026-08-11 decision that hid it.

  return (
    <>
      <DashboardTopbar
        eyebrow={pendingCount > 0 ? 'Ready to deploy' : 'Your campaign'}
        title={pendingCount > 0 ? 'Review prospects' : 'Your prospects'}
        subtitle={organisationName}
        statusLabel={pendingCount > 0 ? 'Waiting for approval' : 'Approved'}
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
          ) : rosterCount === 0 ? (
            <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
              <p className="text-sm text-[#7A4800]">
                No prospects yet. They will appear here as soon as your first list is ready.
              </p>
            </div>
          ) : (
            <ProspectReviewClient
              groups={groups}
              pendingCount={pendingCount}
              rosterCount={rosterCount}
              autoSanctionDate={autoSanctionDate}
              organisationId={organisationId}
            />
          )}
        </div>
      </div>
    </>
  )
}
