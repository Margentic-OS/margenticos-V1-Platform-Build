import type { DocumentType } from '@/types'

export interface DocumentReviewStatus {
  type: DocumentType
  status: string | null
  version: string
}

interface StrategyInReviewStateProps {
  orgName: string
  documents: DocumentReviewStatus[]
}

const DOC_META: Record<DocumentType, { label: string; desc: string }> = {
  icp: {
    label: 'Prospect profile',
    desc: 'Who your ideal clients are and why they buy',
  },
  positioning: {
    label: 'Positioning',
    desc: 'Your competitive edge and core value proposition',
  },
  tov: {
    label: 'Voice guide',
    desc: 'Tone, style, and communication rules',
  },
  messaging: {
    label: 'Messaging',
    desc: 'Email and LinkedIn outreach frameworks',
  },
}

const DOC_ORDER: DocumentType[] = ['icp', 'positioning', 'tov', 'messaging']

function getDocDisplay(doc: DocumentReviewStatus | undefined): {
  statusLabel: string
  pill: string
  dot: string
  text: string
} {
  if (!doc || !doc.status) {
    return {
      statusLabel: 'Queued',
      pill: 'bg-[#F0ECE4]',
      dot: 'bg-text-muted',
      text: 'text-text-secondary',
    }
  }
  if (doc.status === 'generating') {
    return {
      statusLabel: 'Generating',
      pill: 'bg-[#FAEEDA]',
      dot: 'bg-brand-amber',
      text: 'text-[#7A4800]',
    }
  }
  if (doc.status === 'pending_review') {
    return {
      statusLabel: 'In review',
      pill: 'bg-[#FAEEDA]',
      dot: 'bg-brand-amber',
      text: 'text-[#7A4800]',
    }
  }
  if (doc.status === 'approved' || doc.status === 'active') {
    return {
      statusLabel: `Ready v${doc.version}`,
      pill: 'bg-[#EBF5E6]',
      dot: 'bg-brand-green-success',
      text: 'text-brand-green-success',
    }
  }
  return {
    statusLabel: 'Queued',
    pill: 'bg-[#F0ECE4]',
    dot: 'bg-text-muted',
    text: 'text-text-secondary',
  }
}

const WHAT_NEXT = [
  "Once all four documents are approved, you'll receive an email with next steps.",
  'Your campaigns will launch after a 4–6 week warmup period to protect your domain reputation.',
  'All campaign content goes through you for approval before anything sends.',
]

export function StrategyInReviewState({ orgName: _orgName, documents }: StrategyInReviewStateProps) {
  const docMap = new Map(documents.map(d => [d.type, d]))
  const readyCount = documents.filter(
    d => d.status === 'approved' || d.status === 'active'
  ).length

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-7">
        <div className="max-w-[880px] grid grid-cols-[1fr_300px] gap-5">

          {/* Left column */}
          <div className="space-y-4">

            {/* Welcome card — dark green */}
            <div className="bg-brand-green rounded-[10px] p-6">
              <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-[rgba(245,240,232,0.40)] mb-3">
                Strategy build
              </p>
              <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
                Your strategy is being built
              </h2>
              <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
                {readyCount > 0
                  ? `${readyCount} of 4 documents are ready. The rest are generating now — usually takes a few hours. We'll be in touch once everything is approved.`
                  : "We've received your intake. Our agents are generating your prospect profile, positioning, voice guide, and messaging documents. This usually takes a few hours."}
              </p>

              {/* Progress bar */}
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-normal text-[rgba(245,240,232,0.45)]">
                    Documents ready
                  </span>
                  <span className="text-[10px] font-medium text-[rgba(245,240,232,0.65)]">
                    {readyCount} of 4
                  </span>
                </div>
                <div className="h-1.5 bg-[rgba(245,240,232,0.10)] rounded-full">
                  <div
                    className="h-full bg-brand-green-accent rounded-full transition-all duration-500"
                    style={{ width: `${(readyCount / 4) * 100}%` }}
                  />
                </div>
              </div>
            </div>

            {/* What happens next */}
            <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
              <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-4">
                What happens next
              </p>
              <ul className="space-y-3.5">
                {WHAT_NEXT.map((line, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-[18px] h-[18px] rounded-full bg-[#F0ECE4] flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[8px] font-medium text-text-muted">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                    </span>
                    <p className="text-[12px] text-text-primary leading-relaxed">
                      {line}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Right column — document status cards */}
          <div className="space-y-3">
            <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
              <p className="text-[13px] font-medium text-text-primary mb-4">
                Strategy documents
              </p>

              <ul className="space-y-4">
                {DOC_ORDER.map((type) => {
                  const doc = docMap.get(type)
                  const meta = DOC_META[type]
                  const display = getDocDisplay(doc)

                  return (
                    <li key={type}>
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className="text-[12px] font-medium text-text-primary">
                          {meta.label}
                        </p>
                        <span className={[
                          'flex items-center gap-1 px-2 py-0.5 rounded-full shrink-0',
                          display.pill,
                        ].join(' ')}>
                          <span className={`w-1.5 h-1.5 rounded-full ${display.dot}`} />
                          <span className={`text-[9px] font-medium ${display.text}`}>
                            {display.statusLabel}
                          </span>
                        </span>
                      </div>
                      <p className="text-[11px] text-text-secondary">{meta.desc}</p>
                      {/* Subtle divider between items */}
                      {type !== 'messaging' && (
                        <div className="mt-4 border-t border-border-card" />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>

            {/* Approval note */}
            <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[10px] p-4">
              <div className="flex items-start gap-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0 mt-1.5" />
                <p className="text-[11px] text-[#7A4800] leading-relaxed">
                  You'll review and approve each document before any campaigns are configured. Nothing moves forward without your sign-off.
                </p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
