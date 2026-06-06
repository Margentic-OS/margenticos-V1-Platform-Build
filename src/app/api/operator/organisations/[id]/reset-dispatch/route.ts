// POST /api/operator/organisations/[id]/reset-dispatch
//
// Operator-only. Clears agents_dispatched_at for a given organisation, allowing
// /api/intake/complete to re-dispatch the document generation agents on the next
// eligible intake submission. Use when an org's agents need to be re-triggered
// without going through the intake form again.
//
// Auth:
//   1. User is authenticated (session cookie)
//   2. User role is 'operator'
//   Operators act cross-org (ADR-021) — any org_id is valid.
//
// Body: none (org_id comes from URL param)
// Returns: { reset: true }

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'

export const dynamic = 'force-dynamic'

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

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid organisation ID.' }, { status: 400 })
  }

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

  const { data: org } = await supabase
    .from('organisations')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (!org) {
    return NextResponse.json({ error: 'Organisation not found.' }, { status: 404 })
  }

  const { error: updateError } = await supabase
    .from('organisations')
    .update({ agents_dispatched_at: null })
    .eq('id', id)

  if (updateError) {
    logger.error('POST /api/operator/organisations/[id]/reset-dispatch: update failed', {
      org_id: id,
      error: updateError.message,
    })
    return NextResponse.json({ error: 'Failed to reset dispatch.' }, { status: 500 })
  }

  logger.info('POST /api/operator/organisations/[id]/reset-dispatch: dispatch reset', {
    org_id: id,
    operator_user_id: user!.id,
  })

  return NextResponse.json({ reset: true })
}
