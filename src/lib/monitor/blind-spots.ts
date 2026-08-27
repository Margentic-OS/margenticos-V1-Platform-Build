// Silent failure modes and unmonitored conditions the system cannot detect
//
// These are the gaps in observability. The monitor reports that something broke,
// but these are the things it cannot see breaking at all.

export const blindSpots = {
  silentErrorPaths: {
    title: 'Silent error paths (17 known)',
    description: 'Code paths that fail silently or log errors that never surface',
    categories: [
      {
        name: 'API responses that swallow errors',
        example: 'Webhook receivers accept HTTP 200 even if the handler throws',
        count: 3,
      },
      {
        name: 'Background fetches treated as success on timeout',
        example: 'Enrichment polls Apollo for a contact; timeout reads as "no data found"',
        count: 4,
      },
      {
        name: 'Batch jobs that continue past partial failure',
        example: 'Send campaign emails to 100 prospects; if 3 fail, log it and continue',
        count: 5,
      },
      {
        name: 'Integration calls logged but never surfaced',
        example: 'Lemlist API returns 429; logged to Sentry in a quiet channel, never flagged',
        count: 5,
      },
    ],
  },

  deliverability: {
    // Was 'Deliverability (entirely unmonitored)' until 2026-08-27. Bounce rate per
    // sending domain is now covered by MON-023 and the Sending Domain Health panel above,
    // so "entirely" became untrue and the bounce line had to come off this list. Leaving
    // it would have put "bounce rate is invisible" on the same screen as a table of
    // bounce rates. Everything else here is still genuinely unmonitored.
    title: 'Deliverability (mostly unmonitored)',
    description:
      'Bounce rate per sending domain is now monitored: see Sending Domain Health above, ' +
      'and MON-023. The rest of email delivery is still a black box.',
    gaps: [
      'Spam folder placement (Gmail, Outlook, Yahoo, corporate filters)',
      'Reply rate collapse (sudden drop in replies signals domain reputation damage)',
      'Domain reputation score (sender reputation across major ISPs)',
      'Authentication failures (SPF, DKIM, DMARC alignment per ISP)',
      'Bounce TYPE: hard versus soft versus spam trap. The source reports one bounce count ' +
        'and does not break it down, so a full mailbox and a dead domain look identical.',
    ],
  },

  trends: {
    title: 'Slow degradation and trends (invisible)',
    description: 'The monitor detects outright failure. It does not detect slow creep.',
    examples: [
      'Open rate declining from 20% to 5% over 6 weeks (reputation decay)',
      'Reply latency increasing (indication of inbox placement issues)',
      'Enrichment success rate dropping 2% per week (data source quality degradation)',
      'Campaign throughput throttling silently (rate limits from upstream APIs)',
      'Prospect list quality declining (stale contact data, wrong titles emerging)',
    ],
  },

  rootCause: {
    title: 'Root cause analysis (out of scope)',
    description: 'The monitor says THAT something broke. It cannot say WHY.',
    examples: [
      'Agent run failed: is it a code bug, or did Apollo API return malformed data?',
      'Email send failed: is the Instantly API down, or the prospect domain broken?',
      'Campaign approval timed out: network latency, database slow query, or memory leak?',
    ],
  },
}

export const blindSpotsText = `
# What This Monitor Cannot See

The monitor is a tripwire. It alerts you when systems stop working. But there are large categories of failure and degradation it cannot detect.

## Silent Error Paths (17 known)

Code paths that fail without surfacing the failure:
- **API responses that swallow errors** (3 cases): Webhook receivers, approval handlers, and batch processors that log errors but return success to callers
- **Background fetches treated as success on timeout** (4 cases): Enrichment lookups, contact validation, and data sync operations that treat timeouts as "no data found"
- **Batch jobs that continue past partial failure** (5 cases): Campaign sends, signal processing, and lead deduplication jobs that lose 5–10% of their work without reporting it
- **Integration calls logged but never surfaced** (5 cases): API failures to Lemlist, Instantly, Apollo, and GoHighLevel that are logged to Sentry but never trigger operator alerts

## Deliverability (Entirely Unmonitored)

Email delivery is a black box. The system can send to Instantly, but what happens after is invisible.

- **Bounce rate**: Hard bounces, soft bounces, spam traps — none tracked
- **Spam folder placement**: Gmail, Outlook, Yahoo, and corporate filter placement — unknown
- **Reply rate collapse**: A sudden drop in replies signals domain reputation damage, but it's not detected for days
- **Domain reputation score**: Sender reputation across major ISPs — not monitored
- **Authentication**: SPF, DKIM, DMARC alignment failures per ISP — silent

## Slow Degradation (Only Outright Failure Detected)

The monitor catches crashes. It misses creep.

- Open rate declining from 20% to 5% over 6 weeks
- Reply latency increasing (inbox placement sliding)
- Enrichment success rate dropping 2% per week
- Prospect list quality degrading (stale data, title inflation)
- Rate limits kicking in from upstream APIs
- Network timeouts becoming more frequent

## Root Cause (Out of Scope)

The monitor says THAT something broke. It cannot say WHY.

- Agent run failed: code bug or bad data from Apollo?
- Email send failed: Instantly down or prospect domain blacklisted?
- Approval timed out: network lag, slow database query, or memory leak?

---

**What to do**: Monitor failures are usually in these blind spots. When something feels wrong but the monitor is green, check:
1. Sentry logs for swallowed errors (filter by "silent" or "timeout")
2. Instantly delivery reports (bounce rate, complaint rate)
3. Campaign reply rate trend (compare week over week)
4. Enrichment quality (sample 20 recent prospects; check data freshness and accuracy)
5. Upstream API rate limits (check Lemlist, Apollo, GoHighLevel usage dashboards)
`.trim()
