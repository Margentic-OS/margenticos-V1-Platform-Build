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
// It also refreshes campaign aggregates and, since 2026-08-27, PER-DOMAIN SENDING HEALTH:
// daily sends and bounces per sending mailbox, rolled up per sending domain and written
// as the verdict MON-023 reads. That rides here rather than in its own cron because the
// 15-minute cadence is what MON-023's 60-minute freshness limit is calibrated against.
// It is dispatched through the can_report_sending_health capability, not a named tool.
//
// Failures are isolated per event type: a bounce polling failure does not abort
// reply polling. Each type reports independently in the response.
//
// It also CARRIES SUPPRESSIONS TO THE PROVIDER, since 2026-09-04. Detection writes an
// address to the global suppression list; carrying it out to the sending provider is what
// actually stops mail to somebody already mid-sequence, and until now that only happened
// while this poll could still see the bounced lead. The sweep is driven off the suppression
// ROW instead, so an address whose campaign was unregistered, deleted or archived still gets
// carried. It rides here because this is already the bounce path's cron and already a write
// path to the provider; the reconciliation sweep stays separate on purpose, because an
// instrument must not audit its own writes.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
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
import { fetchCampaignSendingStatus, SENDING_STATES_NEEDING_ATTENTION } from '@/lib/integrations/handlers/instantly/campaign-sending-status'
import { getInstantlyApiKey, getInstantlyApiActive } from '@/lib/integrations/handlers/instantly/auth'
import { syncSendingHealth } from '@/lib/sending-health/sync'
import { reconcileReplies } from '@/lib/reply-handling/reconcile'
import { carryPendingSuppressions, type CarryVerdict } from '@/lib/suppression/carry'
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

  const supabase = asServiceRoleClient(createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ))

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

  // ── Carry suppressions to the provider ──────────────────────────────────────
  //
  // Runs after the three polls so that anything detected THIS run is included rather than
  // waiting for the next one. Everything here is idempotent: a confirmed row is never
  // selected again, and re-stopping an already-stopped lead is a no-op at the provider.
  //
  // A carry failure does NOT make the run fail. That is deliberate and it is the same
  // judgement the poller makes inline. One address the provider will not answer for would
  // otherwise hold this heartbeat red permanently, and a permanently red heartbeat cannot
  // report the NEXT failure — it would mask exactly the poll outage this instrumentation
  // exists to catch. The failure is on the suppression row, in Sentry, in the detail line
  // below, and in MON-026, which is the instrument built for this question.
  let carryVerdict: CarryVerdict = {
    activeCount: 0, pendingCount: 0, carriedCount: 0, failedCount: 0,
    noOrgCount: 0, backoffCount: 0, incomplete: false,
    detail: 'Suppression carry did not run.',
  }
  try {
    carryVerdict = await carryPendingSuppressions(supabase)
    logger.info('Instantly poll: suppression carry complete', {
      active: carryVerdict.activeCount,
      pending: carryVerdict.pendingCount,
      carried: carryVerdict.carriedCount,
      failed: carryVerdict.failedCount,
      no_org: carryVerdict.noOrgCount,
      backoff: carryVerdict.backoffCount,
      incomplete: carryVerdict.incomplete,
    })
    if (carryVerdict.failedCount > 0 || carryVerdict.noOrgCount > 0) {
      Sentry.captureException(
        new Error(
          `Suppression carry: ${carryVerdict.failedCount} address(es) not carried to the ` +
          `provider, ${carryVerdict.noOrgCount} with no organisation context`,
        ),
        { level: 'warning', extra: { carry: carryVerdict } },
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Instantly poll: suppression carry threw unexpectedly', { error: msg })
    carryVerdict = { ...carryVerdict, incomplete: true, detail: `Suppression carry threw: ${msg}` }
  }

  // ── Campaign stats, status, and live sending health refresh ────────────────
  // Runs after reply polling. Failures here are isolated and never affect reply polling.
  // One analytics call returns every campaign in the workspace; each local row is then
  // updated from the map, plus ONE sending-status call per resolved campaign, which is
  // the only per-campaign call in the pass because Instantly offers no bulk form of it.
  //
  // Two different questions are answered here and they must never be conflated.
  // status is INTENT, copied from Instantly's campaign_status. sending_state is LIVE
  // HEALTH, read from GET /campaigns/{id}/sending-status where 'healthy' is the only
  // unobstructed value. A campaign can be 'active' and sending nothing.
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
  // 'skipped' used to live here and counted the miss below. It is gone rather than left
  // at zero: a campaign the refresh could not do its job for is a failure, not a skip,
  // and a field that can only ever read 0 invites someone to trust it.
  // missingAnalytics is a BREAKDOWN of errors, not a separate total: every increment of
  // it also increments errors, which is the number runOk reads.
  const campaignStatsResult = { updated: 0, errors: 0, statusChanged: 0, missingAnalytics: 0, sendingChecked: 0, sendingErrors: 0 }
  // First failure of the refresh, carried into the heartbeat detail so the row names a
  // cause instead of just a count. Mirrors the poller's last_error discipline; campaign
  // stats has no polling_cursors row of its own, so the heartbeat is where it goes.
  let firstCampaignStatsError: string | null = null
  try {
    const statsMap = await fetchCampaignStats(apiKey, isActive, baseUrl)

    const { data: registeredCampaigns } = await supabase
      .from('campaigns')
      .select('id, external_id, status, sending_state')
      .not('external_id', 'is', null)

    for (const campaign of registeredCampaigns ?? []) {
      if (!campaign.external_id) continue
      const stats = statsMap.get(campaign.external_id)
      if (!stats) {
        // A registered external_id that the workspace-wide analytics call does not know
        // about. This is NOT "nothing to do". It is a campaigns row pointing at a
        // campaign that does not exist in Instantly, and its counters and status will
        // stay null forever with no other symptom. Counting it as a skip is what let two
        // mock rows sit in the table reporting a clean run.
        //
        // Named, counted, and carried into runOk, which is the same standard the poller
        // holds: a pass that could not do its job must not report clean.
        const detail = `campaign ${campaign.id} external_id ${campaign.external_id} has no Instantly analytics row`
        logger.error('Campaign stats refresh: no analytics row for a registered external_id', {
          campaign_id: campaign.id,
          external_id: campaign.external_id,
          fix: 'Either the campaign was deleted in Instantly, or campaigns.external_id holds a value that was never a real Instantly campaign. Clear external_id or point it at a real campaign.',
        })
        campaignStatsResult.errors++
        campaignStatsResult.missingAnalytics++
        if (firstCampaignStatsError === null) firstCampaignStatsError = detail
        continue
      }

      // Instantly is the source of truth for whether a campaign is sending. The handler
      // has already translated its numeric campaign_status into our four-value column;
      // nothing here sees an Instantly status integer except to name it in a log.
      const update: {
        sent_count: number
        replied_count: number
        bounced_count: number
        contacted_count?: number
        unsubscribed_count: number
        campaign_stats_updated_at: string
        status?: string
        sending_state?: string | null
        sending_status_raw?: string | null
        sending_status_checked_at?: string
      } = {
        sent_count:    stats.sentCount,
        replied_count: stats.repliedCount,
        bounced_count: stats.bouncedCount,
        unsubscribed_count: stats.unsubscribedCount,
        campaign_stats_updated_at: new Date().toISOString(),
      }

      // PEOPLE, not emails. A four-step sequence sends up to four emails to one person,
      // so sent_count over-counts prospects the moment a follow-up goes out. The client
      // overview says "prospects contacted" and has to read this.
      if (stats.contactedCount === null) {
        // The handler refused the value: absent, or larger than the campaign's own lead
        // count. Leave the stored number alone rather than writing one that cannot be
        // people. Same treatment as an unrecognised status below, for the same reason.
        logger.warn('Campaign stats refresh: no usable contacted count, column left unchanged', {
          campaign_id: campaign.id,
          external_id: campaign.external_id,
          leads_count: stats.leadsCount,
          fix: 'Check new_leads_contacted_count in the Instantly analytics response against the measurement recorded in campaign-analytics.ts',
        })
      } else {
        update.contacted_count = stats.contactedCount
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

      // ── Live sending health ──────────────────────────────────────────────
      //
      // status above is INTENT. It says what someone meant this campaign to do, and a
      // campaign at 'active' can be sending nothing: outside its schedule, out of leads,
      // at its daily cap, or with every account already at its own cap. The client
      // dashboard prints the word live off THIS value, never off status, because
      // "your campaign is active" while the accounts are at limit is not a smaller lie
      // than the placeholder copy it replaced.
      //
      // One call per campaign: Instantly offers no bulk form of this endpoint. It runs
      // only for campaigns the analytics map already resolved, so a row pointing at a
      // deleted campaign fails once above rather than twice.
      //
      // A failure here does NOT abandon the counters. They came from the analytics call
      // and are still good, so the update below still writes them; only the sending
      // fields are left out, which leaves the previous reading in place with its old
      // sending_status_checked_at. A stale timestamp is what tells the dashboard not to
      // trust the value, so leaving both untouched together is the honest failure.
      try {
        const sending = await fetchCampaignSendingStatus(campaign.external_id, apiKey, isActive, baseUrl)
        update.sending_state             = sending.state
        update.sending_status_raw        = sending.rawStatus
        update.sending_status_checked_at = new Date().toISOString()
        campaignStatsResult.sendingChecked++

        // Instantly answered and carried no status. Documented behaviour, not a failure:
        // the endpoint returns null for both fields when it has no data yet. The state is
        // cleared rather than left stale, and the timestamp is still stamped, because
        // "we asked and Instantly had nothing" is a different fact from "we never asked".
        if (sending.state === null) {
          logger.info('Campaign sending-status: no state established, previous reading cleared', {
            campaign_id: campaign.id,
            external_id: campaign.external_id,
            raw_status: sending.rawStatus,
          })
        } else if (SENDING_STATES_NEEDING_ATTENTION.includes(sending.state)) {
          // 'waiting' and 'limit_reached' clear themselves. 'blocked' does not: every code
          // behind it needs a human. Logged every tick it persists, on purpose.
          logger.warn('Campaign sending-status: sending is blocked and will not resume on its own', {
            campaign_id: campaign.id,
            external_id: campaign.external_id,
            raw_status: sending.rawStatus,
            previous_state: campaign.sending_state,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const detail = `campaign ${campaign.id} sending-status failed: ${msg}`
        logger.error('Campaign sending-status: fetch failed, sending health left unchanged', {
          campaign_id: campaign.id,
          external_id: campaign.external_id,
          error: msg,
        })
        campaignStatsResult.errors++
        campaignStatsResult.sendingErrors++
        if (firstCampaignStatsError === null) firstCampaignStatsError = detail
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
        if (firstCampaignStatsError === null) {
          firstCampaignStatsError = `campaign ${campaign.id} update failed: ${updateError.message}`
        }
      } else {
        campaignStatsResult.updated++
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Campaign stats refresh: threw unexpectedly', { error: msg })
    campaignStatsResult.errors++
    if (firstCampaignStatsError === null) firstCampaignStatsError = `campaign stats threw: ${msg}`
  }

  // ── Per-domain sending health ──────────────────────────────────────────────
  //
  // Rides along with this cron rather than getting its own, because everything it needs
  // is already resolved here and the 15-minute cadence is what MON-023's 60-minute
  // freshness limit is calibrated against: four consecutive misses before the monitor
  // stops trusting the verdict.
  //
  // Isolated like every other resource in this route. syncSendingHealth never throws, so
  // a sending-health failure cannot abort a poll that has already written signals, but
  // its errors DO count toward totalErrors so a silent failure cannot report ok: true.
  //
  // Tool-agnostic: this calls the capability, not a vendor. See sync.ts.
  const sendingHealthResult = await syncSendingHealth(supabase)
  if (sendingHealthResult.errors.length > 0) {
    logger.error('Sending health: sync reported errors', { errors: sendingHealthResult.errors })
    if (firstCampaignStatsError === null) {
      firstCampaignStatsError = `sending health: ${sendingHealthResult.errors[0]}`
    }
  }

  // ── Reply reconciliation (MON-029) ─────────────────────────────────────────
  //
  // Rides along here for the same reasons sending health does: the campaign list, the API
  // key and the provider client are already resolved, and the 15-minute cadence is what
  // MON-029's 90-minute freshness limit is calibrated against.
  //
  // AFTER the poll, never before. It asks whether every reply the provider holds has a
  // signal row, so running it before pollInstantlyReplies would report this run's replies
  // as missing every single time and rest permanently red.
  //
  // Its own failures set `incomplete` on the snapshot rather than throwing, and MON-029
  // treats incomplete as not-OK. They deliberately do NOT feed totalErrors: this sweep is
  // an auditor of the poll, and letting the auditor turn the poll's heartbeat red would
  // conflate "the poll failed" with "the audit could not finish".
  //
  // WHY THIS SITS INSIDE THE ROUTE IT AUDITS, when the header above says the suppression
  // reconciliation was kept out of its writer for exactly that reason. The two cases differ
  // in what is being audited:
  //
  //   MON-026  audits the suppression CARRY, and the carry's own idea of "confirmed" was the
  //            thing in doubt. An auditor sharing that code would share the doubt.
  //   MON-029  audits the reply CURSOR — whether the poller stepped over an event. The
  //            reconciler does not use the cursor at all: it enumerates each campaign from
  //            scratch every sweep. It shares only instantlyGet, the HTTP transport, and
  //            that sharing is deliberate and load-bearing, because comparing objects
  //            fetched two different ways would differ for reasons other than a lost reply.
  //
  // And it fails closed rather than open: if instantlyGet is broken the sweep reports
  // unreachable, which is PROBLEM, not a pass. If the whole route dies, MON-029's freshness
  // clause goes red on its own. Neither failure mode can produce a false all-clear.
  const reconciliation = await reconcileReplies(supabase, apiKey, baseUrl, isActive)

  const { error: reconcileWriteError } = await supabase
    .from('reply_reconciliation_snapshot')
    .upsert({
      id: 1,
      campaigns_checked: reconciliation.campaignsChecked,
      provider_reply_count: reconciliation.providerReplyCount,
      stored_reply_count: reconciliation.storedReplyCount,
      missing_count: reconciliation.missingCount,
      unreachable_campaigns: reconciliation.unreachableCampaigns,
      incomplete: reconciliation.incomplete,
      missing_sample: reconciliation.missingSample,
      detail: reconciliation.detail,
      computed_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (reconcileWriteError) {
    // The snapshot not being written is what MON-029's freshness clause exists to catch,
    // so this cannot pass silently even though it does not fail the poll.
    logger.error('Reply reconciliation: snapshot write failed', { error: reconcileWriteError.message })
  }

  // ── Summary log ────────────────────────────────────────────────────────────
  const totalErrors =
    results.replies.errors +
    results.bounces.errors +
    results.unsubscribes.errors +
    sendingHealthResult.errors.length +
    // Campaign stats failures now count. They did not before, so a refresh that could not
    // resolve a single campaign still returned ok: true and stamped the Sentry check-in
    // 'ok'. That is the same silence the poller instrumentation removed, left behind in
    // the one block the earlier pass did not cover.
    campaignStatsResult.errors
  const totalWritten = results.replies.written + results.bounces.written + results.unsubscribes.written

  // ── The ok rule ────────────────────────────────────────────────────────────
  //
  // ok is true only when BOTH hold:
  //   1. every resource that issued at least one Instantly call got at least one
  //      successful response back (attempted && !polled means every call for that
  //      resource failed), and
  //   2. no campaign-level or signal-level failure was recorded anywhere, INCLUDING in
  //      the campaign stats refresh.
  //
  // EXPECT THIS TO GO RED IMMEDIATELY, and that is the point. Two rows in campaigns hold
  // mock external_ids that were never real Instantly campaigns, so every run will report
  // ok: false and name them until they are cleaned. They are reported, not deleted: the
  // data is the operator's to fix, and a red heartbeat naming the offending external_id
  // is the mechanism that makes them impossible to keep ignoring.
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
    sending_health: sendingHealthResult,
    suppression_carry: carryVerdict,
  })

  // ── Record heartbeat ───────────────────────────────────────────────────────────
  await supabase
    .from('cron_heartbeats')
    .insert({
      job_name: 'instantly-poll',
      ok: runOk,
      detail: runOk
        ? `Polled: ${totalWritten} signals written, ${campaignStatsResult.updated} campaign(s) refreshed, ${campaignStatsResult.sendingChecked} sending-status check(s). ${carryVerdict.detail}`
        // Name the first campaign-stats cause when there is one. A count alone sends the
        // reader to the logs; the external_id sends them to the row that needs fixing.
        : `Run failed: ${totalErrors} error(s), ${resourcesThatFailedToPoll} resource(s) reached zero successful Instantly calls` +
          (firstCampaignStatsError ? `. Campaign stats: ${firstCampaignStatsError}` : '') +
          `. ${carryVerdict.detail}`,
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
        `${resourcesThatFailedToPoll} resource(s) with zero successful calls` +
        (firstCampaignStatsError ? `, campaign stats: ${firstCampaignStatsError}` : '')
      ),
      { level: 'error', extra: { results, campaign_stats: campaignStatsResult } }
    )
  }
  try { await Sentry.flush(2000) } catch {}

  return NextResponse.json({
    ok: runOk,
    results,
    campaign_stats: campaignStatsResult,
    sending_health: sendingHealthResult,
    suppression_carry: carryVerdict,
  })
}
