// POST /api/cron/auto-approve
//
// Called by Vercel Cron on an hourly schedule. Finds all pending document
// suggestions whose auto-approve window has elapsed and promotes them to active
// strategy documents using the existing approve_document_suggestion transaction.
//
// Auth: Vercel injects CRON_SECRET as the Authorization bearer token on every
// cron invocation. Any request without a valid token is rejected immediately.
//
// Uses service_role to act across all organisations without RLS interference.
// This is intentional — the cron acts as a system process, not a user.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// Written into reviewed_by to identify auto-approved suggestions in the DB.
const SYSTEM_AUTO_APPROVE_ID = '00000000-0000-0000-0000-000000000001'

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

  // ── Fetch all pending suggestions with their org's approval window ──────────
  const { data: pending, error: fetchError } = await supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, created_at, organisations(auto_approve_window_hours)')
    .eq('status', 'pending')

  if (fetchError) {
    logger.error('Auto-approve cron: failed to fetch pending suggestions', {
      error: fetchError.message,
    })
    return NextResponse.json({ error: 'Failed to fetch suggestions.' }, { status: 500 })
  }

  if (!pending || pending.length === 0) {
    logger.info('Auto-approve cron: no pending suggestions found')
    return NextResponse.json({ processed: 0, succeeded: 0, failed: 0 })
  }

  const now = Date.now()
  let succeeded = 0
  let failed = 0

  const due = pending.filter((s) => {
    // Supabase returns foreign-key joins as arrays in its inferred types.
    const orgs = s.organisations as unknown as { auto_approve_window_hours: number }[] | null
    const windowHours = orgs?.[0]?.auto_approve_window_hours ?? 72
    const dueAt = new Date(s.created_at).getTime() + windowHours * 60 * 60 * 1000
    return dueAt <= now
  })

  logger.info('Auto-approve cron: processing due suggestions', {
    total_pending: pending.length,
    due_count: due.length,
  })

  for (const suggestion of due) {
    try {
      const { error: rpcError } = await supabase.rpc('approve_document_suggestion', {
        p_suggestion_id: suggestion.id,
        p_reviewer_id: SYSTEM_AUTO_APPROVE_ID,
      })

      if (rpcError) {
        throw new Error(rpcError.message)
      }

      logger.info('Auto-approve cron: suggestion auto-approved', {
        suggestion_id: suggestion.id,
        organisation_id: suggestion.organisation_id,
        document_type: suggestion.document_type,
      })
      succeeded++
    } catch (err) {
      logger.error('Auto-approve cron: failed to approve suggestion', {
        suggestion_id: suggestion.id,
        organisation_id: suggestion.organisation_id,
        document_type: suggestion.document_type,
        error: err instanceof Error ? err.message : String(err),
      })
      failed++
    }
  }

  logger.info('Auto-approve cron: batch complete', {
    processed: due.length,
    succeeded,
    failed,
  })

  return NextResponse.json({ processed: due.length, succeeded, failed })
}
