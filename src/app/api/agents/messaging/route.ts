// POST /api/agents/messaging
// Triggers the Messaging Playbook generation agent for a given organisation.
//
// Three checks before any data is touched:
//   1. User is authenticated
//   2. User role is 'operator' — clients cannot trigger document generation
//   3. organisation_id in the request is a real organisation
//
// Dependencies: ICP, Positioning, and TOV documents must all exist and be active.
// If any are missing, the agent throws a clear error naming exactly which are absent.
// This is the final agent in the document generation sequence.
//
// The agent writes to document_suggestions only.
// Doug reviews and approves before anything reaches strategy_documents.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { runMessagingGenerationAgent } from '@/agents/messaging-generation-agent'
import { logger } from '@/lib/logger'

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

  // ── 2. Create Supabase client (uses the operator's authenticated session) ──
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

  // ── 3. Verify authenticated user ───────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json(
      { error: 'Not authenticated.' },
      { status: 401 }
    )
  }

  // ── 4. Verify operator role — checked on every request, not just at login ──
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
      'Messaging route: non-operator attempted to trigger agent',
      { user_id: user.id, role: userRow.role, organisation_id }
    )
    return NextResponse.json(
      { error: 'Only operators can trigger document generation.' },
      { status: 403 }
    )
  }

  // ── 5. Verify the organisation exists ──────────────────────────────────────
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

  // ── 6. Run the agent ───────────────────────────────────────────────────────
  logger.info(
    'Messaging route: starting agent run',
    { operator_id: user.id, organisation_id, org_name: org.name, is_refresh }
  )

  try {
    const result = await runMessagingGenerationAgent({
      organisation_id,
      supabase,
      is_refresh,
    })

    return NextResponse.json(result, { status: 200 })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    logger.error(
      'Messaging route: agent run failed',
      { organisation_id, error: message }
    )

    // Surface a helpful message when one or more prerequisite documents are missing.
    // This is the most likely failure mode — the error names exactly what's needed.
    if (message.includes('must be generated and approved')) {
      return NextResponse.json(
        { error: message },
        { status: 422 }
      )
    }

    return NextResponse.json(
      { error: 'Messaging agent failed. Check server logs for details.' },
      { status: 500 }
    )
  }
}
