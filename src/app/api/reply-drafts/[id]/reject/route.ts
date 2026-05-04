// POST /api/reply-drafts/[id]/reject
//
// Operator rejects a reply draft. No send. No extraction.
//
// Accepted statuses: 'pending' | 'send_failed'
//   pending    — normal path (operator decides not to send the draft)
//   send_failed — post-approval send failure; operator dismisses the row from the queue
//                 and handles the reply manually outside the platform
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User role is 'operator'
//   3. Draft exists and is in a rejectable status
//
// Request body (optional):
//   { reason?: string }  — optional rejection reason stored in draft_metadata
//
// Response:
//   200 — rejected
//   409 — draft is not in a rejectable status
//   404 — draft not found

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Draft ID is required.' }, { status: 400 })
  }

  const body = await request.json().catch(() => ({})) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )

  // ── 1. Authenticated ────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Operator role ────────────────────────────────────────────────────────
  // ADR-021: operator endpoints are cross-org — select role only, no organisation_id.
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  if (userRow.role !== 'operator') {
    logger.warn('reply-drafts reject: non-operator attempted rejection', { user_id: user.id, role: userRow.role, draft_id: id })
    return NextResponse.json({ error: 'Only operators can reject reply drafts.' }, { status: 403 })
  }

  // ── 3. Load draft ────────────────────────────────────────────────────────────
  // ADR-021: operator endpoints are cross-org — no organisation_id filter.
  const { data: draft, error: draftError } = await supabase
    .from('reply_drafts')
    .select('id, organisation_id, status, draft_metadata')
    .eq('id', id)
    .maybeSingle()

  if (draftError || !draft) {
    return NextResponse.json({ error: 'Draft not found.' }, { status: 404 })
  }

  if (draft.status !== 'pending' && draft.status !== 'send_failed') {
    return NextResponse.json(
      { error: `Draft is already '${draft.status}' — cannot reject.` },
      { status: 409 }
    )
  }

  // ── 4. Idempotent rejection ─────────────────────────────────────────────────
  const now = new Date().toISOString()

  const updatedMetadata = reason
    ? { ...(draft.draft_metadata as Record<string, unknown> ?? {}), rejection_reason: reason }
    : draft.draft_metadata

  const { error: updateError, count } = await supabase
    .from('reply_drafts')
    .update({
      status: 'rejected',
      reviewed_by_user_id: user.id,
      reviewed_at: now,
      draft_metadata: updatedMetadata,
      updated_at: now,
    })
    .eq('id', id)
    .in('status', ['pending', 'send_failed'])  // idempotency: both rejectable statuses

  if (updateError) {
    logger.error('reply-drafts reject: update failed', { draft_id: id, error: updateError.message })
    return NextResponse.json({ error: 'Failed to reject draft.' }, { status: 500 })
  }

  if (count === 0) {
    return NextResponse.json(
      { error: 'Draft status changed between check and update — try again.' },
      { status: 409 }
    )
  }

  logger.info('reply-drafts reject: draft rejected', { draft_id: id, operator_id: user.id })

  return NextResponse.json({ status: 'rejected' }, { status: 200 })
}
