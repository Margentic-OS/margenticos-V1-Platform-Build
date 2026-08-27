// Every number that decides whether per-domain sending health is a problem.
//
// ONE FILE, because these values appear in three places that must never disagree:
// the evaluation code, the MON-023 view's plain-English description, and the operator
// dashboard's explanation of why a domain reads the way it does. A threshold that is
// written down twice is a threshold that drifts.
//
// The SQL side is guarded rather than trusted: sending-health-sql-parity.test.ts reads
// the migration and fails if it does not carry the same staleness interval and the same
// state strings this module defines. That is the "test the PAIR, not each side alone"
// rule from CLAUDE.md, applied to the one comparison that has to live in SQL.

/** The rolling window both bounce triggers are evaluated over. */
export const SENDING_HEALTH_WINDOW_DAYS = 7

/**
 * TRIGGER 1 — absolute. Three or more bounces on a single sending domain inside the
 * window, at any rate.
 *
 * Absolute rather than proportional because at this build's volumes a percentage alone
 * is unusable. A domain sending 28 emails a week reaches 2% at 0.56 bounces, so a bare
 * rate rule would fire on the first bounce forever. Three is a number that means
 * something at every volume this platform will run at.
 */
export const ABSOLUTE_BOUNCE_TRIGGER = 3

/**
 * TRIGGER 2 — proportional. Bounce rate ABOVE 2% on a single sending domain.
 *
 * Strictly above. A domain sitting exactly on 2.0% passes, matching the PRD's
 * "green < 1% | amber 1-2% | red > 2%" banding in prd/sections/11-warnings.md.
 */
export const RATE_BOUNCE_TRIGGER = 0.02

/**
 * The floor trigger 2 will not fire below. A domain with fewer sends than this in the
 * window reports 'insufficient_sends' rather than a rate, and the rate rule is not
 * applied to it.
 *
 * CALIBRATED FOR RAMP VOLUME, NOT TODAY'S. At the campaign's current daily_limit of 20
 * across five domains, a domain sends roughly 28 a week and can never clear this floor,
 * so trigger 2 is DORMANT until sending throughput rises. That is the floor working, not
 * failing: it suppresses a percentage computed on a sample too small to mean anything.
 * Confirmed with Doug 2026-08-27; raising the campaign daily limit is a separate pre-ramp
 * change already on the board.
 *
 * The dormancy is never silent. A domain below the floor reports 'insufficient_sends' on
 * the operator dashboard and in the MON-023 detail line, because a check that reads
 * healthy when it had nothing to judge is the failure shape CLAUDE.md names.
 */
export const RATE_MINIMUM_SENDS = 50

/**
 * How old the stored verdict may be before MON-023 stops trusting it.
 *
 * The verdict is computed by the instantly-poll cron, which runs every 15 minutes, so a
 * verdict older than an hour means four consecutive runs did not land. Beyond that the
 * stored state is describing a past that may no longer hold, and reporting it as current
 * would be the exact failure this guard exists for: a monitor reading green because its
 * input stopped arriving rather than because anything is well.
 *
 * MUST MATCH the interval in the mon_023 view. Guarded by sending-health-sql-parity.test.ts.
 */
export const VERDICT_MAX_AGE_MINUTES = 60

/**
 * How many days back each cron run re-fetches and upserts.
 *
 * Three, not one. Instantly can attribute a bounce to the day the send happened rather
 * than the day the bounce arrived, so a figure for "today" is not final until the
 * bounces that belong to it have landed. Re-fetching three days and upserting means a
 * late bounce corrects the day it belongs to instead of being lost or double counted.
 */
export const FETCH_LOOKBACK_DAYS = 3

/**
 * The first day there was anything to record: the live campaign's first send.
 * Used by the one-off backfill so the table is populated on day one rather than
 * accumulating a week of history before it can say anything.
 */
export const SENDING_HEALTH_BACKFILL_FROM = '2026-08-21'

/**
 * Instantly's analytics endpoint refuses a range wider than this. Not our choice, and
 * not a tuning knob: measured against the live API on 2026-08-27, which answered
 * `HTTP 400: Analytics date range cannot exceed 31 days`. The backfill chunks on it.
 */
export const PROVIDER_MAX_RANGE_DAYS = 31
