// POST /api/cron/strategy-doc-auto-approve
//
// Runs daily (06:00 UTC). Finds active strategy documents whose client-approval
// window has elapsed (pending_since older than 3 days) and marks them approved
// automatically so a non-responsive client does not stall launch.
//
// Auth: Authorization: Bearer ${CRON_SECRET} — same pattern as all cron routes.
// Any request without a valid token is rejected immediately.
//
// Uses service_role to act across all organisations without RLS interference.
// This is intentional — the cron acts as a system process, not a user.
//
// The UPDATE includes .eq('client_approval_status', 'pending') as a guard
// against the race where an operator or client approves between our query
// and the update.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Fetch docs whose 3-day window has elapsed ──────────────────────────────
  const cutoff = new Date(Date.now() - THREE_DAYS_MS).toISOString()

  const { data: due, error: fetchError } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, document_type, pending_since')
    .eq('status', 'active')
    .eq('client_approval_status', 'pending')
    .lt('pending_since', cutoff)

  if (fetchError) {
    logger.error('strategy-doc-auto-approve cron: fetch failed', { error: fetchError.message })
    return NextResponse.json({ error: 'Failed to fetch documents.' }, { status: 500 })
  }

  if (!due || due.length === 0) {
    logger.info('strategy-doc-auto-approve cron: no docs due for auto-approval')
    return NextResponse.json({ processed: 0, succeeded: 0, failed: 0 })
  }

  const now = new Date().toISOString()
  let succeeded = 0
  let failed = 0

  for (const doc of due) {
    const { error: updateError } = await supabase
      .from('strategy_documents')
      .update({
        client_approval_status: 'approved',
        approval_source: 'auto',
        approved_at: now,
      })
      .eq('id', doc.id)
      .eq('client_approval_status', 'pending')

    if (updateError) {
      logger.error('strategy-doc-auto-approve cron: update failed', {
        document_id: doc.id,
        org_id: doc.organisation_id,
        error: updateError.message,
      })
      failed++
    } else {
      logger.info('strategy-doc-auto-approve cron: doc auto-approved', {
        document_id: doc.id,
        org_id: doc.organisation_id,
        document_type: doc.document_type,
      })
      succeeded++
    }
  }

  logger.info('strategy-doc-auto-approve cron: batch complete', {
    processed: due.length,
    succeeded,
    failed,
  })

  return NextResponse.json({ processed: due.length, succeeded, failed })
}
