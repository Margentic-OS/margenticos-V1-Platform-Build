// ═════════════════════════════════════════════════════════════════════════════
// maxDuration governs the SERVER ACTIONS invoked from this page, not just the render.
//
// handleUploadLeads lives in ./actions.ts and is the longest-running thing this project
// does inside a request: it runs the pre-gate, claims, composes every approved prospect,
// re-checks suppression, and uploads to the outbound provider. It had no explicit
// duration anywhere on its path, so it inherited whatever the platform default happened
// to be. Every other long route in this repo declares 300 and this one did not, which was
// an oversight rather than a decision.
//
// 300 is the Hobby maximum and this repo's convention. Measured 2026-08-24 against 300
// synthetic prospects in an archived org with mock dispatch: the whole path took 11.6
// seconds, so this is a stated ceiling with 25x headroom rather than a limit anything is
// near. It exists so the ceiling is a decision on the record instead of a platform
// default that can change underneath us.
export const maxDuration = 300

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { applySendGate } from '@/lib/sourcing/send-gate'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WaitingOnYouBlock } from './WaitingOnYouBlock'
import { ClientProfileBlock } from './ClientProfileBlock'
import { SetupStatusPanel } from './SetupStatusPanel'
import { CampaignRegistrationPanel } from './CampaignRegistrationPanel'
import { LeadUploadPanel } from './LeadUploadPanel'
import { MailboxOrderPanel } from './MailboxOrderPanel'
import { WarmupControlPanel } from './WarmupControlPanel'
import { CampaignMetricsPanel } from '@/components/dashboard/operator/CampaignMetricsPanel'
import { deriveCampaignsStatus } from '@/lib/dashboard/derive-setup-status'
import { getAllCampaignMetricsForOrg } from '@/lib/metrics/get-client-visible-campaign-metrics'
import type { SetupStatusShape } from './SetupStatusPanel'
import type { SetupStatusValue } from './actions'

function parseSetupStatus(raw: unknown): SetupStatusShape {
  const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const valid = (v: unknown): v is SetupStatusValue =>
    v === 'pending' || v === 'in_progress' || v === 'complete'
  return {
    campaigns: valid(obj.campaigns) ? obj.campaigns : 'pending',
    linkedin: valid(obj.linkedin) ? obj.linkedin : 'pending',
  }
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role — checked on every request, not just at login ─────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') notFound()

  // ── 3. Fetch org — notFound() for both non-operator and missing org (no info leak) ──
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, founder_first_name, setup_status, warmup_started_at, warmup_completed_at, created_at')
    .eq('id', id)
    .maybeSingle()

  if (!org) notFound()

  const setupStatus = parseSetupStatus(org.setup_status)

  // Service-role client for operator queries that must bypass RLS function restrictions
  const serviceRole = await createServiceRoleClient()

  // Fetch all required data in parallel
  const [
    flagResult,
    pendingCountResult,
    campaignsResult,
    uploadedCountResult,
    primarySegResult,
    clientUserResult,
    strategyDocsResult,
    pendingSuggestionsResult,
    intakeWebsiteResult,
    intakeRevenueResult,
    campaignMetrics,
  ] = await Promise.all([
    supabase
      .from('integrations_registry')
      .select('is_active')
      .eq('capability', 'instantly_api_active')
      .eq('tool_name', 'instantly')
      .maybeSingle(),
    // The operator's "ready to send" count. Uses the SAME predicate the claim uses, from
    // src/lib/sourcing/send-gate.ts, because a count that disagrees with the claim is a
    // number the operator has no way to check.
    applySendGate(
      serviceRole.from('prospects').select('id', { count: 'exact', head: true }),
      org.id,
    ),
    supabase
      .from('campaigns')
      .select('id, external_id, name, shell_synced_at, shell_step_count, status, started_at, paused_at')
      .eq('organisation_id', org.id)
      .order('created_at', { ascending: true }),
    serviceRole
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .not('campaign_id', 'is', null)
      .neq('outbound_upload_status', 'pending'),
    supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', org.id)
      .eq('is_default', true)
      .maybeSingle(),
    supabase
      .from('users')
      .select('email, last_seen_at')
      .eq('organisation_id', org.id)
      .maybeSingle(),
    supabase
      .from('strategy_documents')
      .select('document_type, status, version, last_updated_at')
      .eq('organisation_id', org.id)
      .eq('status', 'active')
      .order('document_type', { ascending: true }),
    supabase
      .from('document_suggestions')
      .select('id, document_type, field_path, suggested_value, organisations(name)')
      .eq('organisation_id', org.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supabase
      .from('intake_responses')
      .select('response_value')
      .eq('organisation_id', org.id)
      .eq('field_key', 'company_website')
      .maybeSingle(),
    supabase
      .from('intake_responses')
      .select('response_value')
      .eq('organisation_id', org.id)
      .eq('field_key', 'company_revenue_range')
      .maybeSingle(),
    // serviceRole, not supabase. getAllCampaignMetricsForOrg declares a service-role
    // client and was handed the SSR session client, with the correct client already in
    // scope four lines up. It returned the right numbers only because the operator RLS
    // policies on campaigns, meetings and reply_handling_actions happen to be permissive
    // (verified live). Tighten any of those three and this page would have started
    // showing zeros with no error. Found by the ServiceRoleClient brand, 2026-08-29.
    getAllCampaignMetricsForOrg(serviceRole, org.id),
  ])

  const instantlyApiActive = flagResult.data?.is_active ?? false
  const pendingCount = pendingCountResult.count ?? 0
  const campaigns = (campaignsResult.data ?? [])
    .filter(c => c.external_id !== null)
    .map(c => ({
      internalId: c.id,
      externalId: c.external_id as string,
      name: c.name,
      shellSyncedAt: c.shell_synced_at,
      shellStepCount: c.shell_step_count,
    }))
  const uploadedCount = uploadedCountResult.count ?? 0
  const primarySegmentId = primarySegResult.data?.id ?? null
  const clientUser = clientUserResult.data
  const website = intakeWebsiteResult.data?.response_value ?? undefined
  const revenueRange = intakeRevenueResult.data?.response_value ?? undefined

  const derivedCampaignsStatus: SetupStatusValue = deriveCampaignsStatus(
    campaigns.map(c => ({ shell_synced_at: c.shellSyncedAt })),
    uploadedCount
  )

  // Build "Waiting on you" items
  const waitingItems = []
  const suggestions = pendingSuggestionsResult.data ?? []
  if (suggestions.length > 0) {
    waitingItems.push({
      type: 'suggestion' as const,
      id: 'suggestions',
      title: `${suggestions.length} document suggestion${suggestions.length === 1 ? '' : 's'}`,
      description: suggestions.slice(0, 2).map(s => `${s.document_type}: ${s.field_path}`).join(', '),
      href: `/dashboard/operator/approvals?client=${org.id}`,
    })
  }

  // Format strategy documents
  const documents = (strategyDocsResult.data ?? []).map(doc => ({
    type: doc.document_type,
    status: doc.status,
    version: doc.version,
    lastUpdated: doc.last_updated_at,
  }))

  // Get campaign status
  const liveOrActiveCampaigns = (campaignsResult.data ?? [])
    .filter(c => c.external_id !== null && (c.status === 'active' || c.started_at))
  const campaignState = liveOrActiveCampaigns.length > 0 ? {
    count: liveOrActiveCampaigns.length,
    status: liveOrActiveCampaigns.some(c => c.paused_at) ? 'paused' as const : 'active' as const,
  } : undefined

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title={org.name}
        userEmail={user.email}
        action={
          <Link
            href={`/dashboard/operator/approvals?client=${org.id}`}
            className="text-[11px] font-medium text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-1.5 rounded-[6px] transition-colors"
          >
            View approvals
          </Link>
        }
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <Link
            href="/dashboard/operator"
            className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary transition-colors mb-6"
          >
            ← Return to operator view
          </Link>

          <div className="space-y-6">
            {/* OPS-1: Two-block client detail view */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">
              <WaitingOnYouBlock items={waitingItems} />

              <ClientProfileBlock
                orgName={org.name}
                founderName={org.founder_first_name ?? undefined}
                clientEmail={clientUser?.email}
                website={website}
                revenueRange={revenueRange}
                documents={documents}
                campaignState={campaignState}
                warmupState={{
                  started: org.warmup_started_at !== null,
                  startedAt: org.warmup_started_at ?? undefined,
                }}
                dispatchMode="live"
                lastLoginAt={clientUser?.last_seen_at ?? undefined}
                onboardedAt={org.created_at}
                intakeUrl={`/dashboard/operator/clients/${org.id}/intake`}
                missingFields={[]}
              />
            </div>

            {/* Legacy setup panels */}
            <div className="space-y-4">
              <CampaignMetricsPanel metrics={campaignMetrics} />

              <SetupStatusPanel orgId={org.id} initialStatus={setupStatus} derivedCampaignsStatus={derivedCampaignsStatus} />

              <CampaignRegistrationPanel orgId={org.id} />

              <LeadUploadPanel
                orgId={org.id}
                instantlyApiActive={instantlyApiActive}
                pendingCount={pendingCount}
                primarySegmentId={primarySegmentId}
                campaigns={campaigns}
              />

              <MailboxOrderPanel
                orgId={org.id}
                instantlyApiActive={instantlyApiActive}
              />

              <WarmupControlPanel
                orgId={org.id}
                warmupStartedAt={org.warmup_started_at ?? null}
                warmupCompletedAt={org.warmup_completed_at ?? null}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
