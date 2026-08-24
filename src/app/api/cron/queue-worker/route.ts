// POST /api/cron/queue-worker
//
// Called by Supabase pg_cron every minute via pg_net HTTP POST. One pass of the durable
// job queue: reclaim expired leases, then claim and run work for each enabled job type.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Uses service_role. It acts as a system process, and every job_queue function is
// granted to service_role alone.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY pg_cron AND NOT VERCEL CRON
//
// Vercel Hobby permits only DAILY cron jobs. Every other scheduled job in this project
// moved to Supabase pg_cron for the same reason; see
// 20260807_reap_agent_runs_pg_cron.sql. The Bearer token is HARDCODED in the pg_cron
// command because ALTER DATABASE ... SET "app.*" needs superuser on Supabase, so
// current_setting('app.cron_secret', true) returns NULL and the route receives
// "Bearer " with nothing after it. That has cost this build time twice.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE INSTRUMENTATION RULE
//
// One value, runResult.ok, drives all three instruments: the cron_heartbeats row, the
// Sentry check-in, and the HTTP response body. They cannot disagree.
//
// This matters because MON-002 derives its state from max(ran_at) staleness alone and
// never consults cron_heartbeats.ok, so a job that runs on time and fails every single
// time reads OK there. The queue's own monitors (MON-016, 017, 018) read ok and the
// queue's real contents instead, and do not inherit that blind spot.
//
// Sentry.flush(2000) runs before EVERY return path, including the auth failure and the
// unexpected-throw path. captureCheckIn only enqueues; the serverless container is
// frozen the instant the handler returns, so an unflushed event is simply dropped.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { runWorker } from '@/lib/queue/run-worker'
import { WORKER_BUDGET_SECONDS } from '@/lib/queue/config'

export const dynamic = 'force-dynamic'
// The Hobby ceiling, and this repo's convention for every long route. runWorker holds
// back WORKER_BUDGET_SECONDS of that for the work and leaves the rest for cold start,
// the auth round trips and a slow tail.
export const maxDuration = 300

const MONITOR_SLUG = 'queue-worker'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '* * * * *' },
  checkinMargin: 5,
  maxRuntime: 6,
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
    MONITOR_CONFIG,
  )

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Identifies this invocation for the whole of its life. It is written to claimed_by
  // and is REQUIRED by the fenced complete_job and fail_job, so a worker whose lease was
  // reclaimed cannot mark done or requeue a row that now belongs to someone else.
  // Vercel supplies a per-request id; the timestamp and random suffix keep it unique
  // locally and in any environment that does not.
  const workerId = [
    'w',
    request.headers.get('x-vercel-id')?.slice(-12) ?? 'local',
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join('-')

  try {
    const run = await runWorker({ supabase, workerId, budgetSeconds: WORKER_BUDGET_SECONDS })

    const totals = Object.values(run.byJobType).reduce(
      (acc, r) => ({
        claimed: acc.claimed + r.claimed,
        done: acc.done + r.done,
        failed: acc.failed + r.failed,
        unrecorded: acc.unrecorded + r.unrecorded,
      }),
      { claimed: 0, done: 0, failed: 0, unrecorded: 0 },
    )

    logger.info('queue-worker: run complete', {
      ok: run.ok,
      worker_id: run.workerId,
      elapsed_seconds: run.elapsedSeconds,
      reclaimed: run.reclaimed,
      ...totals,
      by_job_type: run.byJobType,
    })

    const detail = run.ok
      ? `Claimed ${totals.claimed}, done ${totals.done}, failed ${totals.failed}, ` +
        `reclaimed ${run.reclaimed}, ${run.elapsedSeconds}s`
      : // Name the first cause rather than only a count. A count sends the reader to the
        // logs; the cause sends them to the thing that needs fixing.
        `Run failed: ${run.errors.length} error(s). First: ${run.errors[0]}`

    await supabase
      .from('cron_heartbeats')
      .insert({ job_name: 'queue-worker', ok: run.ok, detail: detail.slice(0, 900) })
      .throwOnError()

    Sentry.captureCheckIn({
      monitorSlug: MONITOR_SLUG,
      status: run.ok ? 'ok' : 'error',
      checkInId,
    })

    if (!run.ok) {
      Sentry.captureException(
        new Error(`Queue worker run failed: ${run.errors.join(' | ')}`),
        { level: 'error', extra: { run } },
      )
    }

    try { await Sentry.flush(2000) } catch {}

    return NextResponse.json({
      ok: run.ok,
      worker_id: run.workerId,
      elapsed_seconds: run.elapsedSeconds,
      reclaimed: run.reclaimed,
      reclaim_terminated: run.reclaimTerminated,
      totals,
      by_job_type: run.byJobType,
      errors: run.errors,
    })
  } catch (err) {
    // runWorker is written not to throw, so reaching here means something outside it
    // failed: the heartbeat insert, or the client itself. The check-in must still carry
    // the real outcome rather than being left in_progress forever.
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('queue-worker: run threw unexpectedly', { worker_id: workerId, error: msg })

    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'error', checkInId })
    Sentry.captureException(err instanceof Error ? err : new Error(msg), { level: 'error' })

    // Best effort. If the heartbeat is what failed, this will fail too, and the staleness
    // of the last heartbeat is what MON-016 then reports.
    try {
      await supabase
        .from('cron_heartbeats')
        .insert({ job_name: 'queue-worker', ok: false, detail: `Threw: ${msg}`.slice(0, 900) })
    } catch {}

    try { await Sentry.flush(2000) } catch {}

    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
