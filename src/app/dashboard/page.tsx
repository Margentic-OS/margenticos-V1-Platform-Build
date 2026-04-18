import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
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

function buildTopbarProps(
  orgName: string,
  state: DashboardState,
  engagementMonth: number
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

  return {
    eyebrow: `Month ${engagementMonth}`,
    title: orgName,
    subtitle: 'Campaigns warming up',
    statusLabel: 'Warming up',
    statusVariant: 'warming',
    orgInitials,
  }
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Fetch org
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, engagement_month, contract_start_date, pipeline_unlocked')
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

  const topbarProps = buildTopbarProps(org.name, state, org.engagement_month)

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
        />
      )}

      {state === 'strategy_in_review' && (
        <StrategyInReviewState
          orgName={org.name}
          documents={docReviewStatuses}
        />
      )}

      {state === 'documents_active' && (
        <DocumentsActiveState
          orgName={org.name}
          documents={activeDocuments}
          engagementMonth={org.engagement_month}
          contractStartDate={org.contract_start_date}
        />
      )}
    </>
  )
}
