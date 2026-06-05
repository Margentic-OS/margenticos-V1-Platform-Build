// POST /api/operator/faq-extractions/[id]/approve-new
//
// Operator-only. Creates a new faqs row from the extraction candidate,
// then marks faq_extractions.status = 'approved_new'.
//
// Body: { organisation_id: string }
// Response: { faq_id: string }
// 409 if the extraction has already been actioned (status != 'pending').

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

  // ── 3. Load extraction — check status ─────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction, error: fetchError } = await (supabase as any)
    .from('faq_extractions')
    .select('id, organisation_id, extracted_question, suggested_answer, signal_id, status')
    .eq('id', id)
    .eq('organisation_id', organisation_id)   // ADR-003: defensive org check
    .maybeSingle()

  if (fetchError) {
    logger.error('approve-new: fetch failed', { extraction_id: id, error: fetchError.message })
    return NextResponse.json({ error: 'Failed to load extraction.' }, { status: 500 })
  }
  if (!extraction) {
    return NextResponse.json({ error: 'Extraction not found.' }, { status: 404 })
  }
  if (extraction.status !== 'pending') {
    return NextResponse.json({ error: 'Extraction has already been actioned.' }, { status: 409 })
  }

  // ── 4. Insert new FAQ ─────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: newFaq, error: insertError } = await (supabase as any)
    .from('faqs')
    .insert({
      organisation_id,
      question_canonical: extraction.extracted_question,
      answer: extraction.suggested_answer,
      status: 'approved',
      source_signal_ids: extraction.signal_id ? [extraction.signal_id] : [],
      created_by_user_id: user.id,
    })
    .select('id')
    .single()

  if (insertError) {
    logger.error('approve-new: FAQ insert failed', { extraction_id: id, error: insertError.message })
    return NextResponse.json({ error: 'Failed to create FAQ.' }, { status: 500 })
  }

  // ── 5. Mark extraction approved_new ──────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase as any)
    .from('faq_extractions')
    .update({
      status: 'approved_new',
      reviewed_by_user_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (updateError) {
    logger.warn('approve-new: extraction status update failed (FAQ was created)', {
      extraction_id: id,
      faq_id: newFaq.id,
      error: updateError.message,
    })
    // Non-fatal — FAQ exists. The extraction row will stay pending and can be re-actioned.
    // Operator should not see a user-facing error for this.
  }

  return NextResponse.json({ faq_id: newFaq.id }, { status: 201 })
}
