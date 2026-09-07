// GET /api/generation-status
//
// Reports what happened to the most recent generation run for an org+doctype.
//
// ─── WHY THIS RETURNS AN OUTCOME AND NOT JUST A BOOLEAN ──────────────────────
//
// It used to return `{ isGenerating: boolean }` and nothing else, computed from
// status='running'. That shape CANNOT EXPRESS FAILURE, and the one caller read a false
// as "finished":
//
//   const isGenerating = await checkGenerationStatus()
//   if (!isGenerating) {
//     // Generation completed — clear polling and remain in generating state
//   }
//
// So when the 2026-09-05 tov run failed, the poll went false, polling stopped, the
// component stayed in its 'generating' state, and the client kept seeing "Generating your
// Tone of voice guide..." with a pulsing dot. For ever: nothing re-renders the parent, and
// the operator's button never polled at all.
//
// A boolean that collapses "still working", "finished", "failed" and "never started" into
// one bit will be read as the happy case every time. So the route now says which it is.
//
// ─── outcome ─────────────────────────────────────────────────────────────────
//
//   generating  a run is in flight and started within the freshness window
//   succeeded   the most recent run completed
//   failed      the most recent run failed
//   stalled     the most recent run says 'running' but started outside the window, so
//               nothing is coming. Deliberately NOT folded into 'failed': the remedy
//               differs, and the reaper has not marked it yet.
//   none        no run has ever been recorded for this org and document type
//
// Query params: client_id, document_type ('icp' | 'positioning' | 'tov' | 'messaging')
//
// error_message is returned to OPERATORS ONLY. Agent errors name models, prompts and
// internals, and a client seeing "Claude returned content that is not valid JSON" learns
// nothing they can act on. Clients get the outcome, which is what changes what they do.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const client_id = searchParams.get('client_id')
  const document_type = searchParams.get('document_type')

  if (!client_id || !document_type) {
    return NextResponse.json(
      { error: 'client_id and document_type query params are required.' },
      { status: 400 }
    )
  }

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
  const supabase = makeServiceClient()

  // ── Auth: user must be authenticated ────────────────────────────────────────
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── Auth: user must be operator OR belong to this org ────────────────────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  const isOperator = userRow.role === 'operator'
  const userOrgId = userRow.organisation_id

  if (!isOperator && userOrgId !== client_id) {
    return NextResponse.json({ error: 'Not authorized for this client.' }, { status: 403 })
  }

  // ── The most recent run, whatever became of it ──────────────────────────────
  //
  // Ordered by started_at rather than filtered by status, because the whole point is to
  // see a run that is NOT running. Filtering on status='running' is what made failure
  // unrepresentable.
  const RUNNING_THRESHOLD_MS = 10 * 60 * 1000

  const { data: latest, error: runError } = await supabase
    .from('agent_runs')
    .select('id, status, started_at, completed_at, error_message')
    .eq('organisation_id', client_id)
    .eq('agent_name', `${document_type}-generation`)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (runError) {
    logger.error('generation-status: could not read agent_runs', {
      client_id,
      document_type,
      error: runError.message,
    })
    return NextResponse.json({ error: 'Could not read generation status.' }, { status: 500 })
  }

  if (!latest) {
    return NextResponse.json({ isGenerating: false, outcome: 'none', latestRun: null })
  }

  const elapsedMs = Date.now() - new Date(latest.started_at).getTime()
  const isFresh = elapsedMs < RUNNING_THRESHOLD_MS

  const outcome =
    latest.status === 'running'
      ? (isFresh ? 'generating' : 'stalled')
      : latest.status === 'failed'
        ? 'failed'
        : 'succeeded'

  return NextResponse.json({
    // Kept so existing callers keep working. It means what it always meant, and it is
    // now the narrower of the two signals rather than the only one.
    isGenerating: outcome === 'generating',
    run_id: latest.id,
    started_at: latest.started_at,
    outcome,
    latestRun: {
      id: latest.id,
      status: latest.status,
      started_at: latest.started_at,
      completed_at: latest.completed_at,
      // Operator only. See the header.
      ...(isOperator ? { error_message: latest.error_message } : {}),
    },
  })
}
