// GET /api/operator/monitor-data
//
// Server-side fetch of monitor data for the operator dashboard.
// Uses service_role to bypass RLS (views are revoked from authenticated).
// Verifies operator role before returning any data.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS ROUTE READS THE LIVE mon_* VIEWS. DO NOT REMOVE THAT READ.
// ─────────────────────────────────────────────────────────────────────────────
//
// Until 2026-09-04 this route read ONLY monitor_events and the dashboard
// rendered monitor_events.created_at under the label "Last run". The sweep
// writes a row ONLY on a state TRANSITION, so between transitions both the
// timestamp and the detail string freeze. Measured on production that day: a
// median gap of about 10 days across 23 monitors, nine of them over three weeks
// stale, while the sweep itself was running every 15 minutes and healthy.
//
// The state was not wrong, because the last transition's state IS the current
// state. What was wrong was the TIMESTAMP and the DETAIL, and the detail is what
// an operator actually reads. MON-011 displayed "2 failed agent run(s)" while
// the live view read 5, the newest six days after the displayed one.
//
// So: state, detail and last_run now come from the views, which are computed at
// read time and cannot go stale. monitor_events is still read, and is still the
// right store for two things it alone can do: the acknowledgement flags, and the
// transition history behind the audit trail.
//
// The alternative considered and rejected was making the sweep write a row on
// every run. That would take monitor_events from 37 rows in 28 days to about
// 62,000 a month, cut the 50-row audit trail down to the last 30 minutes, and
// break acknowledgement outright, because an acknowledgement is stored on a row
// id and a fresh row every 15 minutes discards it.
//
// A VIEW THAT FAILS TO READ IS REPORTED, NEVER SILENTLY SKIPPED. Falling back to
// the stale event row without saying so would rebuild the exact defect this
// route was changed to fix, and it would be invisible. Failures are returned in
// liveErrors and the dashboard marks those checks.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { MONITORS } from '@/app/api/cron/monitor-sweep/monitors'

// The shape the dashboard consumes for one monitor's current reading.
// last_run is null for views computed entirely at read time (mon_006, mon_011
// through mon_015), which expose an incident timestamp rather than a run
// timestamp. For those the dashboard shows checkedAt instead.
interface LiveReading {
  state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  last_run: string | null
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  // Verify authenticated and operator role
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: userRow, error: userError } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (userError || !userRow || userRow.role !== 'operator') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  try {
    // Fetch all monitor checks
    const { data: checksData, error: checksError } = await serviceClient
      .from('monitor_checks')
      .select('code, title, description, category, is_scheduled, plain_meaning, plain_impact, plain_action')
      .order('code')

    if (checksError) throw checksError

    // Fetch latest events per check
    const { data: eventsData, error: eventsError } = await serviceClient
      .from('monitor_events')
      .select('id, check_code, state, detail, created_at, resolved_at, acknowledged_at, acknowledged_note')
      .order('created_at', { ascending: false })

    if (eventsError) throw eventsError

    // Fetch recent events for audit trail
    const { data: recentEvents, error: recentError } = await serviceClient
      .from('monitor_events')
      .select('id, check_code, state, detail, created_at, resolved_at, acknowledged_at, acknowledged_note')
      .order('created_at', { ascending: false })
      .limit(50)

    if (recentError) throw recentError

    // ── The live read ────────────────────────────────────────────────────────
    // MONITORS is imported, never re-listed here. A second copy of the registry
    // is the parallel-array defect that monitors.ts exists to make unexpressible,
    // and a view missing from this route would be a monitor that reads as fresh
    // while showing a frozen value.
    //
    // select('*') because the fourth column differs per view: most expose
    // last_run, six expose an incident timestamp under another name. Naming
    // last_run explicitly would make those six error.
    const checkedAt = new Date().toISOString()

    const liveRows = await Promise.all(
      MONITORS.map(async ([checkCode, viewName]) => {
        const { data, error } = await serviceClient
          .from(viewName)
          .select('*')
          .single()
        return { checkCode, viewName, data, error }
      })
    )

    const live: Record<string, LiveReading> = {}
    const liveErrors: Record<string, string> = {}

    for (const row of liveRows) {
      if (row.error || !row.data) {
        liveErrors[row.checkCode] = row.error?.message ?? `${row.viewName} returned no row`
        continue
      }
      const view = row.data as Record<string, unknown>
      live[row.checkCode] = {
        state: view.state as 'PROBLEM' | 'OK' | 'UNKNOWN',
        detail: (view.detail as string | null) ?? null,
        last_run: typeof view.last_run === 'string' ? view.last_run : null,
      }
    }

    return NextResponse.json({
      checks: checksData || [],
      events: eventsData || [],
      recentEvents: recentEvents || [],
      live,
      liveErrors,
      checkedAt,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Monitor data could not be loaded: ${message}` },
      { status: 500 }
    )
  }
}
