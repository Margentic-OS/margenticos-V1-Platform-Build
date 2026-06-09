import type { DocumentType } from '@/types'
import { DOCUMENT_META, DOCUMENT_ORDER } from '@/lib/document-labels'
import { appendClientParam } from '@/lib/dashboard/client-param'

export interface ActiveDocument {
  type: DocumentType
  status: string
  version: string
  generatedAt: string
}

type SetupStepStatus = 'pending' | 'in_progress' | 'complete'

interface SetupStatus {
  campaigns: SetupStepStatus
  linkedin: SetupStepStatus
}

interface DocumentsActiveStateProps {
  orgName: string
  documents: ActiveDocument[]
  contractStartDate: string | null
  warmupStartedAt: string | null
  linkedinChannelEnabled: boolean
  setupStatus: SetupStatus
  clientParam?: string
}


const NAV_DOC_HREFS: Record<DocumentType, string> = {
  icp: '/dashboard/strategy/icp',
  positioning: '/dashboard/strategy/positioning',
  tov: '/dashboard/strategy/tov',
  messaging: '/dashboard/strategy/messaging',
}

function formatVersion(v: string): string {
  return `v${v}`
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const days = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return '1 week ago'
  return `${Math.floor(days / 7)} weeks ago`
}

function estimateLaunchDate(warmupStartedAt: string | null): string {
  if (!warmupStartedAt) return 'in the coming weeks'
  const start = new Date(warmupStartedAt)
  // 6-week warmup period
  start.setDate(start.getDate() + 42)
  const now = new Date()
  if (start <= now) return 'soon'
  return start.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

function warmupProgressPercent(warmupStartedAt: string | null): number {
  if (!warmupStartedAt) return 0
  const start = new Date(warmupStartedAt)
  const now = new Date()
  const warmupMs = 42 * 24 * 60 * 60 * 1000 // 42 days in ms
  const elapsed = now.getTime() - start.getTime()
  return Math.min(100, Math.max(0, Math.round((elapsed / warmupMs) * 100)))
}

function statusLabel(status: SetupStepStatus): string {
  if (status === 'complete') return 'Complete'
  if (status === 'in_progress') return 'In progress'
  return 'Pending'
}

export function DocumentsActiveState({
  orgName: _orgName,
  documents,
  warmupStartedAt,
  linkedinChannelEnabled,
  setupStatus,
  clientParam,
}: DocumentsActiveStateProps) {
  const setupCards = [
    {
      key: 'documents',
      label: 'Strategy documents',
      statusLabel: 'Ready',
      done: true,
      detail: 'ICP, positioning, voice guide, and messaging',
    },
    {
      key: 'campaigns',
      label: 'Campaign setup',
      statusLabel: statusLabel(setupStatus.campaigns),
      done: setupStatus.campaigns === 'complete',
      detail: linkedinChannelEnabled
        ? 'Email sequences and LinkedIn content being configured'
        : 'Email sequences being configured',
    },
    ...(linkedinChannelEnabled ? [{
      key: 'linkedin',
      label: 'LinkedIn content',
      statusLabel: statusLabel(setupStatus.linkedin),
      done: setupStatus.linkedin === 'complete',
      detail: 'First posts being drafted for your approval',
    }] : []),
  ]
  const docMap = new Map(documents.map(d => [d.type, d]))
  const launchDate = estimateLaunchDate(warmupStartedAt)
  const warmupPct = warmupProgressPercent(warmupStartedAt)

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-7">
        <div className="max-w-[880px] grid grid-cols-[1fr_300px] gap-5">

          {/* Left column */}
          <div className="space-y-4">

            {/* Welcome card — dark green */}
            <div className="bg-brand-green rounded-[10px] p-6">
              <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-[rgba(245,240,232,0.40)] mb-3">
                Ready
              </p>
              {warmupStartedAt ? (
                <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
                  Your campaigns launch {launchDate}
                </h2>
              ) : (
                <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
                  Your strategy is ready
                </h2>
              )}
              <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
                Strategy is ready. Email warmup runs for 6 weeks to protect your domain reputation before the first campaign goes live. Meetings will appear here once outreach begins.
              </p>

              {/* Warmup progress — hidden until operator sets warmup_started_at */}
              {warmupStartedAt && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-normal text-[rgba(245,240,232,0.45)]">
                      Warmup progress
                    </span>
                    <span className="text-[10px] font-medium text-[rgba(245,240,232,0.65)]">
                      {warmupPct}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-[rgba(245,240,232,0.10)] rounded-full">
                    <div
                      className="h-full bg-brand-green-accent rounded-full transition-all duration-500"
                      style={{ width: `${warmupPct}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-[rgba(245,240,232,0.35)] mt-1.5">
                    Campaigns live once warmup reaches 100%
                  </p>
                </div>
              )}
            </div>

            {/* Setup step cards */}
            <div className="space-y-3">
              {setupCards.map((card) => (
                <div
                  key={card.key}
                  className="bg-surface-card border border-border-card rounded-[10px] p-5 flex items-start gap-4"
                >
                  <span className={[
                    'w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0 mt-0.5',
                    card.done ? 'bg-[#EBF5E6]' : 'bg-[#F0ECE4]',
                  ].join(' ')}>
                    {card.done ? (
                      <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                        <path d="M1 3.5L3.5 6L8 1" stroke="#3B6D11" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-brand-amber" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[13px] font-medium text-text-primary">{card.label}</p>
                      <span className={[
                        'flex items-center gap-1 px-2 py-0.5 rounded-full shrink-0',
                        card.done ? 'bg-[#EBF5E6]' : 'bg-[#FEF7E6]',
                      ].join(' ')}>
                        <span className={[
                          'w-1 h-1 rounded-full',
                          card.done ? 'bg-brand-green-success' : 'bg-brand-amber',
                        ].join(' ')} />
                        <span className={[
                          'text-[9px] font-medium',
                          card.done ? 'text-brand-green-success' : 'text-[#7A4800]',
                        ].join(' ')}>
                          {card.statusLabel}
                        </span>
                      </span>
                    </div>
                    <p className="text-[11px] text-text-secondary mt-0.5">{card.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right column — strategy documents panel */}
          <div>
            <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
              <div className="flex items-start justify-between mb-1">
                <p className="text-[13px] font-medium text-text-primary">Strategy documents</p>
              </div>
              {warmupStartedAt && (
                <div className="flex items-center gap-1.5 mb-5">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-green-success" />
                  <p className="text-[11px] text-text-secondary">
                    Strategy is learning from campaign data
                  </p>
                </div>
              )}
              {!warmupStartedAt && <div className="mb-5" />}

              <ul className="space-y-4">
                {DOCUMENT_ORDER.map((type) => {
                  const doc = docMap.get(type)
                  const meta = DOCUMENT_META[type]
                  const version = doc ? formatVersion(doc.version) : 'v1.0'
                  const updatedText = doc ? formatRelativeDate(doc.generatedAt) : '—'

                  return (
                    <li key={type}>
                      <a
                        href={appendClientParam(NAV_DOC_HREFS[type], clientParam)}
                        className="group block"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[12px] font-medium text-text-primary group-hover:text-brand-green transition-colors">
                            {meta.label}
                          </p>
                          <span className="text-[10px] font-medium text-text-secondary bg-[#F0ECE4] px-1.5 py-0.5 rounded-[4px] shrink-0">
                            {version}
                          </span>
                        </div>
                        <p className="text-[11px] text-text-secondary mt-0.5">{meta.desc}</p>
                        <p className="text-[10px] text-text-muted mt-0.5">
                          Updated {updatedText}
                        </p>
                      </a>
                      {type !== 'messaging' && (
                        <div className="mt-4 border-t border-border-card" />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
