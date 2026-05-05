'use client'

export interface BenchmarkCardProps {
  label:          string
  clientValue:    number | null
  clientSubtext:  string | null
  status:         'green' | 'amber' | 'red' | null
  statusLabel:    string | null
  benchmarkRange: string
  benchmarkTarget: string
  sourceLabel:    string
  emptyStateCopy: string
  formatValue:    (v: number) => string
}

const STATUS_PILL: Record<'green' | 'amber' | 'red', { bg: string; text: string }> = {
  green: { bg: 'bg-[#EBF5E6]',  text: 'text-[#2B5A1E]'  },
  amber: { bg: 'bg-[#FEF7E6]',  text: 'text-[#7A4800]'  },
  red:   { bg: 'bg-[#FDEEE8]',  text: 'text-[#8B2020]'  },
}

export function BenchmarkCard({
  label,
  clientValue,
  clientSubtext,
  status,
  statusLabel,
  benchmarkRange,
  benchmarkTarget,
  sourceLabel,
  emptyStateCopy,
  formatValue,
}: BenchmarkCardProps) {
  const hasData = clientValue !== null

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
      {/* Eyebrow */}
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
        {label}
      </p>

      {/* Client value / empty state */}
      {hasData ? (
        <>
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <p className="text-[24px] font-medium text-text-primary leading-none">
              {formatValue(clientValue as number)}
            </p>
            {status && statusLabel && (
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_PILL[status].bg} ${STATUS_PILL[status].text}`}>
                {statusLabel}
              </span>
            )}
          </div>
          {clientSubtext && (
            <p className="text-[11px] text-text-secondary mb-4">{clientSubtext}</p>
          )}
        </>
      ) : (
        <p className="text-[13px] text-text-secondary mb-4">{emptyStateCopy}</p>
      )}

      {/* Divider */}
      <div className="border-t border-[#E8E2D8] mb-3" />

      {/* Industry benchmark */}
      <p className="text-[9px] font-normal uppercase tracking-[0.07em] text-text-muted mb-1">
        Industry Benchmark
      </p>
      <p className="text-[12px] text-text-secondary">
        {benchmarkRange} &middot; {benchmarkTarget}
      </p>
      <p className="text-[10px] text-text-muted mt-1">{sourceLabel}</p>
    </div>
  )
}
