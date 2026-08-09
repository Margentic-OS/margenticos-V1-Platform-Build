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
    const results = await resolveAutoHeldMeetings()

    logger.info('resolve-auto-held cron: completed', {
      organisations_processed: results.length,
      total_resolved: results.reduce((sum, r) => sum + r.resolved_count, 0),
    })

    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'ok', checkInId })
    try { await Sentry.flush(2000) } catch {}

    try {
      await supabase
        .from('cron_heartbeats')
        .insert({
          job_name: 'resolve-auto-held',
          ok: true,
          detail: `Processed ${results.length} organisations, resolved ${results.reduce((sum, r) => sum + r.resolved_count, 0)} meetings`,
        })
    } catch (e) {
      logger.error('failed to record heartbeat', { error: e })
    }

    return NextResponse.json({
      ok: true,
      results: {
        organisations_processed: results.length,
        meetings_resolved: results.reduce((sum, r) => sum + r.resolved_count, 0),
        detail: results,
      },
    })
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
