import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { PipelineOverview } from './components/PipelineOverview'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'

export default async function SourcingReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; approved?: string }>
}) {
  const supabase = await createClient()
  const { client: clientParam, approved: approvedParam } = await searchParams

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role ───────────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // ── 3. Fetch all organisations for the operator ────────────────────────────
  const { data: orgs } = await supabase
    .from('organisations')
    .select('id, name')
    .order('name')

  if (!orgs || orgs.length === 0) {
    return (
      <>
        <OperatorTopbar
          eyebrow="Operator view"
          title="Pipeline review"
          userEmail={user.email}
        />
        <div className="flex-1 overflow-y-auto bg-surface-content">
          <div className="px-7 py-6 max-w-[1040px]">
            <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
              <p className="text-sm text-[#7A4800]">No clients available.</p>
            </div>
          </div>
        </div>
      </>
    )
  }

  // ── 4. Fetch pipeline metrics for each organisation ────────────────────────
  const metrics = await Promise.all(
    orgs.map(async (org) => {
      const result = await supabase
        .from('prospects')
        .select('id, sourcing_review_status, enrichment_status, sourced_tier', { count: 'exact' })
        .eq('organisation_id', org.id)

      if (!result.data) {
        return {
          organisation_id: org.id,
          organisation_name: org.name,
          pending_review_count: 0,
          approved_unenriched_count: 0,
          tier_1_count: 0,
          tier_2_count: 0,
          tier_3_count: 0,
          enriched_untiered_count: 0,
        }
      }

      const prospects = result.data
      const pending = prospects.filter(p => p.sourcing_review_status === 'pending_review').length
      const approvedUnenriched = prospects.filter(
        p => p.sourcing_review_status === 'approved' && p.enrichment_status === null
      ).length
      const tier1 = prospects.filter(p => p.sourced_tier === 'tier_1').length
      const tier2 = prospects.filter(p => p.sourced_tier === 'tier_2').length
      const tier3 = prospects.filter(p => p.sourced_tier === 'tier_3').length
      const enrichedUntiered = prospects.filter(
        p => p.enrichment_status === 'enriched' && p.sourced_tier === null
      ).length

      return {
        organisation_id: org.id,
        organisation_name: org.name,
        pending_review_count: pending,
        approved_unenriched_count: approvedUnenriched,
        tier_1_count: tier1,
        tier_2_count: tier2,
        tier_3_count: tier3,
        enriched_untiered_count: enrichedUntiered,
      }
    })
  )

  const approvalMessage = approvedParam
    ? ` — ${approvedParam} prospect${approvedParam !== '1' ? 's' : ''} approved, ready to enrich`
    : ''

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Pipeline review"
        subtitle={approvalMessage || undefined}
        userEmail={user.email}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <PipelineOverview metrics={metrics} selectedClientId={clientParam} />
        </div>
      </div>
    </>
  )
}
