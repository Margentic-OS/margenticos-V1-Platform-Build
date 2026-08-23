// POST /api/cron/instantly-poll
//
// Called by Supabase pg_cron every 15 minutes via pg_net HTTP POST.
// Fetches new events from Instantly V2 and writes them to the signals table.
//
// Three event types are polled:
//   reply_received      — new replies in the Instantly inbox (cursor-based)
//   email_bounced       — all leads with bounced status (full scan + idempotency)
//   lead_unsubscribed   — all leads with unsubscribed status (full scan + idempotency)
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Same pattern as /api/cron/auto-approve.
//
// Uses service_role — acts as a system process, not a user. Required to write
// to signals and read integration_credentials without RLS interference.
//
// Failures are isolated per event type: a bounce polling failure does not abort
// reply polling. Each type reports independently in the response.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import {
  pollInstantlyReplies,
  pollInstantlyLeadStatus,
  INSTANTLY_LEAD_STATUS_BOUNCED,
  INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
} from '@/lib/integrations/polling/instantly'
import { fetchCampaignStats, INSTANTLY_ABNORMAL_STOP_STATUSES } from '@/lib/integrations/handlers/instantly/campaign-analytics'
import { getInstantlyApiKey, getInstantlyApiActive } from '@/lib/integrations/handlers/instantly/auth'
import { resolveInstantlyBaseUrl } from '@/lib/integrations/handlers/instantly/constants'

const MONITOR_SLUG = 'instantly-poll'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '*/15 * * * *' },
  checkinMargin: 15,
  maxRuntime: 1,
  timezone: 'UTC',
}

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG
  )

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Resolve API key + base URL ─────────────────────────────────────────────
  let apiKey: string
  try {
    apiKey = await getInstantlyApiKey('')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Instantly poll: API key not found in integration_credentials', { error: msg })
    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'error', checkInId })
    try { await Sentry.flush(2000) } catch {}
    return NextResponse.json(
      { error: 'Instantly API key not configured.' },
      { status: 503 }
    )
  }

  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  const results = {
    replies:       { written: 0, skipped: 0, errors: 0, attempted: false, polled: false },
    bounces:       { written: 0, skipped: 0, errors: 0, attempted: false, polled: false },
    unsubscribes:  { written: 0, skipped: 0, errors: 0, attempted: false, polled: false },
  }

  // ── Poll replies ────────────────────────────────────────────────────────────
  try {
    results.replies = await pollInstantlyReplies(supabase, apiKey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Instantly poll: reply polling threw unexpectedly', { error: msg })
    results.replies.errors++
  }

  // ── Poll bounces ────────────────────────────────────────────────────────────
  try {
    results.bounces = await pollInstantlyLeadStatus(
      supabase,
      apiKey,
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Instantly poll: bounce polling threw unexpectedly', { error: msg })
    results.bounces.errors++
  }

  // ── Poll unsubscribes ───────────────────────────────────────────────────────
  try {
    results.unsubscribes = await pollInstantlyLeadStatus(
      supabase,
      apiKey,
      INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      'lead_unsubscribed'
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Instantly poll: unsubscribe polling threw unexpectedly', { error: msg })
    results.unsubscribes.errors++
  }

  // ── Campaign stats and status refresh ──────────────────────────────────────
  // Runs after reply polling. Failures here are isolated and never affect reply polling.
  // One analytics call returns every campaign in the workspace; each local row is then
  // updated from the map with no further API calls.
  //
  // WHY THERE IS NO LONGER A status FILTER HERE.
  // This query used to carry .eq('status', 'active'). That filter was not merely
  // redundant alongside external_id IS NOT NULL, it was SELF-DEFEATING, and it is the
  // whole of the bug this loop now fixes.
  //
  // campaigns.status is written by nothing except the creation insert, which hardcodes
  // 'draft'. This loop is now the only thing that ever moves it. So filtering the loop on
  // the column the loop maintains is a deadlock: a campaign stuck at 'draft' can only be
  // corrected by the refresh, and the filter excluded it from the refresh before the
  // correction could run. cf695496 sat at 'draft' locally while Instantly reported it
  // Active and sending, and no number of ticks could ever have freed it.
  //
  // external_id IS NOT NULL is the correct and sufficient scope: it means "this campaign
  // exists in Instantly", which is exactly the set the analytics map can answer for.
  // Keeping a status filter as well would only reintroduce the same desync later.
  // It is also right on the merits: a paused or completed campaign still needs its final
  // counters, and its status still needs to track Instantly if it is resumed there.
  //
  // The lead-status poller already scans on external_id alone, so the two now agree.
  const campaignStatsResult = { updated: 0, skipped: 0, errors: 0, statusChanged: 0 }
  try {
    const statsMap = await fetchCampaignStats(apiKey, isActive, baseUrl)

    const { data: registeredCampaigns } = await supabase
      .from('campaigns')
      .select('id, external_id, status')
      .not('external_id', 'is', null)

    for (const campaign of registeredCampaigns ?? []) {
      if (!campaign.external_id) continue
      const stats = statsMap.get(campaign.external_id)
      if (!stats) {
        campaignStatsResult.skipped++
        continue
      }

      // Instantly is the source of truth for whether a campaign is sending. The handler
      // has already translated its numeric campaign_status into our four-value column;
      // nothing here sees an Instantly status integer except to name it in a log.
      const update: {
        sent_count: number
        replied_count: number
        bounced_count: number
        campaign_stats_updated_at: string
        status?: string
      } = {
        sent_count:    stats.sentCount,
        replied_count: stats.repliedCount,
        bounced_count: stats.bouncedCount,
        campaign_stats_updated_at: new Date().toISOString(),
      }

      if (stats.status === null) {
        // Unmapped means Instantly sent a value outside its own documented enum, or sent
        // none at all. Do not write a guess into a column the dashboard renders. Say so
        // and leave the stored value alone; the counters above are still good.
        logger.warn('Campaign status sync: unrecognised campaign_status, status left unchanged', {
          campaign_id: campaign.id,
          external_id: campaign.external_id,
          raw_status: stats.rawStatus,
          fix: 'Check Instantly campaign_status against the enum in campaign-analytics.ts',
        })
      } else {
        update.status = stats.status
        if (stats.status !== campaign.status) campaignStatsResult.statusChanged++

        // All three abnormal stops store as plain 'paused', so the stored value cannot
        // tell an account suspension apart from an operator clicking pause. Log the real
        // state so the difference survives somewhere an operator can find it.
        if (stats.rawStatus !== null && INSTANTLY_ABNORMAL_STOP_STATUSES.includes(stats.rawStatus)) {
          logger.warn('Campaign status sync: campaign stopped by Instantly, not by us', {
            campaign_id: campaign.id,
            external_id: campaign.external_id,
            raw_status: stats.rawStatus,
            stored_as: stats.status,
            meaning: stats.rawStatus === -99 ? 'Account Suspended'
                   : stats.rawStatus === -1  ? 'Accounts Unhealthy'
                   : 'Bounce Protect',
          })
        }
      }

      const { error: updateError } = await supabase
        .from('campaigns')
        .update(update)
        .eq('id', campaign.id)

      if (updateError) {
        logger.error('Campaign stats refresh: DB update failed', {
          campaign_id: campaign.id,
          external_id: campaign.external_id,
          error: updateError.message,
        })
        campaignStatsResult.errors++
      } else {
        campaignStatsResult.updated++
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Campaign stats refresh: threw unexpectedly', { error: msg })
    campaignStatsResult.errors++
  }

  // ── Summary log ────────────────────────────────────────────────────────────
  const totalErrors = results.replies.errors + results.bounces.errors + results.unsubscribes.errors
  const totalWritten = results.replies.written + results.bounces.written + results.unsubscribes.written

  // ── The ok rule ────────────────────────────────────────────────────────────
  //
  // ok is true only when BOTH hold:
  //   1. every resource that issued at least one Instantly call got at least one
  //      successful response back (attempted && !polled means every call for that
  //      resource failed), and
  //   2. no campaign-level or signal-level failure was recorded anywhere.
  //
  // A run in which every campaign errored fails both clauses and returns ok: false.
  //
  // A resource that was never attempted — no registered campaigns — is NOT a failure.
  // It reports attempted: false and polled: false in the response, so "nothing to poll"
  // stays visible without being counted as an error.
  //
  // This value drives all three instruments together: the DB heartbeat, the Sentry
  // check-in, and the HTTP response. Previously the heartbeat used it and the other
  // two were hardcoded to success, so a run that failed every call still read green.
  const resourceResults = [results.replies, results.bounces, results.unsubscribes]
  const resourcesThatFailedToPoll = resourceResults.filter(r => r.attempted && !r.polled).length
  const runOk = totalErrors === 0 && resourcesThatFailedToPoll === 0

  logger.info('Instantly poll: run complete', {
    ok: runOk,
    total_written: totalWritten,
    total_errors: totalErrors,
    resources_failed_to_poll: resourcesThatFailedToPoll,
    ...results,
    campaign_stats: campaignStatsResult,
  })

  // ── Record heartbeat ───────────────────────────────────────────────────────────
  await supabase
    .from('cron_heartbeats')
    .insert({
      job_name: 'instantly-poll',
      ok: runOk,
      detail: runOk
        ? `Polled: ${totalWritten} signals written, campaign stats updated`
        : `Run failed: ${totalErrors} error(s), ${resourcesThatFailedToPoll} resource(s) reached zero successful Instantly calls`,
    })
    .throwOnError()

  // Sentry check-in must carry the real outcome, and must be flushed before the
  // serverless function returns or the event is dropped.
  Sentry.captureCheckIn({
    monitorSlug: MONITOR_SLUG,
    status: runOk ? 'ok' : 'error',
    checkInId,
  })
  if (!runOk) {
    Sentry.captureException(
      new Error(
        `Instantly poll run failed: ${totalErrors} error(s), ` +
        `${resourcesThatFailedToPoll} resource(s) with zero successful calls`
      ),
      { level: 'error', extra: { results, campaign_stats: campaignStatsResult } }
    )
  }
  try { await Sentry.flush(2000) } catch {}

  return NextResponse.json({
    ok: runOk,
    results,
    campaign_stats: campaignStatsResult,
  })
}
