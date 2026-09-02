// GET /api/operator/sourcing-metrics
//
// Every number the pipeline review screen renders, for every active organisation. The
// screen polls this so its counts follow the database instead of freezing at first paint.
//
// Auth: operator session only. Three checks, per CLAUDE.md: authenticated, role is
// operator, and the data is scoped by the handler rather than by anything the caller sends.
// There is deliberately NO organisation parameter: an operator sees every active
// organisation, and a route that took an id would need a fourth check to be safe.
//
// TWO CLIENTS, per ADR-027. The session client is used only for auth.getUser(); every read
// goes through the service client, because getSourcingMetrics reaches job_queue and
// system_flags and both have RLS on with zero policies and no authenticated grant.
//
// Read-only. No writes, no spend, nothing to make idempotent.

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { getSourcingMetrics } from '@/lib/operator/sourcing-metrics'
import { requireOperator } from '@/lib/supabase/require-operator'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const cookieStore = await cookies()
    const sessionClient = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          },
        },
      },
    )

    const supabase = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { user, authorized } = await requireOperator(sessionClient, supabase)
    if (!user) {
      // 401 and 403 are distinguished because the poller acts on them differently: an
      // expired session should send the operator to log in, a lost role should not.
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (!authorized) {
      return NextResponse.json({ error: 'Operator role required' }, { status: 403 })
    }

    const metrics = await getSourcingMetrics(supabase)

    return NextResponse.json({ ok: true, metrics })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    // A count that cannot be read must NOT be reported as a count of zero. The screen
    // shows the last good numbers and a stale marker instead. See PipelineOverview.
    logger.error('sourcing-metrics: failed', { error: errorMsg })
    Sentry.captureException(err, { extra: { endpoint: '/api/operator/sourcing-metrics' } })

    return NextResponse.json({ error: `Could not read pipeline metrics: ${errorMsg}` }, { status: 500 })
  }
}
