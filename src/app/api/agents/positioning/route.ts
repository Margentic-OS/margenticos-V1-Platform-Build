// POST /api/agents/positioning
// Triggers the Positioning generation agent for a given organisation.
//
// Auth: operator session OR valid x-internal-secret header.
// The internal secret allows /api/intake/complete to dispatch this route
// on behalf of a client user without an operator session.
//
// Dependency: the positioning agent requires an active ICP document.
// If none exists, the agent throws a clear error explaining what to do first.
//
// Last-agent-finished: after the agent completes (or fails), checks whether
// all four agent_runs for this org are done. If so, sends the operator email
// and stamps docs_complete_notification_sent_at atomically.
//
// ADR-021: operator routes are cross-org — any org_id is valid for authenticated operators
//
// The agent writes to document_suggestions only.
// Doug reviews and approves before anything reaches strategy_documents.

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { runPositioningGenerationAgent } from '@/agents/positioning-generation-agent'
import { logger } from '@/lib/logger'

export const maxDuration = 300

function getAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(request: NextRequest) {
  // ── 1. Parse request body ──────────────────────────────────────────────────
  let body: { organisation_id?: string; is_refresh?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body.' },
      { status: 400 }
    )
  }

  const { organisation_id, is_refresh = false } = body

  if (!organisation_id || typeof organisation_id !== 'string') {
    return NextResponse.json(
      { error: 'organisation_id is required.' },
      { status: 400 }
    )
  }

  // ── 2. Auth: operator session OR internal secret ───────────────────────────
  const internalSecret = process.env.NEXT_INTERNAL_SECRET
  const providedSecret = request.headers.get('x-internal-secret')
  const isInternalCall = internalSecret && providedSecret === internalSecret

  // ── 3. Create Supabase clients ─────────────────────────────────────────────
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
  const supabase = getAdminClient()

  let operatorId = 'internal'

  if (!isInternalCall) {
    const { data: { user }, error: authError } = await sessionClient.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Not authenticated.' },
        { status: 401 }
      )
    }

    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (userError || !userRow) {
      return NextResponse.json(
        { error: 'Could not verify user role.' },
        { status: 403 }
      )
    }

    if (userRow.role !== 'operator') {
      logger.warn(
        'Positioning route: non-operator attempted to trigger agent',
        { user_id: user.id, role: userRow.role, organisation_id }
      )
      return NextResponse.json(
        { error: 'Only operators can trigger document generation.' },
        { status: 403 }
      )
    }

    operatorId = user.id
  }

  // ── 4. Verify the organisation exists ──────────────────────────────────────
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', organisation_id)
    .single()

  if (orgError || !org) {
    return NextResponse.json(
      { error: `Organisation ${organisation_id} not found.` },
      { status: 404 }
    )
  }

  // ── 5. Run the agent ───────────────────────────────────────────────────────
  logger.info(
    'Positioning route: starting agent run',
    { operator_id: operatorId, organisation_id, org_name: org.name, is_refresh }
  )

  try {
    const result = await runPositioningGenerationAgent({
      organisation_id,
      supabase,
      is_refresh,
    })

    return NextResponse.json(result, { status: 200 })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    logger.error(
      'Positioning route: agent run failed',
      { organisation_id, error: message }
    )

    // Surface ICP dependency errors directly — these are operator-actionable.
    if (
      message.includes('no ICP document found') ||
      message.includes('ICP document exists but has status')
    ) {
      return NextResponse.json({ error: message }, { status: 422 })
    }

    return NextResponse.json(
      { error: 'Positioning agent failed. Check server logs for details.' },
      { status: 500 }
    )
  }
}
