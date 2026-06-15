// POST /api/operator/organisations/[id]/approve-prospects
// Operator-only endpoint to approve pending_review prospects.
// - Operator authentication: required
// - Moves sourcing_review_status from pending_review to approved
// - Sets qualified_at timestamp
// - Returns count of approved prospects

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { approveProspects } from '@/lib/sourcing/approval'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'

export const dynamic = 'force-dynamic'

async function buildSessionClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
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
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: organisationId } = await params

  try {
    const sessionClient = await buildSessionClient()
    const supabase = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { user, authorized } = await requireOperator(sessionClient, supabase)
    if (!authorized || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Verify organisation exists
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('id')
      .eq('id', organisationId)
      .single()

    if (orgError || !org) {
      return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })
    }

    // Parse request body
    const body = await request.json()
    const prospectIds = body.prospect_ids || []

    if (!Array.isArray(prospectIds)) {
      return NextResponse.json(
        { error: 'prospect_ids must be an array' },
        { status: 400 }
      )
    }

    logger.info('approve-prospects: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
      prospect_count: prospectIds.length,
    })

    // Approve prospects
    const result = await approveProspects(supabase, organisationId, prospectIds)

    logger.info('approve-prospects: triggered successfully', {
      operator_id: user.id,
      organisation_id: organisationId,
      approved_count: result.approved_count,
    })

    return NextResponse.json({
      ok: true,
      result: {
        approved_count: result.approved_count,
        timestamp: result.timestamp,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('approve-prospects: failed', {
      organisation_id: organisationId,
      error: errorMsg,
    })

    return NextResponse.json(
      { error: `Approval failed: ${errorMsg}` },
      { status: 500 }
    )
  }
}
