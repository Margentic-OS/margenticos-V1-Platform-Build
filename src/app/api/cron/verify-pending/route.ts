// POST /api/cron/verify-pending
//
// Called by Supabase pg_cron every 10 minutes. Verifies enriched prospects that have no
// verdict yet, one organisation per invocation, oldest backlog first.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Service role, same as the queue worker: it
// acts as a system process and reads across every organisation to find work.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS AT ALL
//
// Verification had exactly one caller: an operator route with no button, no cron and no job
// type. All 29 verdicts in the database were written by a manual script in one window on
// 2026-08-10. Nothing has verified an address since.
//
// That became load-bearing on 2026-08-25, when the research spend gate started FAILING
// CLOSED on a missing verdict. A prospect with no verdict is now refused research, so a
// verification step that never runs does not degrade the pipeline, it silently halts it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A CRON AND NOT A FOURTH QUEUE JOB TYPE
//
// The queue exists to protect EXPENSIVE, NON-IDEMPOTENT calls. Its central mechanism is
// ctx.paid(), which stamps spend the instant an external call returns so a reclaimed job
// can never pay twice. That machinery earns its keep for research at ~$0.20 and ~170s per
// prospect, and for Apollo, where a re-spend buys the same contact again.
//
// Verification is the opposite of that: an idempotent lookup against a free tier, where the
// worst case of running twice is one wasted call out of 100 per day. There is no spend to
// stamp and nothing to protect. A fourth job type would cost JOB_TYPES, a config entry, a
// flag row, a handler map entry, an executor, an enqueue helper, three test files that
// enumerate job types, and a migration to drop and recreate the job_queue_type_valid CHECK
// constraint — to buy a guarantee that does not apply.
//
// If verification ever becomes paid per address, revisit this. The trigger for that is a
// price on the call, not a growth in volume.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { verifyEnrichedBatch, DEFAULT_VERIFY_BATCH_SIZE } from '@/lib/sourcing/verification-trigger'

export const dynamic = 'force-dynamic'
// The trigger sleeps 2s per address for rate limiting, so a batch is mostly deliberate
// waiting. Same ceiling and same reasoning as every other long route in this repo.
export const maxDuration = 300

/**
 * THE INSTRUMENTATION RULE, copied deliberately from the queue-worker route.
 *
 * One value drives all three instruments: the cron_heartbeats row, the Sentry check-in, and
 * the HTTP response body. They cannot disagree.
 *
 * THIS ROUTE SHIPPED WITHOUT THE HEARTBEAT and that was a real gap, not a tidiness one.
 * MON-002 derives liveness from max(ran_at) staleness in cron_heartbeats alone, so a sweep
 * that writes no row is INVISIBLE to monitoring: it could stop running entirely and nothing
 * would say so. That is the exact shape of the Instantly poller that ran dead for four
 * months. A scheduled job that cannot be observed is a scheduled job you do not have.
 *
 * Note the known limit of MON-002, inherited rather than introduced: it reads staleness and
 * never consults cron_heartbeats.ok, so a sweep that runs on time and fails every time still
 * reads OK there. The ok column is still written honestly for anything that does read it,
 * and the Sentry check-in carries the same value.
 */
async function writeHeartbeat(
  supabase: SupabaseClient,
  ok: boolean,
  detail: string,
): Promise<void> {
  const { error } = await supabase
    .from('cron_heartbeats')
    .insert({ job_name: MONITOR_SLUG, ok, detail: detail.slice(0, 900) })

  // A failed heartbeat must not turn a successful sweep into a failed one. It is logged, and
  // the consequence is that MON-002 sees staleness and alarms — which is the correct
  // outcome, because from the outside an unobservable run and a missing run are the same.
  if (error) {
    logger.error('verify-pending: heartbeat write failed', {
      error: error.message,
      consequence: 'MON-002 will read this sweep as stale until the next successful write.',
    })
  }
}

const MONITOR_SLUG = 'verify-pending'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '*/10 * * * *' },
  checkinMargin: 5,
  maxRuntime: 6,
  timezone: 'UTC',
}

/**
 * ONE ORGANISATION PER INVOCATION, oldest-waiting first.
 *
 * verifyEnrichedBatch takes an organisation id, and the free tier is 100 per DAY across the
 * whole account, so there is no value in fanning out: a single sweep every 10 minutes can
 * exhaust the day's quota on its own. Serving the organisation that has waited longest is
 * the fair order and needs no cursor.
 */
async function findOrganisationWithPendingVerification(
  supabase: SupabaseClient,
): Promise<string | null> {
  // ARCHIVED ORGANISATIONS ARE EXCLUDED, and this is not defensive tidiness.
  // Checked before scheduling: 2 enriched, unverified prospects sit in the archived
  // "DRY RUN TEST" organisation. Without this join they would be the OLDEST pending work on
  // the platform, so every sweep would pick them first — spending a 100/day free tier on a
  // dead test organisation and reporting itself busy while real work waited. The enqueue
  // helpers already refuse archived organisations; this now matches them.
  const { data, error } = await supabase
    .from('prospects')
    .select('organisation_id, created_at, organisations!inner(archived_at)')
    .eq('enrichment_status', 'enriched')
    .is('independent_email_status', null)
    .not('email', 'is', null)
    .is('organisations.archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    logger.error('verify-pending: could not look for pending work', { error: error.message })
    return null
  }

  return (data?.[0]?.organisation_id as string | undefined) ?? null
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG,
  )

  const supabase: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  try {
    const organisationId = await findOrganisationWithPendingVerification(supabase)

    // Nothing to do is the NORMAL state, not a problem. It is the state the platform sits
    // in whenever every enriched prospect already carries a verdict.
    if (!organisationId) {
      logger.info('verify-pending: no organisation has unverified enriched prospects')
      await writeHeartbeat(supabase, true, 'Nothing pending: every enriched prospect has a verdict.')
      Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'ok' }, MONITOR_CONFIG)
      await Sentry.flush(2000)
      return NextResponse.json({ ok: true, organisation_id: null, verified: 0, detail: 'nothing pending' })
    }

    const run = await verifyEnrichedBatch(supabase, organisationId, DEFAULT_VERIFY_BATCH_SIZE)

    // 'failed' is the only status that is genuinely a problem. 'free_tier_exhausted' and
    // 'partial' are the system doing exactly what it is told, and paging on them would train
    // the alarm to be ignored on the day it matters.
    const ok = run.status !== 'failed'

    logger.info('verify-pending: run complete', {
      organisation_id: organisationId,
      status: run.status,
      total_verified: run.total_verified,
      send_eligible: run.send_eligible_count,
      not_eligible: run.not_send_eligible_count,
      failed: run.failed_count,
      daily_used: run.daily_verifications_used,
    })

    await writeHeartbeat(
      supabase,
      ok,
      `${run.status}: verified ${run.total_verified}, send-eligible ${run.send_eligible_count}, ` +
      `failed ${run.failed_count}, daily used ${run.daily_verifications_used ?? '?'}.` +
      (run.error_message ? ` ${run.error_message}` : ''),
    )

    Sentry.captureCheckIn(
      { checkInId, monitorSlug: MONITOR_SLUG, status: ok ? 'ok' : 'error' },
      MONITOR_CONFIG,
    )
    await Sentry.flush(2000)

    return NextResponse.json({
      ok,
      organisation_id: organisationId,
      status: run.status,
      verified: run.total_verified,
      send_eligible: run.send_eligible_count,
      failed: run.failed_count,
      daily_used: run.daily_verifications_used,
      error: run.error_message,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('verify-pending: unexpected failure', { error: message })
    // Best effort: if the client itself is the thing that broke, this write fails too and
    // MON-002 falls back to staleness, which is the correct degradation.
    await writeHeartbeat(supabase, false, `Unexpected failure: ${message}`)
    Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'error' }, MONITOR_CONFIG)
    await Sentry.flush(2000)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
