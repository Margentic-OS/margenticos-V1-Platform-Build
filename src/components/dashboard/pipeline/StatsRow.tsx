interface StatsRowProps {
  qualifiedMeetings: number
  totalMeetings: number
  pipelineValue: number
}

const EMPTY_COPY = 'Tracking begins once campaigns go live'

function StatCard({
  label,
  value,
  subtext,
  isEmpty,
}: {
  label: string
  value: string
  subtext: string
  isEmpty: boolean
}) {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
        {label}
      </p>
      {isEmpty ? (
        <p className="text-[12px] text-text-muted leading-relaxed">{EMPTY_COPY}</p>
      ) : (
        <>
          <p className="text-[22px] font-medium text-text-primary leading-none mb-1">{value}</p>
          <p className="text-[11px] text-text-secondary">{subtext}</p>
        </>
      )}
    </div>
  )
}

export function StatsRow({ qualifiedMeetings, totalMeetings, pipelineValue }: StatsRowProps) {
  const hasData = totalMeetings > 0

  const qualifiedRate = `${Math.round((qualifiedMeetings / totalMeetings) * 100)}%`
  const qualifiedSubtext = `${qualifiedMeetings} of ${totalMeetings} meetings qualified`

  const pipelineFormatted =
    pipelineValue >= 1000
      ? `£${(pipelineValue / 1000).toFixed(0)}k`
      : `£${pipelineValue}`
  const pipelineSubtext = `${qualifiedMeetings} qualified meeting${qualifiedMeetings !== 1 ? 's' : ''} · est. value`

  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard label="Reply rate" value="—" subtext="" isEmpty={true} />
      <StatCard
        label="Qualified rate"
        value={qualifiedRate}
        subtext={qualifiedSubtext}
        isEmpty={!hasData}
      />
      <StatCard
        label="Pipeline value"
        value={pipelineFormatted}
        subtext={pipelineSubtext}
        isEmpty={!hasData}
      />
    </div>
  )
}
