import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { PipelineApprovalBanner } from '@/components/dashboard/pipeline/PipelineApprovalBanner'
import { MomentumBlock } from '@/components/dashboard/pipeline/MomentumBlock'
import { MeetingsListCard } from '@/components/dashboard/pipeline/MeetingsListCard'
import { StrategyPanelCard } from '@/components/dashboard/pipeline/StrategyPanelCard'
import { StatsRow } from '@/components/dashboard/pipeline/StatsRow'
import type { MeetingRow } from '@/components/dashboard/pipeline/MeetingsListCard'
import type { StrategyDoc } from '@/components/dashboard/pipeline/StrategyPanelCard'
import type { DocumentType } from '@/types'

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

export default async function PipelinePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, engagement_month, contract_start_date, pipeline_unlocked')
    .single()

  if (!org || !org.pipeline_unlocked) {
    redirect('/dashboard')
  }

  const { start: monthStart, end: monthEnd } = currentMonthBounds()

  const [meetingsResult, monthCountResult, docsResult, suggestionsResult] = await Promise.all([
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
    supabase
      .from('document_suggestions')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .eq('status', 'pending'),
  ])

  const rawMeetings = meetingsResult.data ?? []
  const meetingsThisMonth = monthCountResult.count ?? 0
  const rawDocs = docsResult.data ?? []
  const pendingSuggestions = suggestionsResult.count ?? 0

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

  return (
    <>
      <DashboardTopbar
        eyebrow={`Month ${org.engagement_month}`}
        title={org.name}
        subtitle="Pipeline"
        statusLabel="Campaigns live"
        statusVariant="live"
        orgInitials={getOrgInitials(org.name)}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 space-y-4 max-w-[1040px]">
          <PipelineApprovalBanner pendingCount={pendingSuggestions} />
          <MomentumBlock meetingsThisMonth={meetingsThisMonth} launchDate={launchDate} />
          <div className="grid grid-cols-[1fr_300px] gap-4">
            <MeetingsListCard meetings={meetings} launchDate={launchDate} />
            <StrategyPanelCard documents={strategyDocs} />
          </div>
          <StatsRow
            qualifiedMeetings={qualifiedMeetings}
            totalMeetings={totalMeetings}
            pipelineValue={pipelineValue}
          />
        </div>
      </div>
    </>
  )
}
