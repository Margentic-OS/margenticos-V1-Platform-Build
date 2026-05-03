// POST /api/reply-drafts/[id]/approve
//
// Operator approves a pending reply draft and triggers immediate send.
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User role is 'operator'
//   3. Draft exists, belongs to the operator's organisation, and is 'pending'
//
// Request body:
//   { final_body: string, edited: boolean }
//     final_body — the body to send (may be operator-edited from ai_draft_body)
//     edited     — true if operator changed the AI draft
//
// Response:
//   200 { status: 'sent', instantly_message_id: string | null }
//   200 { status: 'send_failed', error: string, reason: string }  — send failed; structured for UI
//   200 { status: 'idempotent_skip', reason: string }
//   409 — draft is not in 'pending' status
//   404 — draft not found (or belongs to another org)

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { sendApprovedDraft } from '@/lib/reply-handling/send-approved-draft'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Draft ID is required.' }, { status: 400 })
  }

  const body = await request.json().catch(() => null) as {
    final_body?: unknown
    edited?: unknown
  } | null

  const finalBody = typeof body?.final_body === 'string' ? body.final_body.trim() : ''
  const edited = body?.edited === true

  if (!finalBody) {
    return NextResponse.json({ error: 'final_body is required and must not be empty.' }, { status: 400 })
  }

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

  // ── 2. Operator role + get user's organisation_id ───────────────────────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  if (userRow.role !== 'operator') {
    logger.warn('reply-drafts approve: non-operator attempted approval', { user_id: user.id, role: userRow.role, draft_id: id })
    return NextResponse.json({ error: 'Only operators can approve reply drafts.' }, { status: 403 })
  }

  const operatorOrgId = userRow.organisation_id

  // ── 3. Load draft with org scoping (prevents cross-org access) ──────────────
  const { data: draft, error: draftError } = await supabase
    .from('reply_drafts')
    .select('id, organisation_id, status')
    .eq('id', id)
    .eq('organisation_id', operatorOrgId ?? '')   // 404 if draft belongs to another org
    .maybeSingle()

  if (draftError || !draft) {
    return NextResponse.json({ error: 'Draft not found.' }, { status: 404 })
  }

  if (draft.status !== 'pending') {
    return NextResponse.json(
      { error: `Draft is already '${draft.status}' — cannot approve.` },
      { status: 409 }
    )
  }

  // ── 4. Idempotent status transition to 'approved' ───────────────────────────
  const now = new Date().toISOString()

  const { error: updateError, count } = await supabase
    .from('reply_drafts')
    .update({
      status: 'approved',
      final_sent_body: finalBody,
      reviewed_by_user_id: user.id,
      reviewed_at: now,
      edited_at: edited ? now : null,
      edited_by_user_id: edited ? user.id : null,
      updated_at: now,
    })
    .eq('id', id)
    .eq('status', 'pending')         // idempotency: only one concurrent approve can win
    .eq('organisation_id', operatorOrgId ?? '')

  if (updateError) {
    logger.error('reply-drafts approve: status update failed', { draft_id: id, error: updateError.message })
    return NextResponse.json({ error: 'Failed to update draft status.' }, { status: 500 })
  }

  if (count === 0) {
    return NextResponse.json(
      { error: 'Draft status changed between check and update — try again.' },
      { status: 409 }
    )
  }

  // ── 5. Send ─────────────────────────────────────────────────────────────────
  const sendResult = await sendApprovedDraft(id, supabase)

  logger.info('reply-drafts approve: send result', { draft_id: id, result_kind: sendResult.kind })

  return NextResponse.json(sendResult.kind === 'sent'
    ? { status: 'sent', instantly_message_id: sendResult.instantly_message_id }
    : sendResult.kind === 'send_failed'
      ? { status: 'send_failed', error: sendResult.error, reason: sendResult.reason }
      : { status: 'idempotent_skip', reason: sendResult.reason },
    { status: 200 }
  )
}
