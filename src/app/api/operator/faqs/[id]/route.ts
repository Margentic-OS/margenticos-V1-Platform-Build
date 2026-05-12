// PATCH /api/operator/faqs/[id]
//
// Operator-only. ADR-021: operator endpoints are cross-org.
// Updates an approved FAQ's answer or archives it.
// Body: { answer?: string, status?: 'archived' | 'approved' }
//
// Returns 404 if the FAQ does not exist.
// Returns 400 if body contains no valid update fields.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'FAQ ID is required.' }, { status: 400 })
  }

  const cookieStore = await cookies()
  const supabase = createServerClient<Database>(
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

  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: userRow } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!userRow || userRow.role !== 'operator') {
    return NextResponse.json({ error: 'Operator access required.' }, { status: 403 })
  }

  // ── 2. Parse body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const patch: { answer?: string; status?: string; updated_at: string } = {
    updated_at: new Date().toISOString(),
  }

  if (typeof body.answer === 'string' && body.answer.trim()) {
    patch.answer = body.answer.trim()
  }
  if (body.status === 'archived' || body.status === 'approved') {
    patch.status = body.status
  }

  if (!patch.answer && !patch.status) {
    return NextResponse.json({ error: 'Provide at least one of: answer, status.' }, { status: 400 })
  }

  // ── 3. Verify FAQ exists ──────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('faqs')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (!existing) {
    return NextResponse.json({ error: 'FAQ not found.' }, { status: 404 })
  }

  // ── 4. Apply update ───────────────────────────────────────────────────────
  const { error } = await supabase
    .from('faqs')
    .update(patch)
    .eq('id', id)

  if (error) {
    logger.error('PATCH /api/operator/faqs/[id]: update failed', { faq_id: id, error: error.message })
    return NextResponse.json({ error: 'Failed to update FAQ.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
