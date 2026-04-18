// TODO: move to organisations.monthly_meetings_target when per-client configurability is needed
const DEFAULT_MONTHLY_MEETINGS_TARGET = 8

interface MomentumBlockProps {
  meetingsThisMonth: number
  launchDate: string | null
}

function getPaceLabel(count: number, target: number): string {
  const now = new Date()
  const dayOfMonth = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const expected = target * (dayOfMonth / daysInMonth)
  if (dayOfMonth <= 3 && count === 0) return 'Month just started'
  if (count >= Math.ceil(expected * 1.15)) return 'Ahead of pace'
  if (count >= Math.floor(expected)) return 'On track'
  return 'Behind pace'
}

function getPaceLabelColor(label: string): string {
  if (label === 'Ahead of pace' || label === 'On track') return 'text-brand-green-success'
  if (label === 'Behind pace') return 'text-[#7A4800]'
  return 'text-text-secondary'
}

export function MomentumBlock({ meetingsThisMonth, launchDate }: MomentumBlockProps) {
  const target = DEFAULT_MONTHLY_MEETINGS_TARGET
  const pct = Math.min(100, Math.round((meetingsThisMonth / target) * 100))
  const hasData = meetingsThisMonth > 0
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long' })

  const emptyStateMsg = launchDate
    ? `Your first campaign launches ${launchDate} — meetings will appear here`
    : 'Campaigns are live — your first meeting will appear here'

  const paceLabel = getPaceLabel(meetingsThisMonth, target)
  const paceColor = getPaceLabelColor(paceLabel)

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
      {!hasData ? (
        <>
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
            {monthName} · Meetings
          </p>
          <p className="text-[14px] font-medium text-text-primary mb-5">{emptyStateMsg}</p>
          <div className="h-1.5 bg-[#F0ECE4] rounded-full" />
          <p className="text-[10px] text-text-muted mt-2">0 of {target} meetings this month</p>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
              {monthName} · Meetings
            </p>
            <span className={`text-[11px] font-medium ${paceColor}`}>{paceLabel}</span>
          </div>
          <p className="text-[18px] font-medium text-text-primary mb-4">
            {meetingsThisMonth} of {target} meetings this month
          </p>
          <div className="h-1.5 bg-[#F0ECE4] rounded-full">
            <div
              className="h-full bg-brand-green rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[10px] text-text-muted mt-2">{pct}% toward monthly target</p>
        </>
      )}
    </div>
  )
}
