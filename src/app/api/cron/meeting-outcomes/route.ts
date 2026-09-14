// POST /api/cron/meeting-outcomes
//
// Runs daily. Asks clients whether their meetings happened, reminds them working back from
// the real deadline, and applies the monthly backstop from the 2026-08-24 pricing decision.
//
// THIS ROUTE REPLACES /api/cron/resolve-auto-held, which is deleted. That job marked a
// meeting held and billable 72 hours after its start with no human involved. It was never
// part of the pricing decision (ADR-057). Its pg_cron job is paused and declared off.
//
// Auth: Authorization: Bearer ${CRON_SECRET} — same pattern as every cron route here.
//
// Uses service_role to act across all organisations without RLS interference. This is
// intentional: the cron acts as a system process, not as a user.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { sweepMeetingOutcomes } from '@/lib/meetings/outcome-sweep'
import { sendDueToBillNotification } from '@/lib/notifications/send-due-to-bill-notification'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

const MONITOR_SLUG = 'meeting-outcomes'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '34 9 * * *' },
  checkinMargin: 15,
  maxRuntime: 10,
  timezone: 'UTC',
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = await createServiceRoleClient()

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG,
  )

  try {
    const run = await sweepMeetingOutcomes(supabase)

    // An organisation whose read or write was refused is not a healthy run, even though the
    // rest were processed normally. Nor is a meeting that passed its deadline without the
    // client ever being asked: that is a meeting nobody can bill and nobody has chased.
    const ok = run.organisations_failed === 0 && run.past_deadline_never_asked === 0

    // DETAIL FORMAT IS LOAD-BEARING. mon_010 reads the integer after 'Examined' and compares
    // it against the live count of non-archived organisations, so a run examining zero while
    // organisations exist is a PROBLEM whatever `ok` says. The view anchors on
    // '^Examined (\d+) organisations' and reports UNKNOWN if it cannot match, so changing
    // this prefix breaks the monitor loudly rather than silently. It carried the
    // resolve-auto-held heartbeat until 2026-09-12 and now reads this job's.
    const detail = [
      `Examined ${run.organisations_examined} organisations`,
      `asked ${run.confirmations_sent}`,
      `reminded ${run.reminders_sent}`,
      `billed unconfirmed ${run.billed_unconfirmed}`,
      `due to bill ${run.due_to_bill_unconfirmed.length}`,
      ...(run.past_deadline_never_asked > 0
        ? [`${run.past_deadline_never_asked} PAST DEADLINE NEVER ASKED, not billed`]
        : []),
      ...(run.organisations_failed > 0 ? [`${run.organisations_failed} FAILED`] : []),
    ].join(', ')

    logger.info('meeting-outcomes cron: completed', {
      organisations_examined: run.organisations_examined,
      organisations_failed: run.organisations_failed,
      confirmations_sent: run.confirmations_sent,
      reminders_sent: run.reminders_sent,
      billed_unconfirmed: run.billed_unconfirmed,
      past_deadline_never_asked: run.past_deadline_never_asked,
      due_to_bill: run.due_to_bill_unconfirmed.length,
    })

    // The operator sees the list while there is still time to chase. Best effort: a failed
    // alert must never undo the sweep, and the same list is on the operator screen.
    if (run.due_to_bill_unconfirmed.length > 0) {
      await sendDueToBillNotification(run.due_to_bill_unconfirmed)
    }

    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: ok ? 'ok' : 'error', checkInId })
    try { await Sentry.flush(2000) } catch {}

    try {
      await supabase.from('cron_heartbeats').insert({ job_name: MONITOR_SLUG, ok, detail })
    } catch (e) {
      logger.error('failed to record heartbeat', { error: e })
    }

    return NextResponse.json({ ok, results: run }, { status: ok ? 200 : 500 })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('meeting-outcomes cron: threw unexpectedly', { error: msg })
    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'error', checkInId })
    try { await Sentry.flush(2000) } catch {}
    try {
      await supabase.from('cron_heartbeats').insert({ job_name: MONITOR_SLUG, ok: false, detail: `Error: ${msg}` })
    } catch (e) {
      logger.error('failed to record heartbeat', { error: e })
    }
    return NextResponse.json({ error: 'Internal error.', detail: msg }, { status: 500 })
  }
}
