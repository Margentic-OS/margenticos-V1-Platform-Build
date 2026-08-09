// GET /api/operator/monitor-data
//
// Server-side fetch of monitor data for the operator dashboard.
// Uses service_role to bypass RLS (views are revoked from authenticated).
// Verifies operator role before returning any data.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

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

    return NextResponse.json({
      checks: checksData || [],
      events: eventsData || [],
      recentEvents: recentEvents || [],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Monitor data could not be loaded: ${message}` },
      { status: 500 }
    )
  }
}
