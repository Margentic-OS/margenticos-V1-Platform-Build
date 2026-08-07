// POST /api/cron/reap-agent-runs
//
// Called by Supabase pg_cron every 10 minutes via pg_net HTTP POST.
// Finds all agent_runs with status='running' that have been in that state for
// longer than 10 minutes and marks them 'failed' with a note that they were reaped.
//
// Auth: Authorization: Bearer ${CRON_SECRET} — same pattern as /api/cron/process-replies.
// IMPORTANT: On Supabase Hobby tier, current_setting('app.cron_secret') returns NULL.
// The cron job must be manually rescheduled with the secret hardcoded after migration.
// See migration 20260807 for the rescheduling instructions.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

// 10 minutes: safe margin over the 300s Vercel timeout (600s default + buffer)
const REAP_THRESHOLD_MS = 10 * 60 * 1000

export async function POST(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ────────────────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  try {
    // Fetch all agent_runs still in 'running' status
    const { data: running, error: fetchError } = await supabase
      .from('agent_runs')
      .select('id, organisation_id, agent_name, started_at')
      .eq('status', 'running')

    if (fetchError) {
      logger.error('Reap cron: failed to fetch running agent_runs', {
        error: fetchError.message,
      })
      return NextResponse.json({ error: 'Failed to fetch.' }, { status: 500 })
    }

    if (!running || running.length === 0) {
      logger.debug('Reap cron: no running agent_runs found')
      return NextResponse.json({ reaped: 0 })
    }

    const now = Date.now()
    const reaped: string[] = []
    const errors: { id: string; error: string }[] = []

    for (const run of running) {
      const startedMs = new Date(run.started_at).getTime()
      const elapsedMs = now - startedMs

      // Only reap if past the threshold
      if (elapsedMs < REAP_THRESHOLD_MS) {
        continue
      }

      try {
        const { error: updateError } = await supabase
          .from('agent_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            duration_ms: elapsedMs,
            error_message: `Reaped by cron: function exceeded timeout threshold (${Math.round(elapsedMs / 1000)}s > ${REAP_THRESHOLD_MS / 1000}s)`,
          })
          .eq('id', run.id)

        if (updateError) {
          errors.push({ id: run.id, error: updateError.message })
          logger.error('Reap cron: failed to reap agent_run', {
            run_id: run.id,
            organisation_id: run.organisation_id,
            agent_name: run.agent_name,
            error: updateError.message,
          })
        } else {
          reaped.push(run.id)
          logger.info('Reap cron: agent_run reaped', {
            run_id: run.id,
            organisation_id: run.organisation_id,
            agent_name: run.agent_name,
            elapsed_s: Math.round(elapsedMs / 1000),
          })
        }
      } catch (err) {
        errors.push({ id: run.id, error: String(err) })
        logger.error('Reap cron: unexpected error reaping agent_run', {
          run_id: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    logger.info('Reap cron: batch complete', {
      found: running.length,
      reaped: reaped.length,
      errors: errors.length,
    })

    if (errors.length > 0) {
      Sentry.captureMessage('Reap cron: some runs failed to reap', 'warning')
      try {
        await Sentry.flush(2000)
      } catch {}
    }

    return NextResponse.json({
      found: running.length,
      reaped: reaped.length,
      errors: errors.length,
    })
  } catch (err) {
    logger.error('Reap cron: unexpected error', {
      error: err instanceof Error ? err.message : String(err),
    })
    Sentry.captureException(err, {
      tags: { component: 'reap-agent-runs-cron' },
    })
    try {
      await Sentry.flush(2000)
    } catch {}
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
