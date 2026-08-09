// POST /api/operator/monitor-acknowledge
//
// Acknowledge an open monitor event. Sets acknowledged_at and acknowledged_note.
// Only valid on open PROBLEM events (state='PROBLEM', resolved_at IS NULL).
// Returns 409 if event is not open.

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
    // Parse request body
    const body = await request.json()
    const { event_id, note } = body

    if (!event_id) {
      return NextResponse.json({ error: 'event_id required' }, { status: 400 })
    }

    // Fetch the event to verify it's open (state='PROBLEM', resolved_at IS NULL)
    const { data: event, error: fetchError } = await serviceClient
      .from('monitor_events')
      .select('id, state, resolved_at')
      .eq('id', event_id)
      .single()

    if (fetchError || !event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    }

    // Verify event is open (state='PROBLEM' and resolved_at IS NULL)
    if (event.state !== 'PROBLEM' || event.resolved_at !== null) {
      return NextResponse.json(
        { error: 'Event is not open for acknowledgement' },
        { status: 409 }
      )
    }

    // Update the event with acknowledged_at and acknowledged_note
    const { data: updated, error: updateError } = await serviceClient
      .from('monitor_events')
      .update({
        acknowledged_at: new Date().toISOString(),
        acknowledged_note: note || null,
      })
      .eq('id', event_id)
      .select()
      .single()

    if (updateError) throw updateError

    return NextResponse.json({ event: updated }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Acknowledgement failed: ${message}` },
      { status: 500 }
    )
  }
}
