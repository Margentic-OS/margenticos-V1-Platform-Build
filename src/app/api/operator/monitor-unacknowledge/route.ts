// POST /api/operator/monitor-unacknowledge
//
// Clears acknowledged_at and acknowledged_note on an open monitor event, so the
// check returns to Active Problems and to the nav badge count.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// An acknowledgement is stored on a ROW but behaves like an acknowledgement of a
// CONDITION, because the sweep writes a row only on a state transition. So a
// problem that gets WORSE after being acknowledged produces no new row, keeps
// the old acknowledgement, and stays hidden.
//
// Measured on production 2026-09-04. MON-011 was acknowledged on 2026-08-28 at
// 20:06 with the note "Fixing", against a row reading "2 failed agent run(s)".
// Three further failures landed, the newest on 2026-09-03, and none of them
// created a row. Seven days later the board still showed 2, collapsed under
// Acknowledged Problems, and excluded from the badge count.
//
// Before this route the only ways back were to wait for the check to go fully
// green and break again, or to edit the row by hand in the database. mon_011 is
// a rolling 7-day window, so "fully green" meant no failure for a week.
//
// The dashboard now shows the LIVE detail next to an acknowledgement and marks
// it when the detail has moved on. This route is the other half: seeing that it
// changed is only useful if the operator can act on it.
//
// Suppression itself is deliberately kept. An acknowledgement that expired on
// any change would make acknowledging a flapping check useless, which is most of
// what acknowledgement is for.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
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
    const body = await request.json()
    const { event_id } = body

    if (!event_id) {
      return NextResponse.json({ error: 'event_id required' }, { status: 400 })
    }

    const { data: event, error: fetchError } = await serviceClient
      .from('monitor_events')
      .select('id, state, resolved_at, acknowledged_at')
      .eq('id', event_id)
      .single()

    if (fetchError || !event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    }

    // Mirrors the acknowledge route's gate: only an OPEN problem is a thing an
    // operator can be silencing. A resolved event's acknowledgement is history.
    if (event.state !== 'PROBLEM' || event.resolved_at !== null) {
      return NextResponse.json(
        { error: 'Event is not open for acknowledgement' },
        { status: 409 }
      )
    }

    if (event.acknowledged_at === null) {
      return NextResponse.json(
        { error: 'Event is not acknowledged' },
        { status: 409 }
      )
    }

    const { data: updated, error: updateError } = await serviceClient
      .from('monitor_events')
      .update({
        acknowledged_at: null,
        acknowledged_note: null,
      })
      .eq('id', event_id)
      .select()
      .single()

    if (updateError) throw updateError

    return NextResponse.json({ event: updated }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Un-acknowledgement failed: ${message}` },
      { status: 500 }
    )
  }
}
