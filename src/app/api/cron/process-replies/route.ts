// POST /api/cron/process-replies
//
// Called by Supabase pg_cron every 5 minutes via pg_net HTTP POST.
// Classifies unprocessed reply_received signals and dispatches Tier 1 actions.
//
// Auth: Authorization: Bearer ${CRON_SECRET} — same pattern as /api/cron/instantly-poll.
// Uses service_role — required to read integration_credentials and write reply_handling_actions
// without RLS interference.
//
// Failures are reported in the response summary but do not throw — the cron job sees a 200
// on partial failures. Check the `errors` field in the response body for signal-level failures.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import * as Sentry from '@sentry/nextjs'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { processReplies } from '@/lib/reply-handling/process-reply'
import { getInstantlyApiKey } from '@/lib/integrations/handlers/instantly/auth'

const MONITOR_SLUG = 'process-replies'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '*/5 * * * *' },
  checkinMargin: 10,
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

  // ── Fetch Instantly API key ────────────────────────────────────────────────
  let instantlyApiKey: string
  try {
    instantlyApiKey = await getInstantlyApiKey('')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('process-replies: Instantly API key not found in integration_credentials', { error: msg })
    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'error', checkInId })
    try { await Sentry.flush(2000) } catch {}
    return NextResponse.json(
      { error: 'Instantly API key not configured.' },
      { status: 503 }
    )
  }

  // ── Process ────────────────────────────────────────────────────────────────
  let result
  try {
    result = await processReplies(supabase, instantlyApiKey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('process-replies: processReplies threw unexpectedly', { error: msg })
    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'error', checkInId })
    try { await Sentry.flush(2000) } catch {}
    return NextResponse.json({ error: 'Internal error.', detail: msg }, { status: 500 })
  }

  logger.info('process-replies: run complete', { ...result })

  // ── Record heartbeat ───────────────────────────────────────────────────────────
  const heartbeatOk = (result?.errors ?? 0) === 0
  await supabase
    .from('cron_heartbeats')
    .insert({
      job_name: 'process-replies',
      ok: heartbeatOk,
      detail: heartbeatOk
        ? `Processed ${result?.processed ?? 0} replies`
        : `${result?.errors ?? 0} error(s) processing replies`,
    })
    .throwOnError()

  // The check-in and the response carry the REAL outcome.
  //
  // Both were hardcoded to success while the database heartbeat above correctly carried
  // heartbeatOk, so a run that failed to process every reply still stamped Sentry 'ok'
  // and returned ok: true. No Sentry alert could ever fire for this cron. instantly-poll
  // had the identical defect and fixed it; its comment reads "Previously the heartbeat
  // used it and the other two were hardcoded to success, so a run that failed every call
  // still read green." The same fix was never applied here.
  //
  // This matters more than the duplicated heartbeat suggests: MON-003 reads only the
  // latest heartbeat row, so a failing run reddens the board for one cycle and the next
  // clean run clears it. Sentry is the instrument that persists, and it was the one being
  // told a comfortable lie.
  Sentry.captureCheckIn({
    monitorSlug: MONITOR_SLUG,
    status: heartbeatOk ? 'ok' : 'error',
    checkInId,
  })
  if (!heartbeatOk) {
    Sentry.captureException(
      new Error(`process-replies run failed: ${result?.errors ?? 0} error(s) processing replies`),
      { level: 'error', extra: { result } }
    )
  }
  try { await Sentry.flush(2000) } catch {}
  return NextResponse.json({ ok: heartbeatOk, result })
}
