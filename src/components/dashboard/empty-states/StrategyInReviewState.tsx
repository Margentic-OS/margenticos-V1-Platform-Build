import type { DocumentType } from '@/types'
import { DOCUMENT_META, DOCUMENT_ORDER } from '@/lib/document-labels'

export interface DocumentReviewStatus {
  type: DocumentType
  status: string | null
  version: string
  hasPendingSuggestions: boolean
}

interface StrategyInReviewStateProps {
  orgName: string
  documents: DocumentReviewStatus[]
  substate: 'generating' | 'team_reviewing'
}


function getDocDisplay(doc: DocumentReviewStatus): {
  statusLabel: string
  pill: string
  dot: string
  text: string
} {
  if (doc.status === 'approved' || doc.status === 'active') {
    return {
      statusLabel: `Ready v${doc.version}`,
      pill: 'bg-[#EBF5E6]',
      dot: 'bg-brand-green-success',
      text: 'text-brand-green-success',
    }
  }
  if (doc.status === 'generating' || doc.status === 'pending_review' || doc.hasPendingSuggestions) {
    return {
      statusLabel: 'In review',
      pill: 'bg-[#FAEEDA]',
      dot: 'bg-brand-amber',
      text: 'text-[#7A4800]',
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

export function StrategyInReviewState({ orgName: _orgName, documents, substate }: StrategyInReviewStateProps) {
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
              {substate === 'generating' ? (
                <>
                  <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
                    Generating your documents
                  </h2>
                  <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
                    {readyCount > 0
                      ? `${readyCount} of 4 documents are ready. Right now we're building your prospect profile, your positioning, your voice, and your messaging. It's the strategy your whole pipeline runs on.`
                      : "This is where it starts. Right now we're building your prospect profile, your positioning, your voice, and your messaging. It's the strategy your whole pipeline runs on, and it's being made specifically for you."}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
                    Your documents are being reviewed
                  </h2>
                  <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
                    {readyCount > 0
                      ? `${readyCount} of 4 documents are ready. Before you see them, they're getting a personal once-over from the MargenticOS team. We'll email you the moment they're ready to review.`
                      : "Your strategy documents are built. Before you see them, they're getting a personal once-over from the MargenticOS team, because your positioning should be right, not just fast. We'll email you the moment they're ready to review."}
                  </p>
                </>
              )}

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
                {DOCUMENT_ORDER.map((type) => {
                  const doc = docMap.get(type)!
                  const meta = DOCUMENT_META[type]
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
