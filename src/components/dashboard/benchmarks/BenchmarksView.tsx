'use client'

import { useState } from 'react'
import { BenchmarkCard } from './BenchmarkCard'
import { TIER1_BENCHMARKS, BENCHMARKS_LAST_UPDATED } from '@/lib/benchmarks/tier1-benchmarks'
import {
  readRate,
  MIN_SENDS_FOR_RATE,
  MIN_PEOPLE_FOR_RATE,
  MIN_PEOPLE_FOR_MEETING_RATE,
  MIN_REPLIES_FOR_POSITIVE_RATE,
} from '@/lib/benchmarks/sample-gate'
import type { MetricBenchmark, RateUnit } from '@/lib/benchmarks/tier1-benchmarks'
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

  // ─── THE DENOMINATOR IS DERIVED FROM THE DECLARED UNIT, NOT CHOSEN HERE ───
  //
  // Every card divides by whatever its benchmark's `unit` names, and prints that same
  // unit beside both its own count and the published range. So a card cannot say "people
  // contacted" while dividing by emails: changing the unit in tier1-benchmarks.ts changes
  // this arithmetic, and there is no second place to update.
  //
  // THAT IS THE FIX FOR WHAT WENT WRONG, and it is worth being exact about what did.
  //
  // The reply rate moved from emails to people on 2026-09-02, correctly: four emails to
  // one person are one person deciding once, not four independent trials, so a rate per
  // person is the more meaningful number and it has NOT been reverted. What the change
  // missed was that the 3 to 6% range it was rendered beside is measured PER EMAIL SENT
  // by its own source. The comment that stood here said the opposite. It claimed the
  // published figures were people-denominated and that the old per-email rate was "the
  // one being compared against a range measured the other way", when the old rate was in
  // fact the one that matched. Both halves of the comparison were per email before the
  // change, and only one half moved.
  //
  // Corrected by sourcing per-person ranges rather than by reverting the rate. See
  // tier1-benchmarks.ts for the two studies and their stated units.
  //
  // contactedCount is the same figure the overview renders as "prospects contacted", read
  // from campaigns.contacted_count. Do NOT substitute the provider's own field of that
  // name: see campaign-analytics.ts, where it read 52 against 24 leads.
  //
  // WHAT THE REPLY RATE IS, EXACTLY. The numerator is the provider's reply count, which
  // is a count of REPLIES and not of people who replied. We cannot decompose it: our own
  // signals rows carry a NULL prospect_id, so "distinct people who replied" is not
  // available from this database today. So it is replies per person contacted: the right
  // denominator and an approximate numerator. It overstates only when one person replies
  // twice, which is rarer than one person receiving four emails. Recorded in BACKLOG.
  function denominatorFor(unit: RateUnit): number {
    switch (unit) {
      case 'people contacted': return contactedCount
      case 'emails sent':      return sentCount
      case 'replies':          return repliedCount
    }
  }

  // numeratorNoun is the only free text per card. The denominator and its name both come
  // from the unit, so the sentence cannot describe a division the card did not perform.
  function card(numerator: number, numeratorNoun: string, benchmark: MetricBenchmark, minimum: number) {
    const denominator = denominatorFor(benchmark.unit)
    return {
      reading: readRate(numerator, denominator, minimum),
      countsLine: `${fmt(numerator)} ${numeratorNoun} from ${fmt(denominator)} ${benchmark.unit}`,
      benchmark,
    }
  }

  const reply = card(
    repliedCount, plural(repliedCount, 'reply', 'replies'),
    TIER1_BENCHMARKS.replyRate, MIN_PEOPLE_FOR_RATE,
  )

  // PEOPLE, since 2026-09-03, and gated on its OWN constant. Meetings are about an order
  // of magnitude rarer than replies, so MIN_PEOPLE_FOR_RATE would have printed a rate off
  // roughly 3.6 expected events. MIN_PEOPLE_FOR_MEETING_RATE is derived separately at the
  // rate meetings actually run; see sample-gate.ts for the arithmetic.
  const meeting = card(
    meetingsBooked, plural(meetingsBooked, 'meeting', 'meetings'),
    TIER1_BENCHMARKS.meetingBookingRate, MIN_PEOPLE_FOR_MEETING_RATE,
  )

  // BOTH STAY PER EMAIL, and that is not an omission. Deliverability is a property of each
  // message: a bounce is one address rejecting one delivery, and an opt-out arrives from
  // one email even when three more were scheduled. Dividing either by people would answer
  // a question nobody asks of them.
  const bounce = card(
    bouncedCount, 'bounced',
    TIER1_BENCHMARKS.bounceRate, MIN_SENDS_FOR_RATE,
  )
  const optOut = card(
    unsubscribedCount, 'opted out',
    TIER1_BENCHMARKS.optOutRate, MIN_SENDS_FOR_RATE,
  )

  // A share OF replies. Its denominator was never emails and is unaffected by any of this.
  const positive = card(
    positiveReplyCount, 'positive',
    TIER1_BENCHMARKS.positiveReplyRate, MIN_REPLIES_FOR_POSITIVE_RATE,
  )

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

      {/* Rate cards. Each is handed its whole card object, so the reading, the counts
          line and the benchmark that produced them travel together and cannot be
          recombined wrongly at the call site. */}
      <div className="grid grid-cols-2 gap-4">
        <BenchmarkCard label="Reply rate" {...reply} />
        <BenchmarkCard label="Positive reply rate" {...positive} />
        <BenchmarkCard label="Meeting booking rate" {...meeting} />
        <BenchmarkCard label="Bounce rate" {...bounce} />
        <BenchmarkCard label="Opt-out rate" {...optOut} />
      </div>

      {/* Attribution. Every range names the unit it was measured in, on its own card,
          because a range and a rate are only comparable when both counted the same thing.
          The meeting card carries no range at all: see tier1-benchmarks.ts. */}
      <div className="px-1 pt-3 pb-2 space-y-1">
        <p className="text-[11px] text-text-secondary leading-relaxed max-w-[70ch]">
          Industry ranges are context, not targets. Each card states what its range was
          measured against, because a rate and a range only compare when both counted the
          same thing. Reply rates are drawn from{' '}
          <a
            href="https://www.smartlead.ai/benchmarks/average-cold-email-reply-rate"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            a 2026 study of over 850 million emails
          </a>{' '}
          and{' '}
          <a
            href="https://replylead.com/realistic-cold-email-reply-rate.html"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            a 2026 analysis of 115 campaigns
          </a>
          , both measured per person contacted. Bounce rates come from Google and
          Yahoo&apos;s 2024 bulk sender guidelines. Open rate is excluded because it has
          been unreliable since Apple Mail&apos;s 2021 privacy changes.
        </p>
        <p className="text-[11px] text-text-secondary leading-relaxed max-w-[70ch]">
          There is no industry range on the meeting booking card. The figure shown there
          previously cited a report that does not measure meetings, and we could not find
          a published range measured per person contacted. Your own rate is shown without
          one rather than beside a number we cannot stand behind.
        </p>
        <p className="text-[10px] text-text-muted">
          Ranges last reviewed: {BENCHMARKS_LAST_UPDATED}
        </p>
      </div>
    </>
  )
}
