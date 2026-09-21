import { DOCUMENT_META, DOCUMENT_ORDER } from '@/lib/document-labels'
import { appendClientParam } from '@/lib/dashboard/client-param'
import type { DocumentType } from '@/types'

export interface StrategyDoc {
  type: DocumentType
  version: string
  lastUpdatedAt: string | null
}

interface StrategyPanelCardProps {
  documents: StrategyDoc[]
  clientParam?: string
}

const NAV_DOC_HREFS: Record<DocumentType, string> = {
  icp: '/dashboard/strategy/icp',
  positioning: '/dashboard/strategy/positioning',
  tov: '/dashboard/strategy/tov',
  messaging: '/dashboard/strategy/messaging',
}

function formatRelativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return '1 week ago'
  return `${Math.floor(days / 7)} weeks ago`
}

export function StrategyPanelCard({ documents, clientParam }: StrategyPanelCardProps) {
  const docMap = new Map(documents.map(d => [d.type, d]))

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
      <p className="text-[13px] font-medium text-text-primary mb-1">Strategy</p>
      {/* No "learning from campaign data" line. Nothing reads campaign signals back into
          these documents: all four generation agents write signal_count: 0 with the note
          "phase one — not yet populated", and the threshold logic that would consume them
          is schema-only by decision (CLAUDE.md, feedback loop). The green dot said the
          system was doing something it does not do. */}
      <div className="mb-5" />

      <ul className="space-y-4">
        {DOCUMENT_ORDER.map((type) => {
          const doc = docMap.get(type)
          const meta = DOCUMENT_META[type]
          const version = doc ? `v${doc.version}` : 'v1.0'
          const updatedText = doc?.lastUpdatedAt
            ? formatRelativeDate(doc.lastUpdatedAt)
            : '—'

          return (
            <li key={type}>
              <a href={appendClientParam(NAV_DOC_HREFS[type], clientParam)} className="group block">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12px] font-medium text-text-primary group-hover:text-brand-green transition-colors">
                    {meta.label}
                  </p>
                  <span className="text-[10px] font-medium text-text-secondary bg-[#F0ECE4] px-1.5 py-0.5 rounded-[4px] shrink-0">
                    {version}
                  </span>
                </div>
                <p className="text-[11px] text-text-secondary mt-0.5">{meta.desc}</p>
                <p className="text-[10px] text-text-muted mt-0.5">Updated {updatedText}</p>
              </a>
              {type !== 'messaging' && <div className="mt-4 border-t border-border-card" />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
