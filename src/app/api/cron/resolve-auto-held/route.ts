// POST /api/cron/resolve-auto-held
//
// Runs daily (09:00 UTC). Resolves meetings that have passed their auto-held window.
// Window is measured from scheduled_start_at: a meeting is auto-held when
// scheduled_start_at + organisations.auto_held_window_hours < now().
//
// Auth: Authorization: Bearer ${CRON_SECRET} — same pattern as all cron routes.
// Any request without a valid token is rejected immediately.
//
// Uses service_role to act across all organisations without RLS interference.
// This is intentional — the cron acts as a system process, not a user.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveAutoHeldMeetings } from '@/lib/meetings/auto-held-resolution'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

const MONITOR_SLUG = 'resolve-auto-held'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '0 9 * * *' },
  checkinMargin: 15,
  maxRuntime: 5,
  timezone: 'UTC',
}

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG
  )

  try {
    // ── Resolve auto-held meetings ─────────────────────────────────────────
    // The service-role client above is PASSED, not merely created. It used to be
    // created and then dropped on the floor: this call had no argument, and the
    // resolver fell back to the anon session client. See the header comment in
    // src/lib/meetings/auto-held-resolution.ts.
    const run = await resolveAutoHeldMeetings(supabase)

    // A run in which any organisation's read or update was refused is NOT a healthy
    // run, even though the remaining organisations were processed normally.
    const ok = run.organisations_failed === 0

    logger.info('resolve-auto-held cron: completed', {
      organisations_examined: run.organisations_examined,
      organisations_failed: run.organisations_failed,
      total_resolved: run.meetings_resolved,
    })

    // DETAIL FORMAT IS LOAD-BEARING. mon_010 reads the integer after 'Examined' and
    // compares it against the live count of non-archived organisations, so that a run
    // examining zero while organisations exist is a PROBLEM whatever `ok` says. The
    // view anchors on '^Examined (\d+) organisations' and reports UNKNOWN if it cannot
    // match, so changing this string breaks the monitor loudly rather than silently.
    // The word 'Processed' was the old wording and is deliberately not reused: it
    // could not distinguish organisations WALKED from organisations that had work.
    const detail = ok
      ? `Examined ${run.organisations_examined} organisations, resolved ${run.meetings_resolved} meetings`
      : `Examined ${run.organisations_examined} organisations, resolved ${run.meetings_resolved} meetings, ${run.organisations_failed} FAILED`

    Sentry.captureCheckIn({
      monitorSlug: MONITOR_SLUG,
      status: ok ? 'ok' : 'error',
      checkInId,
    })
    try { await Sentry.flush(2000) } catch {}

    try {
      await supabase
        .from('cron_heartbeats')
        .insert({
          job_name: 'resolve-auto-held',
          ok,
          detail,
        })
    } catch (e) {
      logger.error('failed to record heartbeat', { error: e })
    }

    return NextResponse.json({
      ok,
      results: {
        organisations_examined: run.organisations_examined,
        organisations_failed: run.organisations_failed,
        meetings_resolved: run.meetings_resolved,
        detail: run.organisations_with_resolutions,
      },
    }, { status: ok ? 200 : 500 })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('resolve-auto-held cron: threw unexpectedly', { error: msg })
    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'error', checkInId })
    try { await Sentry.flush(2000) } catch {}
    try {
      await supabase
        .from('cron_heartbeats')
        .insert({
          job_name: 'resolve-auto-held',
          ok: false,
          detail: `Error: ${msg}`,
        })
    } catch (e) {
      logger.error('failed to record heartbeat', { error: e })
    }
    return NextResponse.json({ error: 'Internal error.', detail: msg }, { status: 500 })
  }
}
