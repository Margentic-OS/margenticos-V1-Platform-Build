// POST /api/documents/approve
//
// Client-facing. Approves one active strategy document owned by the
// authenticated user's organisation. Idempotent — already-approved is success.
//
// Three checks before any data is written:
//   1. User is authenticated
//   2. User's organisation_id is resolved from the users table
//   3. document_id belongs to that organisation and is active
//
// The UPDATE uses service-role with an explicit organisation_id filter —
// ownership enforced in the WHERE clause, not just at the session level.

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createCookieClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const supabase = await createCookieClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Resolve org ─────────────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single()

  if (!userRow?.organisation_id) {
    return NextResponse.json({ error: 'Organisation not found.' }, { status: 403 })
  }

  const orgId = userRow.organisation_id

  // ── 3. Parse and validate body ─────────────────────────────────────────────
  let body: { document_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { document_id } = body
  if (!document_id || typeof document_id !== 'string' || !UUID_RE.test(document_id)) {
    return NextResponse.json({ error: 'document_id must be a valid UUID.' }, { status: 400 })
  }

  // ── 4. Ownership check + idempotency ───────────────────────────────────────
  const admin = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: existing } = await admin
    .from('strategy_documents')
    .select('id, client_approval_status')
    .eq('id', document_id)
    .eq('organisation_id', orgId)
    .eq('status', 'active')
    .maybeSingle()

  if (!existing) {
    return NextResponse.json({ error: 'Document not found or not accessible.' }, { status: 404 })
  }

  if (existing.client_approval_status === 'approved') {
    return NextResponse.json({ approved: true, was_already_approved: true })
  }

  // ── 5. Approve ─────────────────────────────────────────────────────────────
  const { error: updateError } = await admin
    .from('strategy_documents')
    .update({
      client_approval_status: 'approved',
      approval_source: 'client',
      approved_at: new Date().toISOString(),
    })
    .eq('id', document_id)
    .eq('organisation_id', orgId)
    .eq('status', 'active')

  if (updateError) {
    logger.error('POST /api/documents/approve: update failed', {
      document_id,
      org_id: orgId,
      error: updateError.message,
    })
    return NextResponse.json({ error: 'Failed to approve document.' }, { status: 500 })
  }

  logger.info('POST /api/documents/approve: document approved by client', {
    document_id,
    org_id: orgId,
    user_id: user.id,
  })

  return NextResponse.json({ approved: true, was_already_approved: false })
}
