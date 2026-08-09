// POST /api/cron/monitor-sweep
//
// Called by Supabase pg_cron every 15 minutes via pg_net HTTP POST.
// Checks all monitored items (liveness, Tier 1, blind spots) by querying monitor views.
// Compares current state against last recorded state. Records state transitions in monitor_events.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Uses service_role to read monitor views and write events without RLS interference.
//
// State machine per check:
//   UNKNOWN (no heartbeat, or first time seeing this check)
//   OK (liveness within threshold, all conditions green)
//   PROBLEM (liveness overdue, or threshold exceeded)
// Transitions are recorded only on state change. Repeated states do not create duplicate events.
//
// Monitor check views queried:
//   mon_001, mon_002, mon_003, mon_004, mon_005 (liveness checks)
//   mon_006 (Tier 1: client revisions awaiting review)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

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

  const checkCodes = ['MON-001', 'MON-002', 'MON-003', 'MON-004', 'MON-005', 'MON-006', 'MON-011', 'MON-012', 'MON-013', 'MON-014', 'MON-015']
  const viewNames = ['mon_001', 'mon_002', 'mon_003', 'mon_004', 'mon_005', 'mon_006', 'mon_011', 'mon_012', 'mon_013', 'mon_014', 'mon_015']

  const results = {
    checked: 0,
    state_changes: 0,
    errors: 0,
  }

  // ── Check each monitor ─────────────────────────────────────────────────────
  for (let i = 0; i < checkCodes.length; i++) {
    const checkCode = checkCodes[i]
    const viewName = viewNames[i]

    try {
      // Query the view to get current state
      const { data, error: viewError } = await supabase
        .from(viewName)
        .select('check_code, state, detail')
        .single()

      if (viewError || !data) {
        logger.error('Monitor sweep: view query failed', {
          check_code: checkCode,
          view_name: viewName,
          error: viewError?.message,
        })
        results.errors++
        continue
      }

      const currentState = data.state as 'PROBLEM' | 'OK' | 'UNKNOWN'
      const currentDetail = data.detail as string | null

      // Fetch the most recent event for this check
      const { data: lastEvent, error: eventError } = await supabase
        .from('monitor_events')
        .select('state, detail, created_at, resolved_at')
        .eq('check_code', checkCode)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (eventError) {
        logger.error('Monitor sweep: failed to fetch last event', {
          check_code: checkCode,
          error: eventError.message,
        })
        results.errors++
        continue
      }

      results.checked++

      // Determine if we should record a state change
      const lastState = lastEvent?.state ?? 'UNKNOWN'
      const shouldRecord = currentState !== lastState

      if (!shouldRecord) {
        continue
      }

      // If transitioning FROM PROBLEM, record the resolution time
      const needsResolution = lastState === 'PROBLEM' && currentState !== 'PROBLEM'
      if (needsResolution && lastEvent) {
        const { error: updateError } = await supabase
          .from('monitor_events')
          .update({ resolved_at: new Date().toISOString() })
          .eq('check_code', checkCode)
          .eq('created_at', lastEvent.created_at)

        if (updateError) {
          logger.warn('Monitor sweep: failed to mark event resolved', {
            check_code: checkCode,
            error: updateError.message,
          })
        }
      }

      // Record the new state
      const { error: insertError } = await supabase
        .from('monitor_events')
        .insert({
          check_code: checkCode,
          state: currentState,
          detail: currentDetail,
        })

      if (insertError) {
        logger.error('Monitor sweep: failed to insert event', {
          check_code: checkCode,
          error: insertError.message,
        })
        results.errors++
      } else {
        logger.info('Monitor sweep: state change recorded', {
          check_code: checkCode,
          from_state: lastState,
          to_state: currentState,
        })
        results.state_changes++

        // Alert to Sentry when transitioning to PROBLEM
        if (currentState === 'PROBLEM') {
          Sentry.captureMessage(`Monitor check ${checkCode} transitioned to PROBLEM: ${currentDetail}`, 'error')
        }
      }
    } catch (err) {
      logger.error('Monitor sweep: unexpected error', {
        check_code: checkCode,
        error: err instanceof Error ? err.message : String(err),
      })
      results.errors++
    }
  }

  // ── Record heartbeat for this sweep ────────────────────────────────────────
  const sweepOk = results.errors === 0
  await supabase
    .from('cron_heartbeats')
    .insert({
      job_name: 'monitor-sweep',
      ok: sweepOk,
      detail: sweepOk
        ? `Checked ${results.checked} monitors, recorded ${results.state_changes} state change(s)`
        : `Checked ${results.checked} monitors, ${results.errors} error(s)`,
    })
    .throwOnError()

  logger.info('Monitor sweep: batch complete', {
    ...results,
  })

  // Flush Sentry before returning
  try {
    await Sentry.flush(2000)
  } catch {}

  return NextResponse.json({
    ok: sweepOk,
    ...results,
  })
}
