// POST /api/webhooks/users-pending-review-notify
//
// Called by a Supabase Database Webhook on INSERT into public.users_pending_review.
// Fires when the handle_new_user() trigger blocks a second signup for an organisation
// that already has a client user, and inserts a row into users_pending_review.
//
// Auth: shared secret in x-webhook-secret header, verified against
// SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET environment variable.
//
// The webhook payload from Supabase looks like:
//   { type: "INSERT", table: "users_pending_review", record: { id, email, attempted_org_id, ... } }
//
// On receipt: looks up the organisation name, then sends the operator an email.

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import {
  multiUserSignupAttemptTemplate,
  multiUserSignupAttemptSubject,
} from '@/lib/email/templates/multi-user-signup-attempt'

function getAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface WebhookPayload {
  type?: string
  table?: string
  record?: {
    id?: string
    email?: string
    attempted_org_id?: string
  }
}

export async function POST(request: NextRequest) {
  // ── 1. Verify shared secret ────────────────────────────────────────────────
  const expectedSecret = process.env.SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET
  const providedSecret = request.headers.get('x-webhook-secret')

  if (!expectedSecret || providedSecret !== expectedSecret) {
    logger.warn('users-pending-review-notify: invalid or missing webhook secret')
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  // ── 2. Parse payload ───────────────────────────────────────────────────────
  let payload: WebhookPayload
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const { email, attempted_org_id } = payload.record ?? {}

  if (!email || !attempted_org_id) {
    logger.warn('users-pending-review-notify: payload missing email or attempted_org_id', { payload })
    return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 })
  }

  // ── 3. Look up organisation name ───────────────────────────────────────────
  const adminClient = getAdminClient()
  const { data: org, error: orgError } = await adminClient
    .from('organisations')
    .select('id, name')
    .eq('id', attempted_org_id)
    .single()

  if (orgError || !org) {
    logger.error('users-pending-review-notify: organisation not found', { attempted_org_id, error: orgError?.message })
    return NextResponse.json({ error: 'Organisation not found.' }, { status: 404 })
  }

  // ── 4. Send operator notification ─────────────────────────────────────────
  const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
  if (!operatorEmail) {
    logger.warn('users-pending-review-notify: RESEND_OPERATOR_EMAIL not set — notification skipped', { attempted_org_id })
    return NextResponse.json({ status: 'skipped' })
  }

  await sendTransactionalEmail({
    to: operatorEmail,
    subject: multiUserSignupAttemptSubject(org.name),
    html: multiUserSignupAttemptTemplate({
      attemptedEmail: email,
      orgId: org.id,
      orgName: org.name,
    }),
  })

  logger.info('users-pending-review-notify: notification sent', { attempted_org_id, email })

  return NextResponse.json({ status: 'ok' })
}
