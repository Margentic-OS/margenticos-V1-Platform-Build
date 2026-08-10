import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { TierCard } from './components/TierCard'
import { logger } from '@/lib/logger'

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

interface TierData {
  tier: 'tier_1' | 'tier_2' | 'tier_3'
  tier_created_at: string | null
  total_count: number
  rejected_count: number
  sample_prospects: Array<{
    id: string
    first_name: string | null
    last_name: string | null
    company_name: string | null
    role: string | null
    personalisation_trigger: string | null
    client_review_status: string | null
  }>
  tier_sanction_status: 'pending_review' | 'sanctioned_by_client' | 'sanctioned_auto' | 'partially_rejected'
  is_auto_sanctioned: boolean
  is_auto_sanctioned_now: boolean
  auto_sanction_at: string
  tier_is_locked: boolean
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

  // Fetch tier data from API route
  let tierData: TierData[] = []
  try {
    const baseUrl = process.env.NEXT_PUBLIC_VERCEL_URL
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
      : 'http://localhost:3000'

    const response = await fetch(`${baseUrl}/api/dashboard/client/prospect-tiers`, {
      headers: {
        Cookie: (await import('next/headers')).cookies().toString(),
      },
    })

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`)
    }

    const json = await response.json()
    tierData = json.tiers ?? []
  } catch (err) {
    logger.error('prospect-tiers page: failed to fetch tier data', {
      organisation_id: organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Filter to non-empty tiers
  const nonEmptyTiers = tierData.filter(t => t.total_count > 0)

  const tierLabels = {
    tier_1: 'Tier 1 (Best Matches)',
    tier_2: 'Tier 2 (Good Fits)',
    tier_3: 'Tier 3 (Secondary Prospects)',
  }

  return (
    <>
      <DashboardTopbar
        eyebrow="Ready to deploy"
        title={`Review prospects`}
        subtitle={organisationName}
        statusLabel="Waiting for approval"
        statusVariant="setup"
        orgInitials={getOrgInitials(organisationName)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1200px]">
          {nonEmptyTiers.length === 0 ? (
            <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
              <p className="text-sm text-[#7A4800]">No prospects awaiting your review.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {nonEmptyTiers.map(tier => (
                <TierCard
                  key={tier.tier}
                  tier={tier}
                  tierLabel={tierLabels[tier.tier]}
                  organisationId={organisationId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
