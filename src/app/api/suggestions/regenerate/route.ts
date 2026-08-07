// POST /api/suggestions/regenerate
//
// Rejects the current suggestion and fires a new agent run for the same
// document type. Returns immediately — the agent runs asynchronously.
//
// Can be called by:
//   - Operator: regenerate an existing pending suggestion
//   - Client: generate a doc type that has no current pending suggestion or is rejected
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User role — operators can regenerate anything, clients can only regenerate their own org
//   3. Suggestion exists and is pending (if regenerating), or no pending suggestion exists (if generating fresh)

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { runIcpGenerationAgent } from '@/agents/icp-generation-agent'
import { runPositioningGenerationAgent } from '@/agents/positioning-generation-agent'
import { runTovGenerationAgent } from '@/agents/tov-generation-agent'
import { runMessagingGenerationAgent } from '@/agents/messaging-generation-agent'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
type ServiceClient = ReturnType<typeof makeServiceClient>

const AGENT_MAP: Record<string, (input: { organisation_id: string; supabase: ServiceClient; is_refresh: boolean }) => Promise<unknown>> = {
  icp:        (i) => runIcpGenerationAgent(i),
  positioning:(i) => runPositioningGenerationAgent(i),
  tov:        (i) => runTovGenerationAgent(i),
  messaging:  (i) => runMessagingGenerationAgent(i),
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as {
    suggestion_id?: string
    client_id?: string
    document_type?: string
    rejection_reason?: string
  }

  const { suggestion_id, client_id, document_type, rejection_reason } = body

  // suggestion_id is optional — omit it when regenerating from an already-approved document
  // (no pending suggestion exists to reject in that case).
  if (!client_id || !document_type) {
    return NextResponse.json(
      { error: 'client_id and document_type are required.' },
      { status: 400 }
    )
  }

  if (!AGENT_MAP[document_type]) {
    return NextResponse.json(
      { error: `Unknown document_type "${document_type}". Valid values: icp, positioning, tov, messaging.` },
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

  // ── 1. Authenticated ────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Resolve user role and organisation context ───────────────────────────
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

  // Clients can only operate on their own organisation
  if (!isOperator && userOrgId !== client_id) {
    logger.warn('Regenerate route: client attempted cross-org operation', {
      user_id: user.id,
      user_org: userOrgId,
      requested_org: client_id,
    })
    return NextResponse.json({ error: 'Not authorized for this client.' }, { status: 403 })
  }

  // ── 3. Idempotency check: don't start generation if one is already running ───
  // Query running agent_runs for this org+doctype. If found and started within
  // threshold, return 409 (conflict). Zombie runs (> 10min old) are ignored.
  const RUNNING_THRESHOLD_MS = 10 * 60 * 1000
  const { data: activeRuns } = await supabase
    .from('agent_runs')
    .select('id, started_at')
    .eq('organisation_id', client_id)
    .eq('agent_name', `${document_type}-generation`)
    .eq('status', 'running')

  const now = Date.now()
  const freshRun = activeRuns?.find(run => {
    const elapsedMs = now - new Date(run.started_at).getTime()
    return elapsedMs < RUNNING_THRESHOLD_MS
  })

  if (freshRun) {
    logger.info('Regenerate route: generation already running for this doc type', {
      client_id,
      document_type,
      run_id: freshRun.id,
    })
    return NextResponse.json(
      { success: false, message: 'Generation already in progress for this document type. Please wait.' },
      { status: 409 }
    )
  }

  // ── 4. Resolve operation mode: regenerate vs generate-from-nothing ──────────
  let shouldReject = false

  if (suggestion_id) {
    // Operator mode: reject the current suggestion before generating fresh
    if (!isOperator) {
      return NextResponse.json(
        { error: 'Only operators can regenerate existing suggestions. Use the dashboard to request a new document.' },
        { status: 403 }
      )
    }

    const { data: suggestion, error: suggestionError } = await supabase
      .from('document_suggestions')
      .select('id, organisation_id, document_type, status')
      .eq('id', suggestion_id)
      .eq('organisation_id', client_id)
      .single()

    if (suggestionError || !suggestion) {
      return NextResponse.json({ error: 'Suggestion not found.' }, { status: 404 })
    }

    if (suggestion.status !== 'pending') {
      return NextResponse.json(
        { error: `Suggestion is already '${suggestion.status}' — cannot regenerate.` },
        { status: 400 }
      )
    }

    shouldReject = true
  } else {
    // Client mode: generate when no pending suggestion exists
    // Verify there's no current pending suggestion
    const { data: existingPending } = await supabase
      .from('document_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', client_id)
      .eq('document_type', document_type)
      .eq('status', 'pending')

    if ((existingPending?.length ?? 0) > 0) {
      return NextResponse.json(
        { error: `A suggestion for ${document_type} is already pending approval. Approve or reject it first.` },
        { status: 409 }
      )
    }
  }

  // ── 5. Reject current suggestion if regenerating (operator mode) ────────────
  if (shouldReject && suggestion_id) {
    const { error: rejectError } = await supabase
      .from('document_suggestions')
      .update({
        status:           'rejected',
        reviewed_at:      new Date().toISOString(),
        reviewed_by:      user.id,
        rejection_reason: typeof rejection_reason === 'string' ? rejection_reason.trim() || null : null,
      })
      .eq('id', suggestion_id)

    if (rejectError) {
      logger.error('Regenerate route: rejection update failed', {
        suggestion_id,
        error: rejectError.message,
      })
      return NextResponse.json({ error: 'Failed to reject suggestion. Try again.' }, { status: 500 })
    }
  }

  // ── 6. Fire new agent run asynchronously ────────────────────────────────────
  // is_refresh: true for regenerate (context from existing doc), false for generate-from-nothing
  const isRefresh = !!suggestion_id
  void AGENT_MAP[document_type]({
    organisation_id: client_id,
    supabase,
    is_refresh: isRefresh,
  }).catch((err: unknown) => {
    logger.error('Regenerate route: agent run failed', {
      client_id,
      document_type,
      caller_role: isOperator ? 'operator' : 'client',
      error: err instanceof Error ? err.message : String(err),
    })
  })

  logger.info('Regenerate route: agent queued', {
    suggestion_id: suggestion_id || null,
    client_id,
    document_type,
    caller_role: isOperator ? 'operator' : 'client',
    caller_id: user.id,
    mode: isRefresh ? 'regenerate' : 'generate_fresh',
  })

  const message = isRefresh
    ? 'New suggestion generating'
    : `${document_type} document is generating. You'll receive a notification when it's ready.`

  return NextResponse.json({ success: true, message }, { status: 200 })
}
