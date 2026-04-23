// detail column omitted — no detail field exists on signals; raw_data is
// unstructured until the signal processing agent is built (pre-c0 backlog).

export interface SignalRow {
  id: string
  clientName: string
  signalType: string
  prospectName: string | null
  prospectCompany: string | null
  processed: boolean
  createdAt: string
}

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
    email_open: 'Email open',
    email_click: 'Email click',
    email_reply: 'Email reply',
    email_bounce: 'Bounce',
    email_spam: 'Spam complaint',
    linkedin_post_like: 'LinkedIn like',
    linkedin_post_comment: 'LinkedIn comment',
    linkedin_post_share: 'LinkedIn share',
    linkedin_dm_reply: 'LinkedIn DM reply',
    linkedin_connection_accepted: 'Connection accepted',
    meeting_qualified: 'Meeting qualified',
    meeting_unqualified: 'Meeting unqualified',
    meeting_no_show: 'No-show',
    positive_reply: 'Positive reply',
    information_request: 'Info request',
    opt_out: 'Opt-out',
    out_of_office: 'Out of office',
  }
  return map[type] ?? type
}

interface SignalsLogViewProps {
  signals: SignalRow[]
  error?: boolean
}

export function SignalsLogView({ signals, error }: SignalsLogViewProps) {
  if (error) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <div className="bg-surface-card border border-border-card rounded-[10px] px-8 py-12 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-2">
              Could not load signals
            </p>
            <p className="text-[12px] text-text-secondary">
              Check server logs for details.
            </p>
          </div>
        </div>
      </div>
    )
  }

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
          <div className="grid grid-cols-[130px_120px_150px_1fr_70px] gap-4 px-5 py-2.5 border-b border-border-card">
            {['Timestamp', 'Client', 'Signal type', 'Prospect', 'Done'].map((col) => (
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
                className={`grid grid-cols-[130px_120px_150px_1fr_70px] gap-4 px-5 py-3 items-center ${
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
