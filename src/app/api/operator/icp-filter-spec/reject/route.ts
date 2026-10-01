// POST /api/operator/icp-filter-spec/reject
//
// Operator-only. Throws away a client's PROPOSED search settings. ADR-061 rule 5.
//
// The live settings, the client's place in the search and every prospect are untouched.
// See rejectIcpFilterSpecProposal for what a rejection does not do: the ICP and the search
// still disagree afterwards, and the next comparison files a proposal again.
//
// Auth, in order:
//   1. User is authenticated
//   2. User role is 'operator', read on THIS request and not remembered from login
//   3. The document named is an active ICP whose pending proposal is still the one the
//      operator was shown
//
// Body: { document_id: string, fingerprint: string }
// Returns 200: { rejected: true }
// Refused:     { error, refused } with the status for that refusal

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { requireOperator } from '@/lib/supabase/require-operator'
import {
  rejectIcpFilterSpecProposal,
  REFUSAL_MESSAGES,
  REFUSAL_STATUS,
} from '@/lib/sourcing/approve-icp-filter-spec'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FINGERPRINT_RE = /^[0-9a-f]{64}$/

async function buildSessionClient() {
  const cookieStore = await cookies()
  return createServerClient(
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
}

export async function POST(request: NextRequest) {
  const sessionClient = await buildSessionClient()
  const supabase = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { user, authorized } = await requireOperator(sessionClient, supabase)

  if (!authorized) {
    return NextResponse.json(
      { error: user ? 'Operator access required.' : 'Not authenticated.' },
      { status: user ? 403 : 401 },
    )
  }

  let body: { document_id?: unknown; fingerprint?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { document_id, fingerprint } = body
  if (typeof document_id !== 'string' || !UUID_RE.test(document_id)) {
    return NextResponse.json({ error: 'document_id must be a valid UUID.' }, { status: 400 })
  }
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
    return NextResponse.json(
      { error: 'fingerprint must name the proposal that was shown.' },
      { status: 400 },
    )
  }

  const outcome = await rejectIcpFilterSpecProposal(supabase, {
    documentId: document_id,
    fingerprint,
    rejectedBy: user!.id,
  })

  if (outcome.outcome === 'refused') {
    return NextResponse.json(
      { error: REFUSAL_MESSAGES[outcome.refused], refused: outcome.refused },
      { status: REFUSAL_STATUS[outcome.refused] },
    )
  }
  if (outcome.outcome === 'failed') {
    return NextResponse.json(
      { error: 'The proposal could not be rejected. Nothing was changed.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ rejected: true })
}
