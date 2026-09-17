// The six collectors. Vendor-free by construction: they talk to WatchProvider, never to
// a tool. Endpoint paths and field names live in the integrations layer (ADR-001).
//
// EVERY COLLECTOR RETURNS, NONE THROW. A collector that threw would abort the run and
// take the other five readings with it, leaving the operator with nothing instead of five
// sixths of a report and a named gap.
//
// EVERY SUPABASE READ CHECKS `error` EXPLICITLY. supabase-js returns { data, error } and
// sets data to null on failure, so `const { data } = await ...` turns a failed query into
// an empty result indistinguishable from a real zero. That is this module's own failure
// mode wearing a different coat, and it is the one that has to be got right here.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { evaluateSendingHealth, sendingHealthWindow, type MailboxDailyStat } from '@/lib/sending-health/evaluate'
import { rungFor } from './report'
import {
  BURN_LOOKBACK_DAYS,
  MEASURED_LEAD_LIMIT,
  MEASURED_PLAN_ID,
  RAMP_LADDER,
  SENDING_DAYS_PER_WEEK,
  STATS_STALE_HOURS,
} from './thresholds'
import {
  ok,
  unknown,
  type AccountStatuses,
  type BounceWindow,
  type Inventory,
  type LeadCapacity,
  type RampPosition,
  type Reading,
  type WarmupCanary,
  type WarmupMailbox,
  type WatchProvider,
} from './types'

type DB = SupabaseClient<Database>

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── The live campaign, read from our own records rather than hardcoded ───────

export interface LiveCampaign {
  externalId: string
  name:       string
}

/**
 * Finds the active cold-email campaign. Read from our records, not pinned in code, so a
 * new campaign does not silently leave the watch reporting on a retired one.
 */
export async function findLiveCampaign(db: DB): Promise<Reading<LiveCampaign>> {
  try {
    const { data, error } = await db
      .from('campaigns')
      .select('external_id, name, status')
      .eq('campaign_type', 'cold_email')
      .eq('status', 'active')
    if (error) return unknown(`campaigns query failed: ${error.code} ${error.message}`)
    const rows = (data ?? []).filter(r => typeof r.external_id === 'string' && r.external_id.length > 0)
    if (rows.length === 0) return unknown('no active cold_email campaign with an external_id in our records')
    if (rows.length > 1) {
      return unknown(`${rows.length} active cold_email campaigns; the watch reports on one and cannot choose`)
    }
    return ok({ externalId: rows[0].external_id as string, name: rows[0].name ?? '(unnamed)' })
  } catch (err) {
    return unknown(`campaign lookup threw: ${why(err)}`)
  }
}

// ── 1. Warmup canary ─────────────────────────────────────────────────────────

/**
 * landed_spam per mailbox. The canary: warmup degrades before prospect mail does.
 *
 * A mailbox we asked about and did not get back is reported in `missing`, never counted
 * as zero spam. That distinction is the difference between "this mailbox is clean" and
 * "we did not hear about this mailbox".
 */
export async function collectWarmupCanary(
  provider: WatchProvider,
  mailboxes: string[],
): Promise<Reading<WarmupCanary>> {
  if (mailboxes.length === 0) return unknown('no mailboxes to ask about (sender list was empty)')
  try {
    const placement = await provider.fetchWarmupPlacement(mailboxes)

    const rows: WarmupMailbox[] = []
    const missing: string[] = []
    for (const mailbox of mailboxes) {
      const found = placement.get(mailbox.trim().toLowerCase())
      if (!found) { missing.push(mailbox); continue }
      rows.push({ mailbox, ...found })
    }

    if (rows.length === 0) {
      return unknown(`provider returned usable warmup data for none of the ${mailboxes.length} mailbox(es)`)
    }
    return ok({ mailboxes: rows, totalLandedSpam: rows.reduce((a, m) => a + m.landedSpam, 0), missing })
  } catch (err) {
    return unknown(`warmup placement unreadable: ${why(err)}`)
  }
}

// ── 2. Per-domain bounces ────────────────────────────────────────────────────

/**
 * Reuses evaluateSendingHealth, which already keeps 'insufficient_sends' distinct from a
 * clean pass. Adds the one thing a stored table needs and the evaluator cannot know:
 * whether it is still being written to. A table whose sync stopped reports no bounces
 * indefinitely, which is the reassuring failure this whole module exists to refuse.
 */
export async function collectBounces(db: DB, now: Date): Promise<Reading<BounceWindow>> {
  try {
    const { start, end } = sendingHealthWindow(now)
    const { data, error } = await db
      .from('sending_mailbox_daily_stats')
      .select('stat_date, sending_domain, sends, bounces, fetched_at')
      .gte('stat_date', start)
      .lte('stat_date', end)
    if (error) return unknown(`sending_mailbox_daily_stats query failed: ${error.code} ${error.message}`)
    if (data === null) return unknown('sending_mailbox_daily_stats returned no data object')

    const { data: newest, error: freshErr } = await db
      .from('sending_mailbox_daily_stats')
      .select('fetched_at')
      .order('fetched_at', { ascending: false })
      .limit(1)
    if (freshErr) return unknown(`freshness probe failed: ${freshErr.code} ${freshErr.message}`)
    const freshestFetch = newest?.[0]?.fetched_at ?? null
    if (!freshestFetch) return unknown('no fetched_at anywhere in sending_mailbox_daily_stats — the sync has never run')

    const ageHours = (now.getTime() - new Date(freshestFetch).getTime()) / 3_600_000
    if (ageHours > STATS_STALE_HOURS) {
      return unknown(
        `bounce stats are stale: newest row fetched ${ageHours.toFixed(0)}h ago ` +
        `(limit ${STATS_STALE_HOURS}h). The sync has stopped, so a low bounce count here means nothing.`
      )
    }

    const rows: MailboxDailyStat[] = data.map(r => ({
      statDate: r.stat_date as string,
      domain:   r.sending_domain as string,
      sends:    r.sends ?? 0,
      bounces:  r.bounces ?? 0,
    }))

    return ok({ verdict: evaluateSendingHealth(rows, now), freshestFetch })
  } catch (err) {
    return unknown(`bounce window unreadable: ${why(err)}`)
  }
}

// ── 3. Account status ────────────────────────────────────────────────────────

export async function collectAccounts(
  provider: WatchProvider,
  expected: string[],
): Promise<Reading<AccountStatuses>> {
  if (expected.length === 0) return unknown('campaign returned no sender list to check')
  try {
    const seen = await provider.fetchAccountStatuses()

    const accounts = []
    const missing: string[] = []
    for (const mailbox of expected) {
      const found = seen.get(mailbox.trim().toLowerCase())
      if (!found) { missing.push(mailbox); continue }
      accounts.push({ mailbox, active: found.active, warmupActive: found.warmupActive })
    }
    if (accounts.length === 0) return unknown(`provider listed none of the ${expected.length} campaign senders`)

    return { status: 'ok', value: {
      expected,
      accounts,
      inactive: accounts.filter(a => !a.active).map(a => a.mailbox),
      missing,
    } }
  } catch (err) {
    return unknown(`account list unreadable: ${why(err)}`)
  }
}

// ── 4. Ramp position ─────────────────────────────────────────────────────────

export interface CampaignShape {
  dailyLimit: number
  senders:    string[]
}

export async function fetchCampaign(
  provider: WatchProvider,
  externalId: string,
): Promise<Reading<CampaignShape>> {
  try {
    return ok(await provider.fetchCampaignShape(externalId))
  } catch (err) {
    return unknown(`campaign unreadable: ${why(err)}`)
  }
}

export function rampFrom(campaign: CampaignShape): RampPosition {
  const domains = new Set(
    campaign.senders.map(s => s.split('@')[1]?.toLowerCase()).filter((d): d is string => Boolean(d)),
  )
  const domainCount = domains.size
  const { rung, nextRung } = rungFor(campaign.dailyLimit)
  return {
    dailyLimit:       campaign.dailyLimit,
    mailboxCount:     campaign.senders.length,
    domainCount,
    perMailboxPerDay: campaign.dailyLimit / campaign.senders.length,
    perDomainPerWeek: domainCount > 0 ? (campaign.dailyLimit * SENDING_DAYS_PER_WEEK) / domainCount : 0,
    rung,
    ladderLength:     RAMP_LADDER.length,
    nextRung,
  }
}

// ── 5. Lead cap ──────────────────────────────────────────────────────────────

/**
 * The limit is pinned (see thresholds.ts) but GUARDED: the plan is read live, and a plan
 * that is not the one the limit was measured for reports unknown rather than a number
 * nobody can stand behind.
 */
export async function collectLeadCapacity(
  provider: WatchProvider,
  burnPerWeek: number | null,
): Promise<Reading<LeadCapacity>> {
  try {
    const planId = await provider.fetchPlanId()
    if (planId !== MEASURED_PLAN_ID) {
      return unknown(
        `plan is ${planId}, but the ${MEASURED_LEAD_LIMIT} lead limit was measured for ` +
        `${MEASURED_PLAN_ID} on 2026-09-17. Re-measure before trusting a number.`
      )
    }

    const counts = await provider.fetchCampaignLeadCounts()
    const used = counts.reduce((a, n) => a + n, 0)
    const remaining = MEASURED_LEAD_LIMIT - used

    return ok({
      planId,
      limit:          MEASURED_LEAD_LIMIT,
      used,
      remaining,
      burnPerWeek,
      weeksRemaining: burnPerWeek !== null && burnPerWeek > 0 ? remaining / burnPerWeek : null,
    })
  } catch (err) {
    return unknown(`lead capacity unreadable: ${why(err)}`)
  }
}

// ── 6. Inventory and the burn rate behind it ─────────────────────────────────

/**
 * Uploads per week over the lookback.
 *
 * Returns null, never 0, when nothing was uploaded in the window. Zero burn would divide
 * into "infinite weeks of headroom", the most reassuring number on the report, and would
 * be produced by a campaign that had stopped sending entirely.
 */
export async function collectBurnPerWeek(db: DB, now: Date): Promise<Reading<number | null>> {
  try {
    const since = new Date(now.getTime() - BURN_LOOKBACK_DAYS * 86_400_000).toISOString()
    const { count, error } = await db
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('outbound_upload_status', 'uploaded')
      .gte('outbound_upload_attempted_at', since)
    if (error) return unknown(`burn-rate query failed: ${error.code} ${error.message}`)
    if (count === null) return unknown('burn-rate query returned no count')
    return ok(count === 0 ? null : count / (BURN_LOOKBACK_DAYS / 7))
  } catch (err) {
    return unknown(`burn rate unreadable: ${why(err)}`)
  }
}

export async function collectInventory(db: DB, burnPerWeek: number | null): Promise<Reading<Inventory>> {
  try {
    const { count, error } = await db
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('outbound_upload_status', 'pending')
    if (error) return unknown(`pending-prospect query failed: ${error.code} ${error.message}`)
    if (count === null) return unknown('pending-prospect query returned no count')
    return ok({
      pending:          count,
      burnPerWeek,
      weeksOfInventory: burnPerWeek !== null && burnPerWeek > 0 ? count / burnPerWeek : null,
    })
  } catch (err) {
    return unknown(`inventory unreadable: ${why(err)}`)
  }
}
