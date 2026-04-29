// POST /api/cron/process-replies
//
// Called by Supabase pg_cron every 5 minutes via pg_net HTTP POST.
// Classifies unprocessed reply_received signals and dispatches Tier 1 actions.
//
// Auth: Authorization: Bearer ${CRON_SECRET} — same pattern as /api/cron/instantly-poll.
// Uses service_role — required to read integration_credentials and write reply_handling_actions
// without RLS interference.
//
// Failures are reported in the response summary but do not throw — the cron job sees a 200
// on partial failures. Check the `errors` field in the response body for signal-level failures.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { processReplies } from '@/lib/reply-handling/process-reply'

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

  // ── Fetch Instantly API key ────────────────────────────────────────────────
  const { data: credential, error: credError } = await supabase
    .from('integration_credentials')
    .select('value')
    .is('organisation_id', null)
    .eq('source', 'instantly')
    .eq('credential_type', 'api_key')
    .maybeSingle()

  if (credError || !credential) {
    logger.error('process-replies: Instantly API key not found in integration_credentials', {
      error: credError?.message,
      fix: "INSERT INTO integration_credentials (organisation_id, source, credential_type, value) VALUES (NULL, 'instantly', 'api_key', '<key>')",
    })
    return NextResponse.json(
      { error: 'Instantly API key not configured.' },
      { status: 503 }
    )
  }

  // ── Process ────────────────────────────────────────────────────────────────
  let result
  try {
    result = await processReplies(supabase, credential.value)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('process-replies: processReplies threw unexpectedly', { error: msg })
    return NextResponse.json({ error: 'Internal error.', detail: msg }, { status: 500 })
  }

  logger.info('process-replies: run complete', { ...result })

  return NextResponse.json({ ok: true, result })
}
