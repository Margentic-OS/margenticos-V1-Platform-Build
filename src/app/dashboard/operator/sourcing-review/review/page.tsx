import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { Gate2TieredReview } from '../components/Gate2TieredReview'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import type { Database } from '@/types/database'

type Prospect = Database['public']['Tables']['prospects']['Row']

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const { client: clientParam } = await searchParams

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role ───────────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') notFound()

  // ── 3. Resolve viewing org ─────────────────────────────────────────────────
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)
  if (!organisationId) notFound()

  // ── 4. Fetch organisation ──────────────────────────────────────────────────
  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', organisationId)
    .maybeSingle()

  if (!org) notFound()

  // ── 5. Fetch tiered prospects + flagged prospects ──────────────────────────
  const { data: tieredProspects } = await supabase
    .from('prospects')
    .select('*')
    .eq('organisation_id', organisationId)
    .eq('enrichment_status', 'enriched')
    .not('sourced_tier', 'is', null)
    .order('sourced_tier', { ascending: true })
    .order('created_at', { ascending: false })

  const { data: flaggedProspects } = await supabase
    .from('prospects')
    .select('*')
    .eq('organisation_id', organisationId)
    .is('sourced_tier', null)
    .eq('tiering_reason', 'industry_outside_spec')
    .order('created_at', { ascending: false })

  const prospects = (tieredProspects || []) as Prospect[]
  const flagged = (flaggedProspects || []) as Prospect[]
  const tier1 = prospects.filter(p => p.sourced_tier === 'tier_1')
  const tier2 = prospects.filter(p => p.sourced_tier === 'tier_2')
  const tier3 = prospects.filter(p => p.sourced_tier === 'tier_3')

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Quality review"
        subtitle={`${tier1.length + tier2.length + tier3.length} enriched prospects`}
        userEmail={user.email}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1200px]">
          <Gate2TieredReview
            prospects={[...prospects, ...flagged]}
            organisationId={organisationId}
            organisationName={org.name}
            tiering={{
              tier_1: tier1,
              tier_2: tier2,
              tier_3: tier3,
            }}
          />
        </div>
      </div>
    </>
  )
}
