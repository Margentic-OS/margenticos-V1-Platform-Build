// POST /api/suggestions/[id]/reject
//
// Marks a pending suggestion as rejected. No document changes — reject is a
// simple status update, not a transaction.
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User role is 'operator'
//   3. Suggestion exists and is in 'pending' status

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Suggestion ID is required.' }, { status: 400 })
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
    logger.warn('Reject route: non-operator attempted rejection', {
      user_id: user.id,
      role: userRow.role,
      suggestion_id: id,
    })
    return NextResponse.json(
      { error: 'Only operators can reject suggestions.' },
      { status: 403 }
    )
  }

  // ── 3. Suggestion exists and is pending ─────────────────────────────────────
  const { data: suggestion, error: suggestionError } = await supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, status')
    .eq('id', id)
    .single()

  if (suggestionError || !suggestion) {
    return NextResponse.json({ error: 'Suggestion not found.' }, { status: 404 })
  }

  if (suggestion.status !== 'pending') {
    return NextResponse.json(
      { error: `Suggestion is already '${suggestion.status}' — cannot reject.` },
      { status: 400 }
    )
  }

  // ── 4. Mark rejected ────────────────────────────────────────────────────────
  const { data: updated, error: updateError } = await supabase
    .from('document_suggestions')
    .update({
      status:      'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
    })
    .eq('id', id)
    .select()
    .single()

  if (updateError || !updated) {
    logger.error('Reject route: update failed', {
      suggestion_id: id,
      error: updateError?.message,
    })
    return NextResponse.json({ error: 'Rejection failed. Check server logs.' }, { status: 500 })
  }

  logger.info('Reject route: suggestion rejected', {
    suggestion_id: id,
    organisation_id: suggestion.organisation_id,
    document_type: suggestion.document_type,
    operator_id: user.id,
  })

  return NextResponse.json(updated, { status: 200 })
}
