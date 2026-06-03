// POST /api/operator/documents/force-approve
//
// Operator-only. Force-approves a specific pending strategy document immediately.
// This is the "proceed" escape hatch — skips the 3-day client-approval window.
//
// Auth:
//   1. User is authenticated (session cookie)
//   2. User role is 'operator'
//   Operators act cross-org (ADR-021) — no org restriction on which doc they
//   can approve, but the document must exist and be active.
//
// Body: { document_id: string }
// Idempotent — already-approved is a no-op success.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function buildSupabase() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
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
}

async function requireOperator(supabase: Awaited<ReturnType<typeof buildSupabase>>) {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { user: null, authorized: false }
  const { data: userRow } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!userRow || userRow.role !== 'operator') return { user, authorized: false }
  return { user, authorized: true }
}

export async function POST(request: NextRequest) {
  const supabase = await buildSupabase()
  const { user, authorized } = await requireOperator(supabase)

  if (!authorized) {
    return NextResponse.json(
      { error: user ? 'Operator access required.' : 'Not authenticated.' },
      { status: user ? 403 : 401 },
    )
  }

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

  const { data: existing } = await supabase
    .from('strategy_documents')
    .select('id, client_approval_status, organisation_id')
    .eq('id', document_id)
    .eq('status', 'active')
    .maybeSingle()

  if (!existing) {
    return NextResponse.json({ error: 'Document not found or not active.' }, { status: 404 })
  }

  if (existing.client_approval_status === 'approved') {
    return NextResponse.json({ approved: true, was_already_approved: true })
  }

  const { error: updateError } = await supabase
    .from('strategy_documents')
    .update({
      client_approval_status: 'approved',
      approval_source: 'operator',
      approved_at: new Date().toISOString(),
    })
    .eq('id', document_id)
    .eq('status', 'active')

  if (updateError) {
    logger.error('POST /api/operator/documents/force-approve: update failed', {
      document_id,
      error: updateError.message,
    })
    return NextResponse.json({ error: 'Failed to force-approve document.' }, { status: 500 })
  }

  logger.info('POST /api/operator/documents/force-approve: document force-approved', {
    document_id,
    org_id: existing.organisation_id,
    operator_user_id: user!.id,
  })

  return NextResponse.json({ approved: true, was_already_approved: false })
}
