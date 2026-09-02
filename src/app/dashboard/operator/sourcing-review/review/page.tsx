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

  // ── 5. Fetch enriched prospects (all tiers) ────────────────────────────────
  const { data: allProspects } = await supabase
    .from('prospects')
    .select('*')
    .eq('organisation_id', organisationId)
    .eq('enrichment_status', 'enriched')
    .not('sourced_tier', 'is', null)
    .order('sourced_tier', { ascending: true })
    .order('created_at', { ascending: false })

  const prospects = (allProspects || []) as Prospect[]
  const tier1 = prospects.filter(p => p.sourced_tier === 'tier_1')
  const tier2 = prospects.filter(p => p.sourced_tier === 'tier_2')
  const tier3 = prospects.filter(p => p.sourced_tier === 'tier_3')

  // ── 6. Fetch the prospects tiering REMOVED ─────────────────────────────────
  //
  // The query above ends `.not('sourced_tier', 'is', null)`, so until now this
  // screen could only ever show survivors. An operator looking at 12 tier-1 rows
  // had no way to tell whether the batch was 12 prospects or 200, and no way at
  // all to see that 47 of them went in industry_not_consulting.
  //
  // `sourced_tier IS NULL` alone does not mean removed: it is also every prospect
  // that has not been through tiering yet. tiering_reason is what separates them,
  // because classifyTier writes one on every path and nothing else sets it.
  const { data: removedRows } = await supabase
    .from('prospects')
    .select('tiering_reason')
    .eq('organisation_id', organisationId)
    .eq('enrichment_status', 'enriched')
    .is('sourced_tier', null)
    .not('tiering_reason', 'is', null)

  // Counted here, on the server, because the reason is all this screen needs and
  // shipping whole prospect rows to the browser to count them would be wasteful.
  const removedByReason = (removedRows ?? []).reduce<Record<string, number>>((acc, row) => {
    const reason = row.tiering_reason ?? 'unknown'
    acc[reason] = (acc[reason] ?? 0) + 1
    return acc
  }, {})

  const removedCount = removedRows?.length ?? 0

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Check quality and publish"
        subtitle={
          removedCount > 0
            ? `${tier1.length + tier2.length + tier3.length} enriched prospects, ${removedCount} removed`
            : `${tier1.length + tier2.length + tier3.length} enriched prospects`
        }
        userEmail={user.email}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1200px]">
          <Gate2TieredReview
            prospects={prospects}
            organisationId={organisationId}
            organisationName={org.name}
            tiering={{
              tier_1: tier1,
              tier_2: tier2,
              tier_3: tier3,
            }}
            removedByReason={removedByReason}
            removedCount={removedCount}
          />
        </div>
      </div>
    </>
  )
}
