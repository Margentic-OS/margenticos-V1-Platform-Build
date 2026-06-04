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
import { fetchCampaignStats } from '@/lib/integrations/handlers/instantly/campaign-analytics'
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
    replies:       { written: 0, skipped: 0, errors: 0 },
    bounces:       { written: 0, skipped: 0, errors: 0 },
    unsubscribes:  { written: 0, skipped: 0, errors: 0 },
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

  // ── Campaign stats refresh ─────────────────────────────────────────────────
  // Runs after reply polling. Failures here are isolated and never affect reply polling.
  // Fetches all campaign analytics in one API call, then updates each active campaign row.
  // Future: if active campaign count exceeds ~50, consider batching with concurrency limit.
  const campaignStatsResult = { updated: 0, skipped: 0, errors: 0 }
  try {
    const statsMap = await fetchCampaignStats(apiKey, baseUrl)

    const { data: activeCampaigns } = await supabase
      .from('campaigns')
      .select('id, external_id')
      .eq('status', 'active')
      .not('external_id', 'is', null)

    for (const campaign of activeCampaigns ?? []) {
      if (!campaign.external_id) continue
      const stats = statsMap.get(campaign.external_id)
      if (!stats) {
        campaignStatsResult.skipped++
        continue
      }
      const { error: updateError } = await supabase
        .from('campaigns')
        .update({
          sent_count:    stats.sentCount,
          replied_count: stats.repliedCount,
          bounced_count: stats.bouncedCount,
          campaign_stats_updated_at: new Date().toISOString(),
        })
        .eq('id', campaign.id)

      if (updateError) {
        logger.error('Campaign stats refresh: DB update failed', {
          campaign_id: campaign.id,
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

  logger.info('Instantly poll: run complete', {
    total_written: totalWritten,
    total_errors: totalErrors,
    ...results,
    campaign_stats: campaignStatsResult,
  })

  Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'ok', checkInId })
  try { await Sentry.flush(2000) } catch {}
  return NextResponse.json({
    ok: true,
    results,
    campaign_stats: campaignStatsResult,
  })
}
