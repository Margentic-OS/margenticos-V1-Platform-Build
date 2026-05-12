// GET /api/operator/faqs?client=<orgId>
// POST /api/operator/faqs
//
// Operator-only. ADR-021: operator endpoints are cross-org.
// GET returns all FAQs (approved + archived) for the specified client org.
// POST creates a new FAQ manually for the specified org.
//
// Auth pattern (both methods):
//   1. User is authenticated
//   2. User role is 'operator'
//   (No org_id filter on auth — operator acts across all orgs.)

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

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await buildSupabase()
  const { authorized } = await requireOperator(supabase)
  if (!authorized) {
    const { data: { user } } = await supabase.auth.getUser()
    return NextResponse.json({ error: user ? 'Operator access required.' : 'Not authenticated.' }, { status: user ? 403 : 401 })
  }

  const orgId = request.nextUrl.searchParams.get('client')
  if (!orgId || !UUID_RE.test(orgId)) {
    return NextResponse.json({ error: 'client parameter is required and must be a valid org ID.' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('faqs')
    .select('id, question_canonical, question_variants, answer, status, times_used, last_used_at, created_at, updated_at')
    .eq('organisation_id', orgId)
    .order('status', { ascending: true })           // approved before archived
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('GET /api/operator/faqs: query failed', { org_id: orgId, error: error.message })
    return NextResponse.json({ error: 'Failed to load FAQ knowledge base.' }, { status: 500 })
  }

  const faqs = (data ?? []).map(row => ({
    id: row.id,
    question_canonical: row.question_canonical,
    question_variants: Array.isArray(row.question_variants) ? row.question_variants as string[] : [],
    answer: row.answer,
    status: row.status as 'approved' | 'archived',
    times_used: row.times_used,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))

  return NextResponse.json({ faqs }, { status: 200 })
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await buildSupabase()
  const { user, authorized } = await requireOperator(supabase)
  if (!authorized) {
    return NextResponse.json({ error: user ? 'Operator access required.' : 'Not authenticated.' }, { status: user ? 403 : 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { organisation_id, question_canonical, answer } = body
  if (!organisation_id || typeof organisation_id !== 'string' || !UUID_RE.test(organisation_id)) {
    return NextResponse.json({ error: 'organisation_id is required and must be a valid UUID.' }, { status: 400 })
  }
  if (!question_canonical || typeof question_canonical !== 'string' || !question_canonical.trim()) {
    return NextResponse.json({ error: 'question_canonical is required.' }, { status: 400 })
  }
  if (!answer || typeof answer !== 'string' || !answer.trim()) {
    return NextResponse.json({ error: 'answer is required.' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('faqs')
    .insert({
      organisation_id,
      question_canonical: question_canonical.trim(),
      answer: answer.trim(),
      status: 'approved',
      created_by_user_id: user!.id,
    })
    .select('id, question_canonical, answer, created_at')
    .single()

  if (error) {
    logger.error('POST /api/operator/faqs: insert failed', { org_id: organisation_id, error: error.message })
    return NextResponse.json({ error: 'Failed to create FAQ.' }, { status: 500 })
  }

  return NextResponse.json({ faq: data }, { status: 201 })
}
