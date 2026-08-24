'use client'

import { BenchmarkCard } from './BenchmarkCard'
import { TIER1_BENCHMARKS, BENCHMARKS_LAST_UPDATED } from '@/lib/benchmarks/tier1-benchmarks'
import {
  readRate,
  MIN_SENDS_FOR_RATE,
  MIN_REPLIES_FOR_POSITIVE_RATE,
} from '@/lib/benchmarks/sample-gate'
import type { ClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

interface BenchmarksViewProps {
  metrics: ClientVisibleCampaignMetrics
}

function fmt(n: number): string {
  return n.toLocaleString()
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

export function BenchmarksView({ metrics }: BenchmarksViewProps) {
  const {
    sentCount,
    repliedCount,
    bouncedCount,
    unsubscribedCount,
    positiveReplyCount,
    meetingsBooked,
  } = metrics

  // Every send-denominated rate shares one gate. See sample-gate.ts for where 400 comes
  // from; the short version is that below it, one extra email moves the number by more
  // than the thing the number is meant to distinguish.
  const reply    = readRate(repliedCount, sentCount, MIN_SENDS_FOR_RATE)
  const meeting  = readRate(meetingsBooked, sentCount, MIN_SENDS_FOR_RATE)
  const bounce   = readRate(bouncedCount, sentCount, MIN_SENDS_FOR_RATE)
  const optOut   = readRate(unsubscribedCount, sentCount, MIN_SENDS_FOR_RATE)
  // Different denominator: this is a share OF replies, not of emails.
  const positive = readRate(positiveReplyCount, repliedCount, MIN_REPLIES_FOR_POSITIVE_RATE)

  return (
    <>
      {/* What the first ninety days look like. Plain paragraph, no numbers to hit, on
          purpose: a target here would be the same promise the cards no longer make. */}
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6 mb-4">
        <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
          What the first ninety days look like
        </p>
        <div className="space-y-3 text-[12px] text-text-secondary leading-relaxed max-w-[70ch]">
          <p>
            Cold outreach is slow before it is fast. The first few weeks are spent warming
            the sending domains and sending small volumes, which protects your reputation
            with the inbox providers and is the single biggest factor in whether your
            emails land at all. Volume climbs from there.
          </p>
          <p>
            Replies arrive in ones and twos long before they arrive in a pattern. Early on
            the counts on your overview are the honest measure: a rate calculated from a
            few dozen emails swings wildly on a single reply, so the cards below stay blank
            until there is enough behind them to mean something. Expect that to take most
            of the first month.
          </p>
          <p>
            Month two is where the messaging starts earning its keep. Replies tell us which
            angle lands, and your strategy documents get updated from what actually
            happened rather than from what we guessed at the start. Month three is usually
            the first month whose numbers are worth comparing to anything.
          </p>
          <p>
            Meetings do not arrive evenly. A quiet fortnight followed by three in a week is
            normal and is not a signal about anything. What matters over ninety days is the
            direction, not any single week in it.
          </p>
        </div>
      </div>

      {/* Rate cards */}
      <div className="grid grid-cols-2 gap-4">
        <BenchmarkCard
          label="Reply rate"
          reading={reply}
          countsLine={`${fmt(repliedCount)} ${plural(repliedCount, 'reply', 'replies')} from ${fmt(sentCount)} sent`}
          denominatorNoun="emails"
          industryRange={TIER1_BENCHMARKS.replyRate.industryRange}
          sourceLabel={TIER1_BENCHMARKS.replyRate.sourceLabel}
        />

        <BenchmarkCard
          label="Positive reply rate"
          reading={positive}
          countsLine={`${fmt(positiveReplyCount)} positive of ${fmt(repliedCount)} ${plural(repliedCount, 'reply', 'replies')}`}
          denominatorNoun="replies"
          industryRange={TIER1_BENCHMARKS.positiveReplyRate.industryRange}
          sourceLabel={TIER1_BENCHMARKS.positiveReplyRate.sourceLabel}
        />

        <BenchmarkCard
          label="Meeting booking rate"
          reading={meeting}
          countsLine={`${fmt(meetingsBooked)} ${plural(meetingsBooked, 'meeting', 'meetings')} from ${fmt(sentCount)} sent`}
          denominatorNoun="emails"
          industryRange={TIER1_BENCHMARKS.meetingBookingRate.industryRange}
          sourceLabel={TIER1_BENCHMARKS.meetingBookingRate.sourceLabel}
        />

        <BenchmarkCard
          label="Bounce rate"
          reading={bounce}
          countsLine={`${fmt(bouncedCount)} bounced of ${fmt(sentCount)} sent`}
          denominatorNoun="emails"
          industryRange={TIER1_BENCHMARKS.bounceRate.industryRange}
          sourceLabel={TIER1_BENCHMARKS.bounceRate.sourceLabel}
        />

        <BenchmarkCard
          label="Opt-out rate"
          reading={optOut}
          countsLine={`${fmt(unsubscribedCount)} opted out of ${fmt(sentCount)} sent`}
          denominatorNoun="emails"
          industryRange={TIER1_BENCHMARKS.optOutRate.industryRange}
          sourceLabel={TIER1_BENCHMARKS.optOutRate.sourceLabel}
        />
      </div>

      {/* Attribution. The Belkins citation is deliberately absent: their own published
          production figure is 0.16 meetings per 1,000 emails, two orders of magnitude
          below the bottom of the meeting booking range they were cited beside. */}
      <div className="px-1 pt-3 pb-2 space-y-1">
        <p className="text-[11px] text-text-secondary leading-relaxed max-w-[70ch]">
          Industry ranges are context, not targets. They are drawn from{' '}
          <a
            href="https://instantly.ai/cold-email-benchmark-report-2026"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            a 2025 cold email industry report
          </a>{' '}
          covering billions of emails, and from Google and Yahoo&apos;s 2024 bulk sender
          guidelines for bounce rates. Open rate is excluded because it has been unreliable
          since Apple Mail&apos;s 2021 privacy changes.
        </p>
        <p className="text-[10px] text-text-muted">
          Ranges last reviewed: {BENCHMARKS_LAST_UPDATED}
        </p>
      </div>
    </>
  )
}
