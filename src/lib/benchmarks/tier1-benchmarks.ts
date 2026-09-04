// Tier-1 benchmarks: typed constants sourced from published B2B research.
// No DB calls, no async. These are updated manually when new annual reports publish.
// Last updated: 2026-09-03.
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
// EVERY RANGE CARRIES THE UNIT IT WAS MEASURED IN. THIS IS THE POINT OF THE FILE.
//
// A rate and a range are only comparable when both count the same thing. That sounds
// obvious and it is exactly what went wrong on 2026-09-02, so `unit` is a required field
// and the benchmarks page DERIVES ITS DENOMINATOR FROM IT rather than choosing one
// separately. See denominatorFor() in BenchmarksView.tsx: changing the unit here changes
// the arithmetic there. The label on the card can no longer disagree with the division.
//
// WHAT WENT WRONG, RECORDED SO IT IS NOT REPEATED.
//
// Commit 9283bbe moved the reply rate's denominator from emails sent to people contacted.
// The statistics behind that are sound and it has NOT been reverted: four emails to one
// person are one person deciding once, not four independent trials, and a rate per person
// is the more meaningful number.
//
// What was wrong was leaving the RANGE alone. The 3 to 6% figure that sat here came from
// the Instantly report, which defines its metric as "percentage of all replies received
// (including follow-up responses) divided by TOTAL EMAILS SENT", average 3.43% and top
// quartile 5.5%. Per email. So from 2026-09-02 the page divided by people and compared
// the answer to a range built by dividing by emails, and the comments in this file and in
// the metrics chokepoint both asserted the opposite, which is how it survived review.
//
// Fixed by replacing the RANGE with per-person sources, not by reverting the rate.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEETING BOOKING RANGE IS REMOVED, NOT REPLACED. WHY.
//
// It read 1 to 3%, cited to "Instantly 2025 cold email report". That report was checked
// on 2026-09-03 and PUBLISHES NO MEETING METRIC AT ALL, in any unit. It carries a reply
// rate, a first-touch reply share, a bounce target and an email-length figure. The number
// on our card had no source behind it, and this is the SECOND citation to fail on this one
// card: Belkins was removed before it for contradicting the same range.
//
// A search for a replacement measured per person found none that survives being read:
//
//   GROU              0.35% median, 0.9% top quartile, 47 B2B clients. First-party with a
//                     stated method, and explicitly "the percentage of SENDS that result
//                     in a calendar booking". Wrong unit, so not comparable to ours.
//   Prospeo           1 to 4% per sequence started. The article itself attributes it to
//                     nothing: industry consensus with no study behind it.
//   LeadHaste         0.4 to 3.0% "per unique prospect", tiered. No sample size, no
//                     method, no named source, and selling consulting on the same page.
//   Assorted blogs    0.5 to 2.5%, 1 to 3%, 3 to 4%. Several attribute 1 to 3% to the
//                     Instantly report, which does not contain it. That is the same
//                     unsourced number circulating back to us with a citation attached.
//
// So the honest state is that no defensible per-person meeting benchmark exists. The card
// shows our own rate and says plainly that there is no range, rather than printing a
// number that presents itself as research and is not.
//
// DO NOT re-add a range here without a primary source that states its denominator. If one
// is found and it is measured per email, it still does not go here: it would need the
// unit changed too, and that changes the arithmetic on the page.

export type RateUnit = 'people contacted' | 'emails sent' | 'replies'

interface BenchmarkCommon {
  // The unit BOTH the published range and our own rate are measured in. Required, and
  // load-bearing: the page divides by whatever this names.
  unit: RateUnit
  sourceLabel: string
  sourceCitation: string
}

// A deliberate discriminated union rather than an optional range. Removing a range must
// force a stated reason to be written, and the compiler is what enforces that: a member
// with industryRange: null and no rangeAbsentNote does not typecheck. An optional field
// would have let the meeting card lose its range and say nothing about why.
export type MetricBenchmark =
  | (BenchmarkCommon & { industryRange: { min: number; max: number }; rangeAbsentNote?: never })
  | (BenchmarkCommon & { industryRange: null; rangeAbsentNote: string })

export const BENCHMARKS_LAST_UPDATED = 'September 2026'

export const TIER1_BENCHMARKS = {
  // PER PERSON CONTACTED, matching how the page computes it. Both sources state the unit
  // in their own words, which is why these two were used and the Instantly figure was not.
  //
  //   Smartlead, The State of Cold Email 2026, 850M+ emails sent January to June 2026:
  //     median 0.74% of contacts, "one reply per 135 people contacted"; top 10% 2.63%+,
  //     "one reply every 38 contacts".
  //   ReplyLead, August 2026, 115 campaigns (81 with 500+ contacted leads), 429,763
  //     emails to 242,669 unique leads: "median campaign reply rate of 2.12% per
  //     contacted lead", interquartile 1.39% to 3.00%.
  //
  // The range spans them: 0.7 is Smartlead's median, 3.0 is ReplyLead's upper quartile.
  // The two medians differ threefold, which is a real disagreement between populations
  // and not something to average away. A wide range is the honest shape of that.
  replyRate: {
    industryRange: { min: 0.7, max: 3 },
    unit:           'people contacted',
    sourceLabel:    'Smartlead and ReplyLead · 2026',
    sourceCitation:
      'Smartlead State of Cold Email 2026 (850M+ emails, Jan to Jun 2026): median 0.74% ' +
      'of contacts, top 10% 2.63%+. ReplyLead August 2026 (115 campaigns, 242,669 unique ' +
      'leads): median 2.12% per contacted lead, interquartile 1.39% to 3.00%.',
  } satisfies MetricBenchmark,

  // No range. See the block above for the four candidates and why each was rejected.
  meetingBookingRate: {
    industryRange: null,
    unit:          'people contacted',
    rangeAbsentNote:
      'No published range. The figure previously shown here cited a report that does not ' +
      'measure meetings, and no source we could verify measures them per person contacted.',
    sourceLabel:    'No verified source',
    sourceCitation:
      'Removed 2026-09-03. The prior 1 to 3% range cited the Instantly 2025 cold email ' +
      'report, which publishes no meeting metric in any unit.',
  } satisfies MetricBenchmark,

  // Per email, and correctly so: deliverability is a property of each message, not of the
  // person it was addressed to. Unchanged.
  bounceRate: {
    industryRange: { min: 0, max: 2 },
    unit:           'emails sent',
    sourceLabel:    'Google/Yahoo standards · 2024',
    sourceCitation: 'Google and Yahoo 2024 bulk sender guidelines',
  } satisfies MetricBenchmark,

  optOutRate: {
    industryRange: { min: 0, max: 1 },
    unit:           'emails sent',
    sourceLabel:    'Aggregated B2B research',
    sourceCitation: 'Aggregated B2B research',
  } satisfies MetricBenchmark,

  // A share OF replies, so its denominator is replies and always was. Unaffected by the
  // people-versus-emails question entirely.
  positiveReplyRate: {
    industryRange: { min: 40, max: 65 },
    unit:           'replies',
    sourceLabel:    'Aggregated B2B research',
    sourceCitation: 'Aggregated B2B research',
  } satisfies MetricBenchmark,
} as const
