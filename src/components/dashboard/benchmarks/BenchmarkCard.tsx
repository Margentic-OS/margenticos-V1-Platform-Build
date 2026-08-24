'use client'

import type { RateReading, RangePosition } from '@/lib/benchmarks/sample-gate'
import { positionInRange } from '@/lib/benchmarks/sample-gate'

export interface BenchmarkCardProps {
  label: string
  reading: RateReading
  // Always shown, whether or not the rate is reportable. Counts are true from the first
  // email; only the rate has to wait.
  countsLine: string
  // What the denominator is made of, for the "too early" line: "emails", "replies".
  denominatorNoun: string
  industryRange: { min: number; max: number }
  sourceLabel: string
}

const POSITION_LABELS: Record<RangePosition, string> = {
  below: 'Below the industry range',
  within: 'Within the industry range',
  above: 'Above the industry range',
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`
}

export function BenchmarkCard({
  label,
  reading,
  countsLine,
  denominatorNoun,
  industryRange,
  sourceLabel,
}: BenchmarkCardProps) {
  const position = reading.value !== null ? positionInRange(reading.value, industryRange) : null

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
        {label}
      </p>

      <div className="flex items-baseline justify-between gap-2 mb-1">
        <p className="text-[24px] font-medium text-text-primary leading-none">
          {/* An em dash, not a zero and not a rate built on a handful of events. Until the
              sample supports one, the honest reading is that we do not have one yet. */}
          {reading.value !== null ? fmtPct(reading.value) : '—'}
        </p>
        {position && (
          // Positional, not evaluative. It says where the number sits, not whether it is
          // good, because "good" would be a target and a target is a promise.
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-[#F0ECE4] text-text-secondary">
            {POSITION_LABELS[position]}
          </span>
        )}
      </div>

      <p className="text-[11px] text-text-secondary">{countsLine}</p>

      {!reading.reportable && (
        <p className="text-[11px] text-text-muted mt-1.5 leading-relaxed">
          Too early to report a rate.{' '}
          {reading.shortfall > 0
            ? `A rate becomes meaningful at around ${reading.minimum.toLocaleString()} ${denominatorNoun}, so ${reading.shortfall.toLocaleString()} to go.`
            : `It needs around ${reading.minimum.toLocaleString()} ${denominatorNoun} behind it.`}
        </p>
      )}

      <div className="border-t border-[#E8E2D8] my-3" />

      <p className="text-[9px] font-normal uppercase tracking-[0.07em] text-text-muted mb-1">
        Industry range
      </p>
      {/* Range only. There is no target line here and there must not be one: see
          tier1-benchmarks.ts. */}
      <p className="text-[12px] text-text-secondary">
        {industryRange.min}–{industryRange.max}%
      </p>
      <p className="text-[10px] text-text-muted mt-1">{sourceLabel}</p>
    </div>
  )
}
