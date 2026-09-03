'use client'

import { useState } from 'react'
import { BenchmarkCard } from './BenchmarkCard'
import { TIER1_BENCHMARKS, BENCHMARKS_LAST_UPDATED } from '@/lib/benchmarks/tier1-benchmarks'
import {
  readRate,
  MIN_SENDS_FOR_RATE,
  MIN_PEOPLE_FOR_RATE,
  MIN_REPLIES_FOR_POSITIVE_RATE,
} from '@/lib/benchmarks/sample-gate'
import type { ClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

// The ninety-days block, as data rather than JSX, because the first line is rendered on
// its own when the block is collapsed and must not become a second copy of itself.
//
// THE TRADE-OFF, NAMED. BACKLOG.md records that this block is the answer to the question
// the sample gate creates: at current volume every rate card reads as a dash, and the
// first client to see that WILL ask why. Collapsing it by default hides that answer one
// click away. Accepted because four paragraphs above the cards is the reason nobody read
// it at all, and the lead line stays on screen collapsed, which is what invites the click.
// If a client asks the question anyway, this default is what to revisit first.
const NINETY_DAYS_LEAD = 'Cold outreach is slow before it is fast.'

const NINETY_DAYS_LEAD_REST =
  'The first few weeks are spent warming the sending domains and sending small volumes, ' +
  'which protects your reputation with the inbox providers and is the single biggest ' +
  'factor in whether your emails land at all. Volume climbs from there.'

const NINETY_DAYS_REST = [
  'Replies arrive in ones and twos long before they arrive in a pattern. Early on the ' +
  'counts on your overview are the honest measure: a rate calculated from a few dozen ' +
  'emails swings wildly on a single reply, so the cards below stay blank until there is ' +
  'enough behind them to mean something. Expect that to take most of the first month.',

  'Month two is where the messaging starts earning its keep. Replies tell us which angle ' +
  'lands, and your strategy documents get updated from what actually happened rather than ' +
  'from what we guessed at the start. Month three is usually the first month whose numbers ' +
  'are worth comparing to anything.',

  'Meetings do not arrive evenly. A quiet fortnight followed by three in a week is normal ' +
  'and is not a signal about anything. What matters over ninety days is the direction, not ' +
  'any single week in it.',
]

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
    contactedCount,
    sentCount,
    repliedCount,
    bouncedCount,
    unsubscribedCount,
    positiveReplyCount,
    meetingsBooked,
  } = metrics

  // Collapsed by default, per the trade-off noted above the copy.
  const [ninetyDaysOpen, setNinetyDaysOpen] = useState(false)

  // ─── REPLY RATE IS DENOMINATED IN PEOPLE, NOT EMAILS ──────────────────────
  //
  // It divided by sentCount until 2026-09-03. A four-step sequence sends up to four
  // emails to one person, so that denominator counted the same person up to four times
  // and the rate came out roughly a quarter of what the published figures mean. Measured
  // on the live campaign: 2 replies from 60 emails reads 3.3%, the same 2 replies from 24
  // people reads 8.3%. Identical performance, nearly three times apart, and the smaller
  // number was the one being compared against a range measured the other way.
  //
  // contactedCount is the same figure the overview renders as "prospects contacted", read
  // from campaigns.contacted_count. Do NOT substitute the provider's own field of that
  // name: see campaign-analytics.ts, where it read 52 against 24 leads.
  //
  // WHAT THIS RATE IS, EXACTLY. The numerator is the provider's reply count, which is a
  // count of REPLIES and not of people who replied. We cannot decompose it: our own
  // signals rows carry a NULL prospect_id, so "distinct people who replied" is not
  // available from this database today. So the rate is replies per person contacted,
  // which is the right denominator and an approximate numerator. It overstates only when
  // one person replies twice, which is rarer than one person receiving four emails.
  // Recorded in BACKLOG.
  const reply    = readRate(repliedCount, contactedCount, MIN_PEOPLE_FOR_RATE)

  // Still send-denominated, deliberately, and flagged for a decision rather than changed
  // in the same pass. See the report accompanying this change.
  const meeting  = readRate(meetingsBooked, sentCount, MIN_SENDS_FOR_RATE)
  const bounce   = readRate(bouncedCount, sentCount, MIN_SENDS_FOR_RATE)
  const optOut   = readRate(unsubscribedCount, sentCount, MIN_SENDS_FOR_RATE)
  // Different denominator: this is a share OF replies, not of emails.
  const positive = readRate(positiveReplyCount, repliedCount, MIN_REPLIES_FOR_POSITIVE_RATE)

  return (
    <>
      {/* What the first ninety days look like. Plain paragraphs, no numbers to hit, on
          purpose: a target here would be the same promise the cards no longer make. */}
      <div className="bg-surface-card border border-border-card rounded-[10px] mb-4">
        <button
          type="button"
          onClick={() => setNinetyDaysOpen(o => !o)}
          aria-expanded={ninetyDaysOpen}
          aria-controls="ninety-days-detail"
          className="group w-full text-left p-6 flex items-start justify-between gap-4"
        >
          <span className="min-w-0">
            <span className="block text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
              What the first ninety days look like
            </span>
            {/* The lead line stays visible collapsed. It is the sentence that makes the
                rest worth opening. */}
            <span className="block text-[12px] text-text-secondary leading-relaxed max-w-[70ch]">
              {NINETY_DAYS_LEAD}
              {!ninetyDaysOpen && (
                <span className="text-text-secondary opacity-60"> Read what to expect.</span>
              )}
            </span>
          </span>
          <span className="flex items-center justify-center w-6 h-6 rounded-[6px] border border-border-card bg-surface-shell group-hover:bg-[#F0ECE4] transition-colors shrink-0">
            <svg
              width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
              className={ninetyDaysOpen ? 'rotate-90 transition-transform' : 'transition-transform'}
            >
              <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {ninetyDaysOpen && (
          <div
            id="ninety-days-detail"
            className="px-6 pb-6 -mt-1 space-y-3 text-[12px] text-text-secondary leading-relaxed max-w-[70ch]"
          >
            <p>{NINETY_DAYS_LEAD_REST}</p>
            {NINETY_DAYS_REST.map((para) => (
              <p key={para.slice(0, 32)}>{para}</p>
            ))}
          </div>
        )}
      </div>

      {/* Rate cards */}
      <div className="grid grid-cols-2 gap-4">
        <BenchmarkCard
          label="Reply rate"
          reading={reply}
          countsLine={`${fmt(repliedCount)} ${plural(repliedCount, 'reply', 'replies')} from ${fmt(contactedCount)} ${plural(contactedCount, 'person', 'people')} contacted`}
          denominatorNoun="people contacted"
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
