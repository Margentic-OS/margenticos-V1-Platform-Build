// Tier-1 benchmarks: typed constants sourced from published B2B research.
// No DB calls, no async. These are updated manually when new annual reports publish.
// Last updated: 2026-08-24.
//
// ─────────────────────────────────────────────────────────────────────────────
// RANGES ONLY. NO TARGETS.
//
// This file used to carry green/amber/red thresholds per metric, which the benchmarks
// page rendered as "Target >= 2%" beside a status pill reading "On track" or "Below
// target". Both are gone, and they are DELETED rather than hidden.
//
// A target on a client's dashboard is a promise. "Target >= 2% meeting booking rate" is a
// promise we underwrite at roughly 0.9%, which means the dashboard was committing us to
// missing it by half, in writing, every time the client opened the page. An industry
// range is a different kind of statement: it is context about what other people see, and
// it makes no commitment about what we will deliver.
//
// Do not reinstate thresholds here. If an internal alerting threshold is needed, it
// belongs in the operator warnings engine, not in a module the client-facing benchmarks
// page imports.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BELKINS CITATION IS REMOVED, AND WHY
//
// The page cited "Belkins's 2025 study (16.5 million emails across 93 business domains)"
// beside a meeting booking range of 1 to 3%. Belkins's own published production data is
// 0.16 meetings per 1,000 emails, which is 0.016%: roughly a hundredth of the bottom of
// the range they were being cited to support.
//
// A client who follows the link finds that in a minute, and then reasonably wonders what
// else on the page was assembled that carelessly. Citing a source that contradicts the
// figure beside it is worse than citing nothing.
//
// Do not re-add it. If the meeting booking range is ever revisited, revisit the RANGE
// against Belkins's number rather than re-attaching the citation to the existing one.

export interface MetricBenchmark {
  industryRange: { min: number; max: number }
  sourceLabel: string
  sourceCitation: string
}

export const BENCHMARKS_LAST_UPDATED = 'August 2026'

export const TIER1_BENCHMARKS = {
  replyRate: {
    industryRange: { min: 3, max: 6 },
    sourceLabel:    'B2B research · 2025',
    sourceCitation: 'Instantly 2025 cold email report (billions of emails analysed)',
  } satisfies MetricBenchmark,

  meetingBookingRate: {
    // NOTE: this range now rests on a single source. See BACKLOG.md: Belkins's own
    // production figure is two orders of magnitude below the bottom of it, which is a
    // question about the RANGE and not only about the citation.
    industryRange: { min: 1, max: 3 },
    sourceLabel:    'B2B research · 2025',
    sourceCitation: 'Instantly 2025 cold email report (billions of emails analysed)',
  } satisfies MetricBenchmark,

  bounceRate: {
    industryRange: { min: 0, max: 2 },
    sourceLabel:    'Google/Yahoo standards · 2024',
    sourceCitation: 'Google and Yahoo 2024 bulk sender guidelines',
  } satisfies MetricBenchmark,

  optOutRate: {
    industryRange: { min: 0, max: 1 },
    sourceLabel:    'Aggregated B2B research',
    sourceCitation: 'Aggregated B2B research',
  } satisfies MetricBenchmark,

  positiveReplyRate: {
    industryRange: { min: 40, max: 65 },
    sourceLabel:    'Aggregated B2B research',
    sourceCitation: 'Aggregated B2B research',
  } satisfies MetricBenchmark,
} as const
