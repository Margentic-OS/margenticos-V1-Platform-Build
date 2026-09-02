import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { Gate1ApproveBatch } from '../components/Gate1ApproveBatch'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'

/**
 * How many prospects one page of the approval table shows.
 *
 * The table used to render `prospects.slice(0, 50)` out of however many the server sent,
 * with a footer reading "Showing 50 of 100 prospects. Scroll to see more" and nowhere to
 * scroll. The other 50 were fetched, shipped to the browser and then discarded by the
 * slice. This is now a real page boundary: the server fetches exactly this many.
 */
export const APPROVAL_PAGE_SIZE = 50

export default async function ApprovePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; page?: string }>
}) {
  const supabase = await createClient()
  const { client: clientParam, page: pageParam } = await searchParams

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

  // ── 4. Fetch organisation and ICP for context ──────────────────────────────
  const [orgResult, icpResult] = await Promise.all([
    supabase
      .from('organisations')
      .select('name')
      .eq('id', organisationId)
      .maybeSingle(),
    supabase
      .from('strategy_documents')
      .select('icp_filter_spec')
      .eq('organisation_id', organisationId)
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .maybeSingle(),
  ])

  if (!orgResult.data) notFound()

  // ── 5. Fetch ONE PAGE of pending prospects, plus the true total ────────────
  //
  // The total comes from the count rather than from the length of what was fetched. Those
  // are the same number only while everything fits on one page, and the whole defect being
  // fixed here is that the screen reported the page as if it were the batch.
  const requestedPage = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1)
  const from = (requestedPage - 1) * APPROVAL_PAGE_SIZE

  const { data: prospects, count: totalPending } = await supabase
    .from('prospects')
    .select('*', { count: 'exact' })
    .eq('organisation_id', organisationId)
    .eq('sourcing_review_status', 'pending_review')
    .order('created_at', { ascending: false })
    .range(from, from + APPROVAL_PAGE_SIZE - 1)

  const icpSummary: { targetTitle?: string; revenueRange?: string } = {}
  if (icpResult.data?.icp_filter_spec) {
    const spec = icpResult.data.icp_filter_spec as Record<string, unknown>
    if (spec.target_job_titles && Array.isArray(spec.target_job_titles)) {
      icpSummary.targetTitle = (spec.target_job_titles as string[]).slice(0, 2).join(', ')
    }
    if (spec.company_headcount_min && spec.company_headcount_max) {
      icpSummary.revenueRange = `${spec.company_headcount_min}-${spec.company_headcount_max} employees`
    }
  }

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Approve pending prospects"
        subtitle={`${totalPending ?? 0} awaiting approval`}
        userEmail={user.email}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <Gate1ApproveBatch
            prospects={prospects || []}
            totalPending={totalPending ?? 0}
            page={requestedPage}
            pageSize={APPROVAL_PAGE_SIZE}
            organisationId={organisationId}
            organisationName={orgResult.data.name}
            icpSummary={icpSummary}
          />
        </div>
      </div>
    </>
  )
}
