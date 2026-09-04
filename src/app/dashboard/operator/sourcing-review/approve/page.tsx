import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { Gate1ApproveBatch } from '../components/Gate1ApproveBatch'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { APPROVAL_PAGE_SIZE } from '@/lib/operator/sourcing-metrics'

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

  // Typed as ICPFilterSpec rather than Record<string, unknown>. The cast was what let this
  // block read `spec.target_job_titles`, a field that has never existed on the spec (it is
  // `job_titles`), so the target role never rendered and nothing failed to compile. That is
  // the "type assertion that switches off the check that would have caught it" shape from
  // CLAUDE.md: the wide type made a wrong field name unremarkable.
  const icpSummary: { targetTitle?: string; headcountRange?: string } = {}
  if (icpResult.data?.icp_filter_spec) {
    const spec = icpResult.data.icp_filter_spec as unknown as ICPFilterSpec
    if (Array.isArray(spec.job_titles) && spec.job_titles.length > 0) {
      icpSummary.targetTitle = spec.job_titles.slice(0, 2).join(', ')
    }
    if (spec.company_headcount_min && spec.company_headcount_max) {
      icpSummary.headcountRange = `${spec.company_headcount_min}-${spec.company_headcount_max} employees`
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
