// POST /api/documents/revert
//
// Operator-only. Makes an earlier version of a strategy document live again, as a NEW
// version. The old row is not resurrected: revert_strategy_doc_version copies its
// content forward through promote_strategy_doc_version, so the history keeps growing in
// one direction and nothing is destroyed to recover something.
//
// WHY OPERATOR-ONLY. Reverting changes the copy every future email is composed from.
// A client's route to change a document is Request an update, which is preserved and
// which produces a new version with a note attached. Revert is the operator's tool for
// undoing their own last few regenerations, which is the case it was built for.
//
// Auth, in order:
//   1. User is authenticated
//   2. User role is 'operator'
//   3. The document exists, and is NOT the live version
//
// The service client performs the RPC because revert_strategy_doc_version is granted to
// service_role only. The gate above this line is the whole authorisation story, which is
// why it runs before anything is written.
//
// Body: { document_id: string }
// Returns: { id, version }

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'
import { persistIcpFilterSpec } from '@/lib/sourcing/persist-icp-filter-spec'
import { triggerCascadeIfEligible } from '@/lib/agents/cascade/trigger-cascade'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  let body: { document_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { document_id } = body
  if (!document_id || typeof document_id !== 'string' || !UUID_RE.test(document_id)) {
    return NextResponse.json({ error: 'document_id must be a valid UUID.' }, { status: 400 })
  }

  const { data: source } = await supabase
    .from('strategy_documents')
    .select('id, status, organisation_id, document_type, version')
    .eq('id', document_id)
    .maybeSingle()

  if (!source) {
    return NextResponse.json({ error: 'Version not found.' }, { status: 404 })
  }

  if (source.status === 'active') {
    return NextResponse.json(
      { error: 'That version is already the live one.' },
      { status: 409 },
    )
  }

  const { data: newDoc, error: rpcError } = await supabase.rpc('revert_strategy_doc_version', {
    p_document_id: document_id,
  })

  if (rpcError) {
    logger.error('POST /api/documents/revert: revert_strategy_doc_version failed', {
      document_id,
      org_id: source.organisation_id,
      error: rpcError.message,
    })
    return NextResponse.json({ error: 'Could not restore that version.' }, { status: 500 })
  }

  const result = newDoc as unknown as { id: string; version: string }

  logger.info('POST /api/documents/revert: version restored', {
    restored_from_document_id: document_id,
    restored_from_version: source.version,
    new_document_id: result?.id,
    new_version: result?.version,
    org_id: source.organisation_id,
    document_type: source.document_type,
    operator_user_id: user!.id,
  })

  // An ICP going live without its filter spec breaks sourcing, and promote does not copy
  // the spec forward. Derived here for the same reason the approve path derives it: the
  // spec is a function of the content, and the content is what just changed.
  if (result?.id) {
    await persistIcpFilterSpec(supabase, result.id)
  }

  // Every promotion path calls this one function. Filling a downstream gap is all it
  // does, so on an established client it is a no-op, but keeping the invariant intact
  // matters more than saving the call.
  await triggerCascadeIfEligible(supabase, source.organisation_id, source.document_type)

  return NextResponse.json({ id: result?.id ?? null, version: result?.version ?? null })
}
