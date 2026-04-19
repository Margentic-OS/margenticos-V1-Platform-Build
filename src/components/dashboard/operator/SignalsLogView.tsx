// TODO: Replace placeholder data with a real query from the signals table when
// that table exists and has data. Query should join on organisations.name,
// join on prospects (first_name, last_name, company_name), order by created_at desc.

export interface SignalRow {
  id: string
  clientName: string
  signalType: string
  prospectName: string | null
  prospectCompany: string | null
  detail: string
  processed: boolean
  createdAt: string
}

const PLACEHOLDER_SIGNALS: SignalRow[] = [
  {
    id: 's1',
    clientName: 'Apex Consulting',
    signalType: 'reply_received',
    prospectName: 'Sarah Chen',
    prospectCompany: 'Brightfield Partners',
    detail: 'Positive reply — prospect asked about availability for a call',
    processed: true,
    createdAt: '2026-04-19T10:02:00Z',
  },
  {
    id: 's2',
    clientName: 'Meridian Group',
    signalType: 'bounce',
    prospectName: 'James Whitfield',
    prospectCompany: 'Thornton Advisory',
    detail: 'Hard bounce — mailbox does not exist',
    processed: true,
    createdAt: '2026-04-19T09:45:00Z',
  },
  {
    id: 's3',
    clientName: 'Apex Consulting',
    signalType: 'meeting_qualified',
    prospectName: 'Marcus Rivera',
    prospectCompany: 'Velocity Consulting',
    detail: 'Meeting marked qualified — £12,000 estimated value',
    processed: true,
    createdAt: '2026-04-18T15:30:00Z',
  },
  {
    id: 's4',
    clientName: 'Meridian Group',
    signalType: 'opt_out',
    prospectName: 'Eleanor Walsh',
    prospectCompany: 'Pinnacle Strategy',
    detail: 'Prospect replied "stop" — suppressed from all sequences',
    processed: true,
    createdAt: '2026-04-18T11:15:00Z',
  },
]

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function signalTypeLabel(type: string): string {
  const map: Record<string, string> = {
    reply_received: 'Reply received',
    bounce: 'Bounce',
    meeting_qualified: 'Meeting qualified',
    meeting_unqualified: 'Meeting unqualified',
    opt_out: 'Opt-out',
    out_of_office: 'Out of office',
    spam_complaint: 'Spam complaint',
  }
  return map[type] ?? type
}

interface SignalsLogViewProps {
  signals?: SignalRow[]
}

export function SignalsLogView({ signals = PLACEHOLDER_SIGNALS }: SignalsLogViewProps) {
  if (signals.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <div className="bg-surface-card border border-border-card rounded-[10px] px-8 py-12 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-2">
              No signals yet
            </p>
            <p className="text-[12px] text-text-secondary">
              Signals start flowing once campaigns are live — replies, bounces, and meeting outcomes will appear here.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-6 max-w-[1040px]">
        <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
          {/* Column headers */}
          <div className="grid grid-cols-[130px_120px_130px_150px_1fr_70px] gap-4 px-5 py-2.5 border-b border-border-card">
            {['Timestamp', 'Client', 'Signal type', 'Prospect', 'Detail', 'Done'].map((col) => (
              <p key={col} className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
                {col}
              </p>
            ))}
          </div>

          {/* Rows */}
          {signals.map((sig, i) => {
            const prospectDisplay = sig.prospectName
              ? `${sig.prospectName}${sig.prospectCompany ? ` · ${sig.prospectCompany}` : ''}`
              : '—'

            return (
              <div
                key={sig.id}
                className={`grid grid-cols-[130px_120px_130px_150px_1fr_70px] gap-4 px-5 py-3 items-center ${
                  i < signals.length - 1 ? 'border-b border-border-card' : ''
                }`}
              >
                <p className="text-[11px] text-text-secondary tabular-nums">
                  {formatTimestamp(sig.createdAt)}
                </p>
                <p className="text-[11px] font-medium text-text-primary truncate">
                  {sig.clientName}
                </p>
                <p className="text-[11px] text-text-primary truncate">
                  {signalTypeLabel(sig.signalType)}
                </p>
                <p className="text-[11px] text-text-secondary truncate">
                  {prospectDisplay}
                </p>
                <p className="text-[11px] text-text-secondary truncate">
                  {sig.detail}
                </p>
                <div>
                  {sig.processed ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]">
                      Yes
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#FEF7E6] text-[#7A4800] border border-[#F0D080]">
                      No
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
