// POST /api/operator/icp-filter-spec/approve
//
// Operator-only. Makes a client's PROPOSED search settings the live ones. ADR-061 rule 5.
//
// This is the only route that changes who a client's search finds. Everything it decides is
// decided in approveIcpFilterSpecProposal, which the before-and-after panel shares, so this
// file is the gate and nothing else.
//
// Auth, in order:
//   1. User is authenticated
//   2. User role is 'operator', read on THIS request and not remembered from login
//   3. The document named is an active ICP with a proposal waiting, and it is still the
//      proposal the operator was shown (checked by fingerprint here, and again by the
//      database function against the row it locks)
//
// The service client makes the write because approve_icp_filter_spec_proposal is granted to
// service_role only. The gate above it is the whole authorisation story.
//
// Body: {
//   document_id: string            the active ICP version
//   fingerprint: string            what the operator's page was rendered with
//   confirmed_removals?: string[]  one key per removed exclusion that was ticked
// }
// Returns 200: { approved: true, cursor_reset, previous_offset, requeued_count }
// Refused:     { error, refused, unconfirmed? } with the status for that refusal

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { requireOperator } from '@/lib/supabase/require-operator'
import {
  approveIcpFilterSpecProposal,
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

  let body: { document_id?: unknown; fingerprint?: unknown; confirmed_removals?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { document_id, fingerprint, confirmed_removals } = body
  if (typeof document_id !== 'string' || !UUID_RE.test(document_id)) {
    return NextResponse.json({ error: 'document_id must be a valid UUID.' }, { status: 400 })
  }
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
    return NextResponse.json(
      { error: 'fingerprint must name the proposal that was shown.' },
      { status: 400 },
    )
  }
  // Absent means nothing was ticked. Present and malformed is refused outright: a tick
  // that cannot be read must not be guessed at in either direction.
  if (
    confirmed_removals !== undefined &&
    !(Array.isArray(confirmed_removals) && confirmed_removals.every(item => typeof item === 'string'))
  ) {
    return NextResponse.json(
      { error: 'confirmed_removals must be a list of strings.' },
      { status: 400 },
    )
  }

  const outcome = await approveIcpFilterSpecProposal(supabase, {
    documentId: document_id,
    fingerprint,
    confirmedRemovals: (confirmed_removals as string[] | undefined) ?? [],
    approvedBy: user!.id,
  })

  if (outcome.outcome === 'refused') {
    return NextResponse.json(
      {
        error: REFUSAL_MESSAGES[outcome.refused],
        refused: outcome.refused,
        ...(outcome.unconfirmed ? { unconfirmed: outcome.unconfirmed } : {}),
      },
      { status: REFUSAL_STATUS[outcome.refused] },
    )
  }
  if (outcome.outcome === 'failed') {
    return NextResponse.json(
      { error: 'The change could not be approved. Nothing was changed.' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    approved: true,
    cursor_reset: outcome.cursor_reset,
    previous_offset: outcome.previous_offset,
    requeued_count: outcome.requeued_count,
  })
}
