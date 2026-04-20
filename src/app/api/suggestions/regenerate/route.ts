// POST /api/suggestions/regenerate
//
// Rejects the current suggestion and fires a new agent run for the same
// document type. Returns immediately — the agent runs asynchronously.
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User is operator OR client_id matches their own organisation_id
//   3. Suggestion exists, belongs to client_id, and is pending

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
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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

  // ── 1. Authenticated ────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Operator OR own organisation ─────────────────────────────────────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  const isOperator = userRow.role === 'operator'
  const isOwnOrg   = userRow.organisation_id === client_id

  if (!isOperator && !isOwnOrg) {
    logger.warn('Regenerate route: unauthorised attempt', {
      user_id: user.id,
      client_id,
      role: userRow.role,
    })
    return NextResponse.json({ error: 'Not authorised for this organisation.' }, { status: 403 })
  }

  // ── 3 & 4. If a suggestion_id was provided, verify and reject it ─────────────
  if (suggestion_id) {
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

  // ── 5. Fire new agent run asynchronously ────────────────────────────────────
  // Phase 1: fire-and-forget. The agent writes a new pending suggestion when done.
  // A proper job queue should replace this in a later phase.
  const serviceSupabase = makeServiceClient()

  void AGENT_MAP[document_type]({
    organisation_id: client_id,
    supabase: serviceSupabase,
    is_refresh: true,
  }).catch((err: unknown) => {
    logger.error('Regenerate route: agent run failed', {
      client_id,
      document_type,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  logger.info('Regenerate route: agent queued', {
    suggestion_id,
    client_id,
    document_type,
    operator_id: user.id,
  })

  return NextResponse.json({ success: true, message: 'New suggestion generating' }, { status: 200 })
}
