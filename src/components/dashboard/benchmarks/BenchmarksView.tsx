'use client'

import { BenchmarkCard } from './BenchmarkCard'
import { TIER1_BENCHMARKS, BENCHMARKS_LAST_UPDATED } from '@/lib/benchmarks/tier1-benchmarks'
import type { CampaignMetrics } from '@/lib/metrics/campaign-metrics'

interface BenchmarksViewProps {
  metrics: CampaignMetrics
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return (numerator / denominator) * 100
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`
}

function fmt(n: number): string {
  return n.toLocaleString()
}

export function BenchmarksView({ metrics }: BenchmarksViewProps) {
  const { sentCount, replyCount, bounceCount, positiveReplyCount, meetingCount, hasData } = metrics

  // ── Rate calculations ──────────────────────────────────────────────────────
  const replyRatePct        = pct(replyCount,         sentCount)
  const meetingRatePct      = pct(meetingCount,        sentCount)
  const bounceRatePct       = pct(bounceCount,         sentCount)
  const positiveReplyRatePct = pct(positiveReplyCount, replyCount)

  // ── Status computation ─────────────────────────────────────────────────────
  // Reply rate — higher is better
  const replyStatus = !hasData ? null
    : replyRatePct >= TIER1_BENCHMARKS.replyRate.green.threshold ? 'green'
    : replyRatePct >= TIER1_BENCHMARKS.replyRate.amber.threshold ? 'amber'
    : 'red'

  // Meeting booking rate — higher is better
  const meetingStatus = !hasData ? null
    : meetingRatePct >= TIER1_BENCHMARKS.meetingBookingRate.green.threshold ? 'green'
    : meetingRatePct >= TIER1_BENCHMARKS.meetingBookingRate.amber.threshold ? 'amber'
    : 'red'

  // Bounce rate — lower is better (inverted thresholds)
  const bounceStatus = !hasData ? null
    : bounceRatePct < TIER1_BENCHMARKS.bounceRate.green.maxThreshold  ? 'green'
    : bounceRatePct < TIER1_BENCHMARKS.bounceRate.amber.maxThreshold  ? 'amber'
    : 'red'

  // Positive reply rate — higher is better; requires replies to be non-zero
  const hasReplies = replyCount > 0
  const positiveStatus = !hasReplies ? null
    : positiveReplyRatePct >= TIER1_BENCHMARKS.positiveReplyRate.green.threshold ? 'green'
    : positiveReplyRatePct >= TIER1_BENCHMARKS.positiveReplyRate.amber.threshold ? 'amber'
    : 'red'

  // ── Status label copy ──────────────────────────────────────────────────────
  const STATUS_LABELS: Record<string, Record<'green' | 'amber' | 'red', string>> = {
    reply:    { green: 'On track',     amber: 'Within range', red: 'Needs attention' },
    meeting:  { green: 'On track',     amber: 'Below target', red: 'Needs attention' },
    bounce:   { green: 'Healthy',      amber: 'Watch this',   red: 'Pause risk'      },
    positive: { green: 'Healthy',      amber: 'Watch this',   red: 'List quality issue' },
  }

  function statusLabel(key: string, s: 'green' | 'amber' | 'red' | null): string | null {
    return s ? STATUS_LABELS[key][s] : null
  }

  return (
    <>
      {/* 2×2 card grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Reply rate */}
        <BenchmarkCard
          label="Reply Rate"
          clientValue={hasData ? replyRatePct : null}
          clientSubtext={hasData
            ? `${fmt(replyCount)} replies from ${fmt(sentCount)} sent`
            : null}
          status={replyStatus as 'green' | 'amber' | 'red' | null}
          statusLabel={statusLabel('reply', replyStatus as 'green' | 'amber' | 'red' | null)}
          benchmarkRange="3–6%"
          benchmarkTarget="Target ≥ 5%"
          sourceLabel={TIER1_BENCHMARKS.replyRate.sourceLabel}
          emptyStateCopy="Appears once campaigns go live."
          formatValue={fmtPct}
        />

        {/* Meeting booking rate */}
        <BenchmarkCard
          label="Meeting Booking Rate"
          clientValue={hasData ? meetingRatePct : null}
          clientSubtext={hasData
            ? `${fmt(meetingCount)} meetings from ${fmt(sentCount)} sent`
            : null}
          status={meetingStatus as 'green' | 'amber' | 'red' | null}
          statusLabel={statusLabel('meeting', meetingStatus as 'green' | 'amber' | 'red' | null)}
          benchmarkRange="1–3%"
          benchmarkTarget="Target ≥ 2%"
          sourceLabel={TIER1_BENCHMARKS.meetingBookingRate.sourceLabel}
          emptyStateCopy="Appears once campaigns go live."
          formatValue={fmtPct}
        />

        {/* Bounce rate */}
        <BenchmarkCard
          label="Bounce Rate"
          clientValue={hasData ? bounceRatePct : null}
          clientSubtext={hasData
            ? `${fmt(bounceCount)} bounces from ${fmt(sentCount)} sent`
            : null}
          status={bounceStatus as 'green' | 'amber' | 'red' | null}
          statusLabel={statusLabel('bounce', bounceStatus as 'green' | 'amber' | 'red' | null)}
          benchmarkRange="0–2%"
          benchmarkTarget="Target < 1%"
          sourceLabel={TIER1_BENCHMARKS.bounceRate.sourceLabel}
          emptyStateCopy="Tracked automatically once campaigns are sending."
          formatValue={fmtPct}
        />

        {/* Positive reply rate */}
        <BenchmarkCard
          label="Positive Reply Rate"
          clientValue={hasReplies ? positiveReplyRatePct : null}
          clientSubtext={hasReplies
            ? `${fmt(positiveReplyCount)} positive of ${fmt(replyCount)} replies`
            : null}
          status={positiveStatus as 'green' | 'amber' | 'red' | null}
          statusLabel={statusLabel('positive', positiveStatus as 'green' | 'amber' | 'red' | null)}
          benchmarkRange="40–65%"
          benchmarkTarget="Target ≥ 50%"
          sourceLabel={TIER1_BENCHMARKS.positiveReplyRate.sourceLabel}
          emptyStateCopy="Appears once replies start coming in."
          formatValue={fmtPct}
        />
      </div>

      {/* Attribution block */}
      <div className="px-1 pt-3 pb-2 space-y-1">
        <p className="text-[11px] text-text-secondary leading-relaxed">
          Industry benchmarks sourced from{' '}
          <a
            href="https://instantly.ai/cold-email-benchmark-report-2026"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Instantly&apos;s 2025 cold email report
          </a>{' '}
          (billions of emails analysed) and{' '}
          <a
            href="https://belkins.io/blog/cold-email-response-rates"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Belkins&apos;s 2025 study
          </a>{' '}
          (16.5 million emails across 93 business domains).
          Open rate is excluded — it&apos;s been unreliable since Apple Mail&apos;s 2021 privacy changes.
        </p>
        <p className="text-[10px] text-text-muted">
          Last updated: {BENCHMARKS_LAST_UPDATED}
        </p>
      </div>
    </>
  )
}
