// POST /api/operator/faq-extractions/[id]/reject
//
// Operator-only. Marks faq_extractions.status = 'rejected'.
// Body: { organisation_id: string }
// Response: { ok: true }
// 409 if already actioned.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Extraction ID is required.' }, { status: 400 })
  }

  const cookieStore = await cookies()
  const sessionClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )
  const supabase = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
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

  const { organisation_id } = body
  if (!organisation_id || typeof organisation_id !== 'string' || !UUID_RE.test(organisation_id)) {
    return NextResponse.json({ error: 'organisation_id is required.' }, { status: 400 })
  }

  // ── 3. Load extraction ────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction, error: fetchError } = await (supabase as any)
    .from('faq_extractions')
    .select('id, status')
    .eq('id', id)
    .eq('organisation_id', organisation_id)   // ADR-003
    .maybeSingle()

  if (fetchError) {
    logger.error('reject: extraction fetch failed', { extraction_id: id, error: fetchError.message })
    return NextResponse.json({ error: 'Failed to load extraction.' }, { status: 500 })
  }
  if (!extraction) {
    return NextResponse.json({ error: 'Extraction not found.' }, { status: 404 })
  }
  if (extraction.status !== 'pending') {
    return NextResponse.json({ error: 'Extraction has already been actioned.' }, { status: 409 })
  }

  // ── 4. Mark rejected ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase as any)
    .from('faq_extractions')
    .update({
      status: 'rejected',
      reviewed_by_user_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (updateError) {
    logger.error('reject: update failed', { extraction_id: id, error: updateError.message })
    return NextResponse.json({ error: 'Failed to reject extraction.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
