import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { PipelineOverview } from './components/PipelineOverview'
import { SOURCING_MAX_BATCH_SIZE } from '@/lib/operator/sourcing-entry'
import { getSourcingMetrics } from '@/lib/operator/sourcing-metrics'
import type { Database } from '@/types/database'

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

  // ── Service client, for the two tables the session cannot read ─────────────
  //
  // ADR-027. Created only after the operator gate above. getSourcingMetrics reaches
  // job_queue and system_flags for the research verdict, and both have RLS on with zero
  // policies and no authenticated grant, so a session client cannot read them at all.
  const serviceClient = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // ── 3. Every number on this screen, from ONE function ─────────────────────
  //
  // getSourcingMetrics is the same function the poll route calls, so a first paint and a
  // refresh thirty seconds later cannot disagree, and no predicate is written twice.
  const metrics = await getSourcingMetrics(serviceClient)

  if (metrics.length === 0) {
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

  const approvalMessage = approvedParam
    ? `. ${approvedParam} prospect${approvedParam !== '1' ? 's' : ''} approved, ready to enrich`
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
          <PipelineOverview
            metrics={metrics}
            selectedClientId={clientParam}
            sourcingMaxBatchSize={SOURCING_MAX_BATCH_SIZE}
          />
        </div>
      </div>
    </>
  )
}
