// GET /api/operator/sending-health
//
// Per-domain sending health for the operator dashboard. OPERATOR ONLY.
//
// This is OUR sending infrastructure, not client data, and it is diagnostic rather than
// health-facing. get-client-visible-campaign-metrics.ts already draws that line and this
// route sits on the far side of it: "per-mailbox attribution, complaint rate, mailbox
// health, and anything that identifies WHICH addresses bounced" is never client-visible.
// A client sees their own org-level bounce total and nothing here.
//
// Two-client pattern, ADR-027. The session client answers "who is asking", the service
// client does the reading, because sending_health_snapshot is revoked from authenticated
// by name and RLS-enabled with zero policies. "Operator-only" is enforced HERE, in the
// route, which is why the gate below runs before any data is touched.

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { Database } from '@/types/database'
import { resolveMonitorState } from '@/lib/sending-health/monitor-state'
import type { OverallHealthState } from '@/lib/sending-health/evaluate'
import {
  ABSOLUTE_BOUNCE_TRIGGER,
  RATE_BOUNCE_TRIGGER,
  RATE_MINIMUM_SENDS,
  SENDING_HEALTH_WINDOW_DAYS,
} from '@/lib/sending-health/thresholds'

export async function GET() {
  const cookieStore = await cookies()
  const sessionClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )

  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const serviceClient = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: userRow, error: userError } = await serviceClient
    .from('users').select('role').eq('id', user.id).single()

  if (userError || !userRow || userRow.role !== 'operator') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  const { data: snapshot, error } = await serviceClient
    .from('sending_health_snapshot')
    .select('overall_state, detail, window_start, window_end, domains, computed_at')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: 'Failed to read sending health' }, { status: 500 })
  }

  // The SAME function the monitor's SQL mirrors, so the dashboard and MON-023 can never
  // disagree about whether the verdict is fresh enough to believe.
  const resolved = resolveMonitorState({
    storedState: (snapshot?.overall_state as OverallHealthState | undefined) ?? null,
    computedAt:  snapshot?.computed_at ? new Date(snapshot.computed_at) : null,
    storedDetail: snapshot?.detail ?? null,
    now: new Date(),
  })

  return NextResponse.json({
    healthState: resolved.healthState,
    sweepState:  resolved.state,
    detail:      resolved.detail,
    windowStart: snapshot?.window_start ?? null,
    windowEnd:   snapshot?.window_end ?? null,
    computedAt:  snapshot?.computed_at ?? null,
    domains:     snapshot?.domains ?? [],
    thresholds: {
      windowDays:      SENDING_HEALTH_WINDOW_DAYS,
      absoluteBounces: ABSOLUTE_BOUNCE_TRIGGER,
      ratePercent:     RATE_BOUNCE_TRIGGER * 100,
      minimumSends:    RATE_MINIMUM_SENDS,
    },
  })
}
