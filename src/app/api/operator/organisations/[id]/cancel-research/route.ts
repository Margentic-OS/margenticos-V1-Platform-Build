// POST /api/operator/organisations/[id]/cancel-research
//
// Stop research that has not started. Returns how many jobs were cancelled.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS CAN AND CANNOT STOP, STATED HERE BECAUSE THE DIFFERENCE IS THE POINT
//
// QUEUED jobs are cancelled. Nothing has been spent on them, claim_jobs will never pick
// them up, and their prospects become available to enqueue again immediately.
//
// CLAIMED jobs are left alone. A worker holding one is already inside its calls to the data
// sources and the model, so cancelling could not stop the spend; and complete_job and
// fail_job are both scoped to state = 'claimed', so a row flipped underneath a running
// worker would match neither and end up asserting "cancelled" about work that finished.
//
// The response therefore reports BOTH numbers, and the screen says both. A stop that
// silently left work running would be worse than no stop at all.
//
// Auth: operator only, two clients per ADR-027. job_queue has RLS on with zero policies and
// no authenticated grant, so the write must go through the service client.

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { cancelQueuedResearchJobs, RESEARCH_JOB_TYPES } from '@/lib/queue/job-queue'
import { requireOperator } from '@/lib/supabase/require-operator'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: organisationId } = await params

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
    if (!authorized || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Counted AFTER the cancel, so the number reported as "still running" is the state the
    // operator is actually left in rather than a reading taken before the write.
    const cancelled = await cancelQueuedResearchJobs(supabase, organisationId)

    const { count: stillRunning, error: countError } = await supabase
      .from('job_queue')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', organisationId)
      .in('job_type', RESEARCH_JOB_TYPES as unknown as string[])
      .eq('state', 'claimed')

    if (countError) {
      throw new Error(`Cancelled ${cancelled}, but could not read what is still running: ${countError.message}`)
    }

    logger.info('cancel-research: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
      cancelled,
      still_running: stillRunning ?? 0,
    })

    return NextResponse.json({
      ok: true,
      result: { cancelled, still_running: stillRunning ?? 0 },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('cancel-research: failed', { organisation_id: organisationId, error: errorMsg })
    Sentry.captureException(err, { extra: { endpoint: '/cancel-research', organisationId } })
    return NextResponse.json({ error: `Could not stop research: ${errorMsg}` }, { status: 500 })
  }
}
