import { formatCurrency, type OrganisationCurrency } from '@/lib/currency/format-currency'

export interface MeetingRow {
  id: string
  prospectFirstName: string | null
  prospectLastName: string | null
  company: string | null
  meetingDate: string | null
  qualification: string | null
  revenueValue: number | null
}

interface MeetingsListCardProps {
  meetings: MeetingRow[]
  launchDate: string | null
  /** The viewing organisation's currency. Required: a hardcoded symbol is the bug this fixes. */
  currency: OrganisationCurrency
}

const QUALIFICATION_BADGES: Record<string, { label: string; className: string }> = {
  qualified: {
    label: 'Qualified',
    className: 'text-[#2B5A1E] bg-[#EBF5E6] border-[#BDDAB0]',
  },
  not_qualified: {
    label: 'Not qualified',
    className: 'text-[#8B2020] bg-[#FDEEE8] border-[#EFBCAA]',
  },
  no_show: {
    label: 'No show',
    className: 'text-[#8B2020] bg-[#FDEEE8] border-[#EFBCAA]',
  },
  flag_pending: {
    label: 'Flag pending',
    className: 'text-[#7A4800] bg-[#FEF7E6] border-[#F0D080]',
  },
}

function formatMeetingDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}



export function MeetingsListCard({ meetings, launchDate, currency }: MeetingsListCardProps) {
  const emptyStateMsg = launchDate
    ? `Your first campaign launches ${launchDate} — meetings will appear here`
    : 'Campaigns are live — your first meeting will appear here'

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <p className="text-[13px] font-medium text-text-primary">Meetings</p>
        {meetings.length > 0 && (
          <span className="text-[10px] text-text-secondary">{meetings.length} total</span>
        )}
      </div>

      {meetings.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-10">
          <p className="text-[12px] text-text-secondary text-center leading-relaxed max-w-[220px]">
            {emptyStateMsg}
          </p>
        </div>
      ) : (
        <ul>
          {meetings.map((m, i) => {
            const fullName =
              [m.prospectFirstName, m.prospectLastName].filter(Boolean).join(' ') ||
              'Unknown prospect'
            const badge = m.qualification ? QUALIFICATION_BADGES[m.qualification] : null
            const isLast = i === meetings.length - 1

            return (
              <li key={m.id}>
                <div className="flex items-center gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-text-primary truncate">
                      {fullName}
                    </p>
                    <p className="text-[11px] text-text-secondary truncate">
                      {m.company ?? '—'}
                      {m.revenueValue != null && (
                        <span className="ml-1.5 text-text-muted">
                          · {formatCurrency(m.revenueValue, currency)}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {badge && (
                      <span
                        className={`text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] border ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    )}
                    <span className="text-[10px] text-text-muted w-[52px] text-right">
                      {formatMeetingDate(m.meetingDate)}
                    </span>
                  </div>
                </div>
                {!isLast && <div className="border-t border-border-card" />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
