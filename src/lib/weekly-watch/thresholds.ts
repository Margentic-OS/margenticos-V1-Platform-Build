// Every number the weekly watch judges by, in one file, for the same reason
// sending-health/thresholds.ts exists: a threshold written down twice drifts.

/**
 * The ramp ladder, agreed with Doug 2026-09-17.
 *
 * One rung per week. The week is not caution, it is measurement: SENDING_HEALTH_WINDOW_DAYS
 * is 7, so a rung held for less than a week never gets a clean reading — the monitor's
 * window straddles two volumes and the rate it computes describes neither.
 *
 * 25 was the starting limit. 120/day is the target (600 a week).
 */
export const RAMP_LADDER = [25, 40, 55, 75, 95, 120] as const

/** Business days per week, the denominator behind every per-week figure here. */
export const SENDING_DAYS_PER_WEEK = 5

/**
 * THE LEAD LIMIT IS PINNED, AND GUARDED BY THE PLAN IT WAS MEASURED FOR.
 *
 * Measured 2026-09-17: plan "Growth", plan_id `pid_g_v2`, total_lead_limit 1000.
 *
 * It is pinned because the V2 REST API exposes no billing endpoint. Probed 2026-09-17,
 * all on a live key: `/workspaces/current` returns 200 but carries no lead-limit field,
 * and `/workspaces/current/billing/plan-details`, `/workspaces/current/billing` and
 * `/billing/plan-details` all return 404. The figure is visible only through the MCP
 * tool, which a script cannot call.
 *
 * A pinned number that nothing checks is how a stale constant outlives its truth, so the
 * collector reads `plan_id` from `/workspaces/current` and reports UNKNOWN — never a
 * limit — if it is not the plan this figure was measured against. The guard reads the
 * world; the constant only supplies what the world will not.
 */
export const MEASURED_PLAN_ID    = 'pid_g_v2'
export const MEASURED_LEAD_LIMIT = 1000

/** How far back uploads are counted to derive a weekly burn rate. */
export const BURN_LOOKBACK_DAYS = 28

/**
 * Below this many weeks of headroom on the lead cap, the report holds.
 *
 * Three, not one, because the fix is a plan upgrade rather than a setting: the 25,000-lead
 * add-on reads `can_purchase: false` with `advanced_outreach_plan_required`, so buying
 * headroom means changing plan first. Three weeks is time to do that without pausing.
 */
export const LEAD_CAPACITY_WARN_WEEKS = 3

/**
 * Below this many weeks of prospects pending upload, the report holds.
 *
 * Two, because sourcing a fresh cohort is a within-week operation, not a procurement one.
 */
export const INVENTORY_WARN_WEEKS = 2

/**
 * How old the newest row in sending_mailbox_daily_stats may be before bounce figures stop
 * being trusted.
 *
 * The 15-minute cron writes this table. A newest row older than this means the sync has
 * stopped, and a bounce count from a table that stopped updating reads as "no bounces"
 * while saying nothing at all. That reading is UNKNOWN, not zero.
 *
 * 48 hours rather than a few, because the campaign sends on business days only: a Monday
 * run legitimately sees Friday's rows as the newest sends.
 */
export const STATS_STALE_HOURS = 48
