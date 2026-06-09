// GET /api/reply-drafts
//
// Returns all reply_drafts rows requiring operator attention, enriched with
// signal + prospect data and resolved FAQ text for Tier 2 drafts.
//
// Two auth checks on every request:
//   1. User is authenticated
//   2. User role is 'operator'
// ADR-021: operator endpoint is cross-org — returns drafts from all organisations
//
// Statuses returned (triage queue):
//   pending         — AI-drafted, awaiting operator approval
//   manual_required — no draft generated (missing org context); operator writes
//   draft_failed    — drafter failed after retries; operator writes
//   send_failed     — post-approval send to Instantly failed; operator dismisses
//
// Sort order (status priority, then created_at DESC within each group):
//   pending → send_failed → manual_required / draft_failed
//
// Response shape:
//   200 { drafts: TriageDraftItem[] }
//   401 / 403 / 500 on error

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { extractReplyBody } from '@/lib/reply-handling/extract-reply-body'

export const dynamic = 'force-dynamic'

// Status priority for sort: lower number = shown first.
const STATUS_PRIORITY: Record<string, number> = {
  pending: 0,
  send_failed: 1,
  manual_required: 2,
  draft_failed: 2,
}

const TRIAGE_STATUSES = ['pending', 'manual_required', 'draft_failed', 'send_failed'] as const


export async function GET() {
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
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── 1. Authenticated ──────────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
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
    logger.warn('reply-drafts list: non-operator attempted access', { user_id: user.id, role: userRow.role })
    return NextResponse.json({ error: 'Only operators can access the reply queue.' }, { status: 403 })
  }

  // ── 3. Fetch triage-queue drafts with signal + prospect joins ─────────────────
  // ADR-021: operator endpoints are cross-org — no organisation_id filter here.
  const { data: rows, error: queryError } = await supabase
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
    .in('status', [...TRIAGE_STATUSES])

  if (queryError) {
    logger.error('reply-drafts list: query failed', { error: queryError.message })
    return NextResponse.json({ error: 'Failed to load reply queue.' }, { status: 500 })
  }

  // ── 4. Transform + sort ───────────────────────────────────────────────────────
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

  const transformed = (rows ?? []).map(row => {
    const signal = row.signals as unknown as SignalRow | null
    const org = (row as unknown as { organisations: OrgRow | null }).organisations
    const signalProspect = signal?.prospects ?? null
    const metadata = (row.draft_metadata ?? {}) as Record<string, unknown>

    return {
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
      faqs: [] as FaqItem[],   // populated below for Tier 2 rows
    }
  })

  // Sort by status priority, then created_at DESC within each group.
  transformed.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99
    const pb = STATUS_PRIORITY[b.status] ?? 99
    if (pa !== pb) return pa - pb
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  // ── 5. Enrich Tier 2 drafts with FAQ text ─────────────────────────────────────
  // Collect all FAQ IDs referenced across Tier 2 drafts.
  type FaqItem = { id: string; question_canonical: string; answer: string; times_used: number }

  const allFaqIds = new Set<string>()
  for (const draft of transformed) {
    if (draft.tier === 2) {
      const ids = (draft.draft_metadata.faq_ids_used ?? []) as string[]
      ids.forEach(id => allFaqIds.add(id))
    }
  }

  let faqMap: Record<string, FaqItem> = {}

  if (allFaqIds.size > 0) {
    const { data: faqRows, error: faqError } = await supabase
      .from('faqs')
      .select('id, question_canonical, answer, times_used')
      .in('id', [...allFaqIds])

    if (faqError) {
      // Non-fatal: FAQ data is informational. Log and continue.
      logger.warn('reply-drafts list: FAQ fetch failed', { error: faqError.message })
    } else {
      faqMap = Object.fromEntries((faqRows ?? []).map(r => [r.id, r as FaqItem]))
    }
  }

  // Attach resolved FAQ rows to each Tier 2 draft.
  for (const draft of transformed) {
    if (draft.tier === 2) {
      const ids = (draft.draft_metadata.faq_ids_used ?? []) as string[]
      draft.faqs = ids.map(id => faqMap[id]).filter((f): f is FaqItem => !!f)
    }
  }

  return NextResponse.json({ drafts: transformed }, { status: 200 })
}

