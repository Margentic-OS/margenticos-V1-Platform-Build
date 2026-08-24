import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import type { Database } from '@/types/database'
import { deriveCampaignsStatus } from '@/lib/dashboard/derive-setup-status'
import { deriveCampaignLiveness } from '@/lib/dashboard/campaign-liveness'
import type { CampaignLiveness } from '@/lib/dashboard/campaign-liveness'
import { getClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { IntakeIncompleteState } from '@/components/dashboard/empty-states/IntakeIncompleteState'
import { StrategyInReviewState } from '@/components/dashboard/empty-states/StrategyInReviewState'
import { DocumentsActiveState } from '@/components/dashboard/empty-states/DocumentsActiveState'
import type { IntakeSection } from '@/components/dashboard/empty-states/IntakeIncompleteState'
import type { DocumentReviewStatus } from '@/components/dashboard/empty-states/StrategyInReviewState'
import type { ActiveDocument } from '@/components/dashboard/empty-states/DocumentsActiveState'
import type { DocumentType } from '@/types'

// Maps DB section keys to human-readable labels.
// Derived from the intake form section field values.
const SECTION_LABELS: Record<string, string> = {
  company: 'About your business',
  icp: 'Your ideal client',
  competitive: 'Your competitive edge',
  approach: 'Your current approach',
  goals: 'Goals and challenges',
}

function toSectionLabel(key: string): string {
  return SECTION_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

type DashboardState = 'intake_incomplete' | 'strategy_in_review' | 'documents_active'

type StrategyReviewSubstate = 'generating' | 'team_reviewing'

function buildTopbarProps(
  orgName: string,
  state: DashboardState,
  liveness: CampaignLiveness,
  outreachStarted: boolean,
): {
  eyebrow: string
  title: string
  subtitle: string
  statusLabel: string
  statusVariant: 'setup' | 'warming' | 'live'
  orgInitials: string
} {
  const orgInitials = getOrgInitials(orgName)

  if (state === 'intake_incomplete') {
    return {
      eyebrow: 'Getting started',
      title: orgName,
      subtitle: 'Complete your intake to begin',
      statusLabel: 'Setting up',
      statusVariant: 'setup',
      orgInitials,
    }
  }

  if (state === 'strategy_in_review') {
    return {
      eyebrow: 'Getting started',
      title: orgName,
      subtitle: 'Building your strategy documents',
      statusLabel: 'Setting up',
      statusVariant: 'setup',
      orgInitials,
    }
  }

  // Once mail is in the field, "Ready to deploy / Campaigns warming up" is simply false.
  // The topbar carries the same verdict the hero card does, from the same derivation, so
  // the two can never contradict each other on the same screen.
  if (outreachStarted) {
    return {
      eyebrow: 'Outreach',
      title: orgName,
      subtitle: liveness.label,
      statusLabel: liveness.verdict === 'sending' ? 'Campaigns live' : liveness.label,
      statusVariant: liveness.verdict === 'sending' ? 'live' : 'warming',
      orgInitials,
    }
  }

  return {
    eyebrow: 'Ready to deploy',
    title: orgName,
    subtitle: 'Campaigns warming up',
    statusLabel: 'Warming up',
    statusVariant: 'warming',
    orgInitials,
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { client: clientParam } = await searchParams
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)

  // Fetch org
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, contract_start_date, warmup_started_at, linkedin_channel_enabled, pipeline_unlocked, setup_status')
    .eq('id', organisationId ?? '')
    .single()

  if (!org) {
    // Authenticated user with no organisation — show minimal placeholder
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-content">
        <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-sm w-full">
          <p className="text-[13px] font-medium text-text-primary mb-1">
            No organisation found
          </p>
          <p className="text-[12px] text-text-secondary">
            Contact support to get your account configured.
          </p>
        </div>
      </div>
    )
  }

  // Fetch intake responses — all fields (critical and non-critical) for the org
  const { data: intakeRows } = await supabase
    .from('intake_responses')
    .select('section, field_key, field_label, is_critical, response_value')
    .eq('organisation_id', org.id)

  // Fetch strategy documents
  const { data: docRows } = await supabase
    .from('strategy_documents')
    .select('document_type, status, version, generated_at, last_updated_at')
    .eq('organisation_id', org.id)

  // Fetch pending document suggestions — used to show 'In review' even when no
  // strategy_documents row exists yet (suggestion generated but not yet approved).
  const { data: pendingSuggRows } = await supabase
    .from('document_suggestions')
    .select('document_type')
    .eq('organisation_id', org.id)
    .eq('status', 'pending')

  // Fetch agent runs to determine if doc-generation agents are still running.
  // Used to distinguish "Generating your documents" from "Team reviewing" state.
  const { data: agentRunsRows } = await supabase
    .from('agent_runs')
    .select('id, agent_name, status, started_at')
    .eq('organisation_id', org.id)
    .in('agent_name', ['icp-generation', 'positioning-generation', 'tov-generation', 'messaging-generation'])

  // Fetch prospect approval counts for status display
  // RLS-protected prospects require admin client to bypass row-level security
  const adminClient = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: prospectCounts } = await adminClient
    .from('prospects')
    .select('sourced_tier, client_review_status', { count: 'exact' })
    .eq('organisation_id', org.id)
    .not('tier_published_at', 'is', null)
    .not('sourced_tier', 'is', null)
    .eq('suppressed', false)

  const prospectData = prospectCounts ?? []
  const pendingProspectsCount = prospectData.filter(p =>
    p.client_review_status === 'pending_review'
  ).length
  const approvedProspectsCount = prospectData.filter(p =>
    p.client_review_status === 'approved'
  ).length

  // Derive campaign setup status from real signals (registered campaigns + lead uploads).
  // sending_state and its timestamp come along for the ride: liveness is derived from
  // them, never from campaigns.status, which is intent and can say 'active' while nothing
  // is going out. The external_id IS NOT NULL filter stays, so every row here is one the
  // sending tool knows about.
  const [campaignsRes, uploadedCountRes, metrics] = await Promise.all([
    supabase
      .from('campaigns')
      .select('id, shell_synced_at, external_id, sending_state, sending_status_checked_at')
      .eq('organisation_id', org.id)
      .not('external_id', 'is', null),
    supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .not('campaign_id', 'is', null)
      .neq('outbound_upload_status', 'pending'),
    // No client is passed. The chokepoint builds its own service-role client, because
    // reply_handling_actions is operator-only under RLS and a session client reads zero
    // rows from it in silence. org.id was resolved through the session client above.
    getClientVisibleCampaignMetrics(org.id),
  ])

  const registeredCampaigns = campaignsRes.data ?? []
  const liveness = deriveCampaignLiveness(registeredCampaigns)
  const uploadedCount = uploadedCountRes.count ?? 0
  const derivedCampaignsStatus = deriveCampaignsStatus(registeredCampaigns, uploadedCount)

  const rawSetupStatus = (org.setup_status ?? {}) as { campaigns?: string; linkedin?: string }
  const derivedSetupStatus = {
    campaigns: derivedCampaignsStatus,
    linkedin: (['pending', 'in_progress', 'complete'].includes(rawSetupStatus.linkedin ?? '')
      ? rawSetupStatus.linkedin
      : 'pending') as 'pending' | 'in_progress' | 'complete',
  }

  const pendingTypes = new Set((pendingSuggRows ?? []).map(s => s.document_type))

  // ─── Determine dashboard state ────────────────────────────────────────────

  const rows = intakeRows ?? []
  const criticalRows = rows.filter(r => r.is_critical)
  const totalCritical = criticalRows.length
  const filledCritical = criticalRows.filter(
    r => r.response_value !== null && r.response_value !== ''
  ).length

  const intakeComplete = totalCritical > 0 && filledCritical === totalCritical

  const docs = docRows ?? []
  const ACTIVE_STATUSES = ['approved', 'active']
  const activeDocs = docs.filter(d => ACTIVE_STATUSES.includes(d.status))
  const allDocsActive = activeDocs.length >= 4

  let state: DashboardState = 'intake_incomplete'
  if (intakeComplete && allDocsActive) state = 'documents_active'
  else if (intakeComplete) state = 'strategy_in_review'

  // Determine sub-state within strategy_in_review:
  // - If any doc-generation agent is still running → 'generating'
  // - Else if pending suggestions exist → 'team_reviewing'
  // - Else → 'generating' (covers transition moment between agent completion and suggestion creation)
  let strategyReviewSubstate: StrategyReviewSubstate = 'generating'
  if (state === 'strategy_in_review') {
    const agentRuns = agentRunsRows ?? []
    const hasRunningAgents = agentRuns.some(r => r.status === 'running')

    if (hasRunningAgents) {
      strategyReviewSubstate = 'generating'
    } else if ((pendingSuggRows ?? []).length > 0) {
      strategyReviewSubstate = 'team_reviewing'
    } else {
      strategyReviewSubstate = 'generating'
    }
  }

  const topbarProps = buildTopbarProps(org.name, state, liveness, metrics.hasData)

  // ─── Build component-specific props ─────────────────────────────────────

  // State A — intake sections
  const sectionMap = new Map<string, IntakeSection>()
  for (const row of rows) {
    const key = row.section
    if (!sectionMap.has(key)) {
      sectionMap.set(key, {
        key,
        label: toSectionLabel(key),
        total: 0,
        filled: 0,
        hasCriticalGap: false,
      })
    }
    const s = sectionMap.get(key)!
    s.total += 1
    if (row.response_value !== null && row.response_value !== '') {
      s.filled += 1
    }
    if (row.is_critical && (row.response_value === null || row.response_value === '')) {
      s.hasCriticalGap = true
    }
  }
  const intakeSections = Array.from(sectionMap.values())

  // State B — document review statuses
  const VALID_DOC_TYPES: DocumentType[] = ['icp', 'positioning', 'tov', 'messaging']
  const docReviewStatuses: DocumentReviewStatus[] = VALID_DOC_TYPES.map(type => {
    const row = docs.find(d => d.document_type === type)
    return {
      type,
      status: row?.status ?? null,
      version: row?.version ?? '1.0',
      hasPendingSuggestions: pendingTypes.has(type),
    }
  })

  // State C — active documents
  const activeDocuments: ActiveDocument[] = VALID_DOC_TYPES.flatMap(type => {
    const row = docs.find(d => d.document_type === type && ACTIVE_STATUSES.includes(d.status))
    if (!row) return []
    return [{
      type,
      status: row.status,
      version: row.version,
      generatedAt: row.generated_at ?? row.last_updated_at,
    }]
  })

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <DashboardTopbar {...topbarProps} />

      {state === 'intake_incomplete' && (
        <IntakeIncompleteState
          orgName={org.name}
          sections={intakeSections}
          totalCritical={totalCritical}
          filledCritical={filledCritical}
          linkedinChannelEnabled={org.linkedin_channel_enabled ?? false}
        />
      )}

      {state === 'strategy_in_review' && (
        <StrategyInReviewState
          orgName={org.name}
          documents={docReviewStatuses}
          substate={strategyReviewSubstate}
        />
      )}

      {state === 'documents_active' && (
        <div className="flex-1 overflow-y-auto bg-surface-content">
          <div className="px-7 pb-6 max-w-[1400px]">
            <DocumentsActiveState
              orgName={org.name}
              documents={activeDocuments}
              metrics={metrics}
              liveness={liveness}
              contractStartDate={org.contract_start_date}
              warmupStartedAt={org.warmup_started_at ?? null}
              linkedinChannelEnabled={org.linkedin_channel_enabled ?? false}
              setupStatus={derivedSetupStatus}
              clientParam={clientParam}
              pendingProspectsCount={pendingProspectsCount}
              approvedProspectsCount={approvedProspectsCount}
            />
          </div>
        </div>
      )}
    </>
  )
}
