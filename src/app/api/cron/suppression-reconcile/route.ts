// POST /api/cron/suppression-reconcile
//
// Called by Supabase pg_cron every 30 minutes. Reads the sending provider's live state for
// every prospect our database says must not be mailed, and reports anyone still being sent
// to. Expected count: zero.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Service role, like every other sweep: it acts
// as a system process and reads across organisations.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A CRON AND NOT A QUEUE JOB
//
// The queue exists for expensive, non-idempotent work that must not be paid for twice; its
// central mechanism is the spend stamp. This sweep spends nothing and writes nothing to the
// provider. It is a read-only comparison, safe to repeat, and its whole backlog fits in one
// invocation. Revisit if it ever acquires a write.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY 30 MINUTES
//
// It is an instrument, not a remedy: it does not stop anybody, it says that somebody was not
// stopped. The thing it watches for changes on the timescale of a campaign step, which is
// days here, and every provider read costs an API call against a shared rate limit. Half an
// hour is far faster than the failure it is looking for and far slower than the limit.
//
// The write paths are what act. This is what says they did not.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import { reconcileSuppression, writeReconciliationSnapshot } from '@/lib/suppression/reconcile'

export const dynamic = 'force-dynamic'
// Every long route in this repo declares this. Provider reads are sequential and a large
// suppressed set could otherwise be cut off mid-sweep and report a partial count as a total.
export const maxDuration = 300

const MONITOR_SLUG = 'suppression-reconcile'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '*/30 * * * *' },
  checkinMargin: 10,
  maxRuntime: 6,
  timezone: 'UTC',
}

/**
 * THE HEARTBEAT IS NOT OPTIONAL. MON-002 derives liveness from staleness in cron_heartbeats
 * alone, so a sweep that writes no row is invisible: it could stop entirely and nothing
 * would say so. That is how the provider poller ran dead for four months.
 */
async function writeHeartbeat(
  supabase: ReturnType<typeof asServiceRoleClient>,
  ok: boolean,
  detail: string,
): Promise<void> {
  const { error } = await supabase
    .from('cron_heartbeats')
    .insert({ job_name: MONITOR_SLUG, ok, detail: detail.slice(0, 900) })

  if (error) {
    logger.error('suppression-reconcile: heartbeat write failed', {
      error: error.message,
      consequence: 'MON-002 will read this sweep as stale until the next successful write.',
    })
  }
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

  const supabase = asServiceRoleClient(
    createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    ),
  )

  try {
    const verdict = await reconcileSuppression(supabase)

    // Stored before the run is called a success. If the store throws, the heartbeat below
    // records a failure and MON-026 goes stale, which is the correct reading: a verdict
    // nobody can see is the same as a sweep that did not run.
    await writeReconciliationSnapshot(supabase, verdict)

    // 'ok' here is about whether the SWEEP worked, not about what it found. A sweep that
    // correctly discovers an unreconciled prospect has done its job perfectly, and marking
    // its heartbeat failed would confuse "the instrument is broken" with "the instrument
    // found something". MON-026 reads the finding; the heartbeat reads the instrument.
    const ok = !verdict.incomplete

    logger.info('suppression-reconcile: run complete', {
      uploaded: verdict.uploadedCount,
      blocked: verdict.blockedCount,
      checked: verdict.checkedCount,
      unreconciled: verdict.unreconciledCount,
      unreachable: verdict.unreachableCount,
      settling: verdict.settlingCount,
      invariant_breaches: verdict.invariantBreachCount,
      incomplete: verdict.incomplete,
    })

    if (verdict.unreconciledCount > 0) {
      // Sentry as well as the monitor board. A person our records say must not be contacted
      // who is being contacted is worth waking somebody for, not just colouring a tile.
      Sentry.captureException(
        new Error(
          `Suppression reconciliation: ${verdict.unreconciledCount} prospect(s) our database ` +
          `says must not be mailed are still being sent to`,
        ),
        { level: 'error', extra: { prospect_ids: verdict.unreconciledProspectIds } },
      )
    }

    await writeHeartbeat(supabase, ok, verdict.detail)
    Sentry.captureCheckIn(
      { checkInId, monitorSlug: MONITOR_SLUG, status: ok ? 'ok' : 'error' },
      MONITOR_CONFIG,
    )
    await Sentry.flush(2000)

    return NextResponse.json({ ok, ...verdict })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('suppression-reconcile: run failed', { error: message })
    Sentry.captureException(err instanceof Error ? err : new Error(message))
    await writeHeartbeat(supabase, false, `Run failed: ${message}`)
    Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'error' }, MONITOR_CONFIG)
    await Sentry.flush(2000)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
