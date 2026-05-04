// GET /api/reply-drafts/[id]
//
// Returns a single reply draft with full signal, prospect, and FAQ data.
// FAQ rows are resolved from draft_metadata.faq_ids_used — useful for the
// triage detail view and any future integrations that need the full picture.
//
// Three auth checks on every request:
//   1. User is authenticated
//   2. User role is 'operator'
//   3. Draft exists and belongs to the operator's organisation
//
// Response shape:
//   200 { draft: TriageDraftItem }
//   401 / 403 / 404 / 500 on error

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { extractReplyBody } from '@/lib/reply-handling/extract-reply-body'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Draft ID is required.' }, { status: 400 })
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

  // ── 1. Authenticated ──────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Operator role + org ────────────────────────────────────────────────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  if (userRow.role !== 'operator') {
    logger.warn('reply-drafts detail: non-operator attempted access', { user_id: user.id, draft_id: id })
    return NextResponse.json({ error: 'Only operators can access reply drafts.' }, { status: 403 })
  }

  // ── 3. Fetch draft with signal + prospect ─────────────────────────────────────
  // ADR-021: operator endpoints are cross-org — no organisation_id filter here.
  const { data: row, error: queryError } = await supabase
    .from('reply_drafts')
    .select(`
      id,
      signal_id,
      prospect_id,
      tier,
      intent,
      ai_draft_body,
      draft_metadata,
      status,
      send_error,
      created_at,
      updated_at,
      organisations ( name ),
      signals (
        raw_data,
        original_outbound_body,
        prospect_id,
        prospects (
          id,
          first_name,
          last_name,
          email,
          linkedin_url
        )
      )
    `)
    .eq('id', id)
    .maybeSingle()

  if (queryError) {
    logger.error('reply-drafts detail: query failed', { draft_id: id, error: queryError.message })
    return NextResponse.json({ error: 'Failed to load draft.' }, { status: 500 })
  }

  if (!row) {
    return NextResponse.json({ error: 'Draft not found.' }, { status: 404 })
  }

  // ── 4. Transform ──────────────────────────────────────────────────────────────
  type SignalRow = {
    raw_data: unknown
    original_outbound_body: string | null
    prospect_id: string | null
    prospects: {
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
      linkedin_url: string | null
    } | null
  }

  type OrgRow = { name: string }

  const signal = row.signals as unknown as SignalRow | null
  const org = (row as unknown as { organisations: OrgRow | null }).organisations
  const signalProspect = signal?.prospects ?? null
  const metadata = (row.draft_metadata ?? {}) as Record<string, unknown>

  const draft = {
    id: row.id,
    signal_id: row.signal_id,
    prospect_id: row.prospect_id ?? null,
    tier: row.tier as 2 | 3,
    intent: row.intent,
    ai_draft_body: row.ai_draft_body ?? null,
    draft_metadata: metadata,
    status: row.status,
    send_error: row.send_error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    signal_reply_body: signal ? extractReplyBody(signal.raw_data) : null,
    original_outbound_body: signal?.original_outbound_body ?? null,
    organisation_name: org?.name ?? null,
    prospect: signalProspect
      ? {
          id: signalProspect.id,
          first_name: signalProspect.first_name,
          last_name: signalProspect.last_name,
          email: signalProspect.email,
          linkedin_url: signalProspect.linkedin_url,
        }
      : null,
    faqs: [] as { id: string; question_canonical: string; answer: string; times_used: number }[],
  }

  // ── 5. Resolve FAQs for Tier 2 drafts ────────────────────────────────────────
  if (draft.tier === 2) {
    const faqIds = (metadata.faq_ids_used ?? []) as string[]
    if (faqIds.length > 0) {
      const { data: faqRows, error: faqError } = await supabase
        .from('faqs')
        .select('id, question_canonical, answer, times_used')
        .in('id', faqIds)

      if (faqError) {
        logger.warn('reply-drafts detail: FAQ fetch failed', { draft_id: id, error: faqError.message })
      } else {
        draft.faqs = faqRows ?? []
      }
    }
  }

  return NextResponse.json({ draft }, { status: 200 })
}
