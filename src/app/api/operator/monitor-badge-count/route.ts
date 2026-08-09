// GET /api/operator/monitor-badge-count
//
// Returns count of open unacknowledged PROBLEM events for the badge.
// Minimal payload for efficient sidebar updates.

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
    // Count open unacknowledged PROBLEM events
    const { count, error: countError } = await serviceClient
      .from('monitor_events')
      .select('id', { count: 'exact' })
      .eq('state', 'PROBLEM')
      .is('resolved_at', null)
      .is('acknowledged_at', null)

    if (countError) throw countError

    return NextResponse.json({ count: count || 0 }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Could not fetch badge count: ${message}` },
      { status: 500 }
    )
  }
}
