// GET /api/operator/faq-extractions?client=<orgId>
//
// Operator-only. ADR-021: operator endpoints are cross-org.
// Returns all pending faq_extractions for the specified client org,
// enriched with the similar FAQ's question_canonical for display in the curation card.
//
// Sort: newest first.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
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

  // ── 2. Validate client param ──────────────────────────────────────────────
  const orgId = request.nextUrl.searchParams.get('client')
  if (!orgId || !UUID_RE.test(orgId)) {
    return NextResponse.json({ error: 'client parameter is required and must be a valid org ID.' }, { status: 400 })
  }

  // ── 3. Fetch pending extractions with similar FAQ join ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('faq_extractions')
    .select(`
      id,
      organisation_id,
      extracted_question,
      suggested_answer,
      similar_faq_id,
      similar_pending_extraction_id,
      similarity_score,
      potential_names_flagged,
      created_at,
      similar_faq:faqs!faq_extractions_similar_faq_id_fkey(question_canonical)
    `)
    .eq('organisation_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('GET /api/operator/faq-extractions: query failed', { org_id: orgId, error: error.message })
    return NextResponse.json({ error: 'Failed to load extraction queue.' }, { status: 500 })
  }

  const extractions = (data ?? []).map((row: {
    id: string
    organisation_id: string
    extracted_question: string
    suggested_answer: string
    similar_faq_id: string | null
    similar_pending_extraction_id: string | null
    similarity_score: number | null
    potential_names_flagged: unknown
    created_at: string
    similar_faq: { question_canonical: string } | null
  }) => ({
    id: row.id,
    organisation_id: row.organisation_id,
    extracted_question: row.extracted_question,
    suggested_answer: row.suggested_answer,
    similar_faq_id: row.similar_faq_id,
    similar_faq_question: row.similar_faq?.question_canonical ?? null,
    similar_pending_extraction_id: row.similar_pending_extraction_id,
    similarity_score: row.similarity_score,
    potential_names_flagged: Array.isArray(row.potential_names_flagged)
      ? row.potential_names_flagged as string[]
      : [],
    created_at: row.created_at,
  }))

  return NextResponse.json({ extractions }, { status: 200 })
}
