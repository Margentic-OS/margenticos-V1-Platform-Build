// POST /api/suggestions/[id]/approve
//
// Promotes an approved suggestion into an active strategy document.
// This is the only path by which a strategy document is created or updated.
// Agents write to document_suggestions; this handler writes to strategy_documents.
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User role is 'operator'
//   3. Suggestion exists and is in 'pending' status
//
// The promotion is atomic via the approve_document_suggestion Postgres function:
//   - Archives the current active document (if one exists)
//   - Inserts a new active document with version incremented
//   - Marks the suggestion 'approved'
// If any step fails, the entire transaction rolls back — suggestion stays 'pending'.

import { NextRequest, NextResponse, after } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { triggerCascadeIfEligible } from '@/lib/agents/cascade/trigger-cascade'
import { notifyAfterPromotion } from '@/lib/notifications/notify-after-promotion'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Suggestion ID is required.' }, { status: 400 })
  }

  const cookieStore = await cookies()
  // Session client: reads user JWT from cookie — anon key only, no service role context
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
  // Service client: bypasses RLS as service_role — used for all DB operations
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── 1. Authenticated ────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Operator role — checked on every request, not just at login ──────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  if (userRow.role !== 'operator') {
    logger.warn('Approve route: non-operator attempted approval', {
      user_id: user.id,
      role: userRow.role,
      suggestion_id: id,
    })
    return NextResponse.json(
      { error: 'Only operators can approve suggestions.' },
      { status: 403 }
    )
  }

  // ── 3. Suggestion exists and belongs to a valid organisation ────────────────
  // Pre-check returns a clear 404/400 rather than an opaque error from the RPC function.
  const { data: suggestion, error: suggestionError } = await supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, status, update_trigger')
    .eq('id', id)
    .single()

  if (suggestionError || !suggestion) {
    return NextResponse.json({ error: 'Suggestion not found.' }, { status: 404 })
  }

  if (suggestion.status !== 'pending') {
    return NextResponse.json(
      { error: `Suggestion is already '${suggestion.status}' — cannot approve.` },
      { status: 400 }
    )
  }

  // ── 4. Atomic transaction via Postgres function ─────────────────────────────
  // archive active doc → insert new active doc → mark suggestion approved
  // Full rollback if any step fails — suggestion will remain 'pending'.
  const { data: newDoc, error: rpcError } = await supabase.rpc(
    'approve_document_suggestion',
    { p_suggestion_id: id, p_reviewer_id: user.id }
  )

  if (rpcError) {
    logger.error('Approve route: transaction failed', {
      suggestion_id: id,
      organisation_id: suggestion.organisation_id,
      document_type: suggestion.document_type,
      error: rpcError.message,
    })
    const msg = rpcError.message ?? ''
    let clientError: string
    if (msg.includes('not in pending status')) {
      clientError = 'This suggestion was already approved or rejected — no changes made.'
    } else if (msg.includes('missing the variants key')) {
      clientError = 'This suggestion is missing required content. Regenerate and try again.'
    } else if (msg.includes('not valid JSON')) {
      clientError = 'This suggestion contains invalid data. Regenerate and try again.'
    } else if (msg.includes('permission denied')) {
      clientError = 'Permission error — contact the platform operator.'
    } else {
      clientError = `Approval failed: ${msg}. The suggestion has not been changed.`
    }
    return NextResponse.json({ error: clientError }, { status: 500 })
  }

  logger.info('Approve route: suggestion approved', {
    suggestion_id: id,
    organisation_id: suggestion.organisation_id,
    document_type: suggestion.document_type,
    operator_id: user.id,
  })

  // Notify client after promotion, then cascade to next agent if eligible.
  // Both run in after() so they don't block the response.
  after(async () => {
    await notifyAfterPromotion(supabase, {
      organisation_id: suggestion.organisation_id,
      suggestion_id: id,
      document_type: suggestion.document_type,
      update_trigger: suggestion.update_trigger,
    })
    await triggerCascadeIfEligible(supabase, suggestion.organisation_id, suggestion.document_type)
  })

  return NextResponse.json(newDoc, { status: 200 })
}
