import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { MomentumBlock } from '@/components/dashboard/pipeline/MomentumBlock'
import { MeetingsListCard } from '@/components/dashboard/pipeline/MeetingsListCard'
import { StrategyPanelCard } from '@/components/dashboard/pipeline/StrategyPanelCard'
import { StatsRow } from '@/components/dashboard/pipeline/StatsRow'
import type { MeetingRow } from '@/components/dashboard/pipeline/MeetingsListCard'
import type { StrategyDoc } from '@/components/dashboard/pipeline/StrategyPanelCard'
import type { DocumentType } from '@/types'
import { computeCampaignMetrics } from '@/lib/metrics/campaign-metrics'

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

// Returns the estimated campaign launch date (contract_start_date + 42 days).
// Returns null if that date has already passed or no start date is set.
function estimateLaunchDate(contractStartDate: string | null): string | null {
  if (!contractStartDate) return null
  const launch = new Date(contractStartDate)
  launch.setDate(launch.getDate() + 42)
  if (launch <= new Date()) return null
  return launch.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

function currentMonthBounds(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  return { start: start.toISOString(), end: end.toISOString() }
}

type ProspectSnapshot = {
  first_name: string | null
  last_name: string | null
  company_name: string | null
}

// Supabase types embedded records as arrays when isOneToOne:false in the schema,
// but returns an object at runtime for many-to-one joins.
function extractProspect(raw: unknown): ProspectSnapshot | null {
  if (!raw) return null
  if (Array.isArray(raw)) return (raw[0] as ProspectSnapshot) ?? null
  return raw as ProspectSnapshot
}

const ACTIVE_DOC_STATUSES = ['approved', 'active']
const VALID_DOC_TYPES: DocumentType[] = ['icp', 'positioning', 'tov', 'messaging']

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { client: clientParam } = await searchParams
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, contract_start_date, pipeline_unlocked, monthly_meetings_target')
    .eq('id', organisationId ?? '')
    .single()

  if (!org) redirect('/dashboard')

  if (!org.pipeline_unlocked) {
    const { count: meetingCount } = await supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', org.id)

    return (
      <>
        <DashboardTopbar
          eyebrow="Pipeline"
          title={org.name}
          subtitle="Warming up"
          statusLabel="Warming up"
          statusVariant="warming"
          orgInitials={getOrgInitials(org.name)}
        />
        <PipelineLockedState
          meetingCount={meetingCount ?? 0}
          contractStartDate={org.contract_start_date}
        />
      </>
    )
  }

  const { start: monthStart, end: monthEnd } = currentMonthBounds()

  const [meetingsResult, monthCountResult, docsResult, campaignMetrics] = await Promise.all([
    supabase
      .from('meetings')
      .select(`
        id,
        meeting_date,
        qualification,
        revenue_value,
        prospects ( first_name, last_name, company_name )
      `)
      .eq('organisation_id', org.id)
      .order('meeting_date', { ascending: false }),
    supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .gte('meeting_date', monthStart)
      .lte('meeting_date', monthEnd),
    supabase
      .from('strategy_documents')
      .select('document_type, version, last_updated_at, generated_at')
      .eq('organisation_id', org.id)
      .in('status', ACTIVE_DOC_STATUSES),
    computeCampaignMetrics(org.id, supabase),
  ])

  const rawMeetings = meetingsResult.data ?? []
  const meetingsThisMonth = monthCountResult.count ?? 0
  const rawDocs = docsResult.data ?? []

  const meetings: MeetingRow[] = rawMeetings.map(m => {
    const p = extractProspect(m.prospects)
    return {
      id: m.id,
      prospectFirstName: p?.first_name ?? null,
      prospectLastName: p?.last_name ?? null,
      company: p?.company_name ?? null,
      meetingDate: m.meeting_date ?? null,
      qualification: m.qualification ?? null,
      revenueValue: m.revenue_value ?? null,
    }
  })

  const strategyDocs: StrategyDoc[] = rawDocs
    .filter(d => VALID_DOC_TYPES.includes(d.document_type as DocumentType))
    .map(d => ({
      type: d.document_type as DocumentType,
      version: d.version,
      lastUpdatedAt: d.last_updated_at ?? d.generated_at ?? null,
    }))

  const totalMeetings = rawMeetings.length
  const qualifiedMeetings = rawMeetings.filter(m => m.qualification === 'qualified').length
  // Pipeline value sums revenue from qualified meetings only — unqualified meetings
  // have no confirmed deal value and would inflate the figure.
  const pipelineValue = rawMeetings
    .filter(m => m.qualification === 'qualified')
    .reduce((sum, m) => sum + (m.revenue_value ?? 0), 0)

  const launchDate = estimateLaunchDate(org.contract_start_date)

  const replyRate = campaignMetrics.hasData
    ? campaignMetrics.replyCount / campaignMetrics.sentCount * 100
    : null

  return (
    <>
      <DashboardTopbar
        eyebrow="Pipeline"
        title={org.name}
        subtitle="Campaigns live"
        statusLabel="Campaigns live"
        statusVariant="live"
        orgInitials={getOrgInitials(org.name)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 space-y-4 max-w-[1040px]">
          <MomentumBlock meetingsThisMonth={meetingsThisMonth} monthlyMeetingsTarget={org.monthly_meetings_target} launchDate={launchDate} />
          <div className="grid grid-cols-[1fr_300px] gap-4">
            <MeetingsListCard meetings={meetings} launchDate={launchDate} />
            <StrategyPanelCard documents={strategyDocs} clientParam={clientParam} />
          </div>
          <StatsRow
            qualifiedMeetings={qualifiedMeetings}
            totalMeetings={totalMeetings}
            pipelineValue={pipelineValue}
            replyRate={replyRate}
          />
        </div>
      </div>
    </>
  )
}

// ADR-008: pipeline unlocks after 5 meetings booked OR 2 months elapsed, whichever first.
// monthly_meetings_target is the post-unlock monthly goal and is not the unlock threshold.
const PIPELINE_MEETING_THRESHOLD = 5

function computePipelineUnlockDate(contractStartDate: string | null): string | null {
  if (!contractStartDate) return null
  const d = new Date(contractStartDate)
  d.setMonth(d.getMonth() + 2)
  if (d <= new Date()) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

function PipelineLockedState({
  meetingCount,
  contractStartDate,
}: {
  meetingCount: number
  contractStartDate: string | null
}) {
  const unlockDate = computePipelineUnlockDate(contractStartDate)
  const progressPct = Math.min((meetingCount / PIPELINE_MEETING_THRESHOLD) * 100, 100)

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-7 max-w-[640px]">
        <div className="bg-brand-green rounded-[10px] p-6">
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-[rgba(245,240,232,0.40)] mb-3">
            Pipeline
          </p>
          <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
            Your pipeline opens as campaigns mature
          </h2>
          <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
            It unlocks after your first {PIPELINE_MEETING_THRESHOLD} meetings or two months of
            sending, whichever comes first.
            {unlockDate ? ` Two-month mark: ${unlockDate}.` : ''}
          </p>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-normal text-[rgba(245,240,232,0.45)]">
                Meetings booked
              </span>
              <span className="text-[10px] font-medium text-[rgba(245,240,232,0.65)]">
                {meetingCount} of {PIPELINE_MEETING_THRESHOLD}
              </span>
            </div>
            <div className="h-1.5 bg-[rgba(245,240,232,0.10)] rounded-full">
              <div
                className="h-full bg-brand-green-accent rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
