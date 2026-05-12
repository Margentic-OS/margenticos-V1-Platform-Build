// POST /api/operator/faq-extractions/[id]/approve-merge
//
// Operator-only. Appends the extracted_question as a new variant string on an
// existing approved FAQ, then marks faq_extractions.status = 'approved_merge'.
//
// The jsonb append is done via supabase.rpc('append_faq_variant') — a single
// atomic UPDATE with the || operator. No read-then-write in application code.
// Concurrent merges into the same target FAQ both succeed independently.
//
// Body: { target_faq_id: string, organisation_id: string }
// Response: { ok: true }
// 409 if extraction is already actioned.
// 404 if extraction or target FAQ not found.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
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

  const { target_faq_id, organisation_id } = body
  if (!target_faq_id || typeof target_faq_id !== 'string' || !UUID_RE.test(target_faq_id)) {
    return NextResponse.json({ error: 'target_faq_id is required.' }, { status: 400 })
  }
  if (!organisation_id || typeof organisation_id !== 'string' || !UUID_RE.test(organisation_id)) {
    return NextResponse.json({ error: 'organisation_id is required.' }, { status: 400 })
  }

  // ── 3. Load extraction ────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction, error: fetchError } = await (supabase as any)
    .from('faq_extractions')
    .select('id, organisation_id, extracted_question, status')
    .eq('id', id)
    .eq('organisation_id', organisation_id)   // ADR-003: defensive org check
    .maybeSingle()

  if (fetchError) {
    logger.error('approve-merge: extraction fetch failed', { extraction_id: id, error: fetchError.message })
    return NextResponse.json({ error: 'Failed to load extraction.' }, { status: 500 })
  }
  if (!extraction) {
    return NextResponse.json({ error: 'Extraction not found.' }, { status: 404 })
  }
  if (extraction.status !== 'pending') {
    return NextResponse.json({ error: 'Extraction has already been actioned.' }, { status: 409 })
  }

  // ── 4. Verify target FAQ belongs to same org ──────────────────────────────
  // ADR-003: confirm the target FAQ is in the same org as the extraction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: targetFaq } = await (supabase as any)
    .from('faqs')
    .select('id, organisation_id')
    .eq('id', target_faq_id)
    .maybeSingle()

  if (!targetFaq) {
    return NextResponse.json({ error: 'Target FAQ not found.' }, { status: 404 })
  }
  if (targetFaq.organisation_id !== organisation_id) {
    logger.error('approve-merge: CRITICAL — target FAQ org mismatch', {
      extraction_id: id,
      target_faq_id,
      extraction_org: organisation_id,
      faq_org: targetFaq.organisation_id,
    })
    return NextResponse.json({ error: 'Target FAQ does not belong to this organisation.' }, { status: 403 })
  }

  // ── 5. Atomically append variant via Postgres function ────────────────────
  // append_faq_variant uses a single UPDATE with || — no read-then-write.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: rpcError } = await (supabase as any).rpc('append_faq_variant', {
    p_faq_id: target_faq_id,
    p_new_variant: extraction.extracted_question,
  })

  if (rpcError) {
    logger.error('approve-merge: append_faq_variant failed', {
      extraction_id: id,
      target_faq_id,
      error: rpcError.message,
    })
    return NextResponse.json({ error: 'Failed to merge variant into FAQ.' }, { status: 500 })
  }

  // ── 6. Mark extraction approved_merge ─────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase as any)
    .from('faq_extractions')
    .update({
      status: 'approved_merge',
      reviewed_by_user_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (updateError) {
    logger.warn('approve-merge: extraction status update failed (variant was appended)', {
      extraction_id: id,
      target_faq_id,
      error: updateError.message,
    })
    // Non-fatal — the variant was successfully added to the FAQ.
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
