// Tier-1 benchmarks: typed constants sourced from published B2B research.
// No DB calls, no async. These are updated manually when new annual reports publish.
// Last updated: 2026-05-05. Refresh when Instantly or Belkins publish a new annual report.

export interface BenchmarkThreshold {
  threshold:  number
  label:      string
}

export interface BounceThreshold {
  threshold:    number
  maxThreshold: number
  label:        string
}

export interface MetricBenchmark {
  industryRange: { min: number; max: number }
  green:         BenchmarkThreshold
  amber:         BenchmarkThreshold
  red:           BenchmarkThreshold
  sourceLabel:   string
  sourceCitation: string
}

export interface BounceMetricBenchmark {
  industryRange: { min: number; max: number }
  green:         BounceThreshold
  amber:         BounceThreshold
  red:           BenchmarkThreshold
  sourceLabel:   string
  sourceCitation: string
}

export const BENCHMARKS_LAST_UPDATED = 'May 2026'

export const TIER1_BENCHMARKS = {
  replyRate: {
    industryRange: { min: 3, max: 6 },
    green: { threshold: 5, label: '≥ 5%' },
    amber: { threshold: 3, label: '3–5%' },
    red:   { threshold: 0, label: '< 3%' },
    sourceLabel:    'B2B research · 2025',
    sourceCitation: 'Instantly 2025 report (billions of emails) · Belkins 2025 study (16.5M emails)',
  } satisfies MetricBenchmark,

  meetingBookingRate: {
    industryRange: { min: 1, max: 3 },
    green: { threshold: 2, label: '≥ 2%' },
    amber: { threshold: 1, label: '1–2%' },
    red:   { threshold: 0, label: '< 1%' },
    sourceLabel:    'B2B research · 2025',
    sourceCitation: 'Instantly 2025 report (billions of emails) · Belkins 2025 study (16.5M emails)',
  } satisfies MetricBenchmark,

  bounceRate: {
    industryRange: { min: 0, max: 2 },
    green: { threshold: 0, maxThreshold: 1, label: '< 1%' },
    amber: { threshold: 1, maxThreshold: 2, label: '1–2%' },
    red:   { threshold: 2, label: '> 2%' },
    sourceLabel:    'Google/Yahoo standards · 2024',
    sourceCitation: 'Google/Yahoo 2024 sender guidelines',
  } satisfies BounceMetricBenchmark,

  positiveReplyRate: {
    industryRange: { min: 40, max: 65 },
    green: { threshold: 50, label: '≥ 50%' },
    amber: { threshold: 40, label: '40–50%' },
    red:   { threshold: 0,  label: '< 40%' },
    sourceLabel:    'Aggregated B2B research',
    sourceCitation: 'Aggregated B2B research',
  } satisfies MetricBenchmark,
} as const
