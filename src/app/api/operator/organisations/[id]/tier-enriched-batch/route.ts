// POST /api/operator/organisations/[id]/tier-enriched-batch
// Operator-only endpoint to classify enriched prospects into Tier 1/2/3.
// - Operator authentication: required
// - Reads only enriched+untiered prospects
// - Calls tierEnrichedBatch trigger function
// - Returns tiering run result with tier breakdown

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger'
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
  _request: NextRequest,
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

    logger.info('tier-enriched-batch: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
    })

    // Trigger tiering
    const result = await tierEnrichedBatch(supabase, organisationId, 100)

    if (result.error) {
      logger.error('tier-enriched-batch: triggered with error', {
        operator_id: user.id,
        organisation_id: organisationId,
        error: result.error,
      })

      return NextResponse.json({
        ok: false,
        result,
      }, { status: 500 })
    }

    logger.info('tier-enriched-batch: triggered successfully', {
      operator_id: user.id,
      organisation_id: organisationId,
      prospects_classified: result.prospects_classified,
      tier_1: result.tier_1_count,
      tier_2: result.tier_2_count,
      tier_3: result.tier_3_count,
      untiered: result.untiered_count,
    })

    return NextResponse.json({
      ok: true,
      result: {
        prospects_classified: result.prospects_classified,
        tier_1_count: result.tier_1_count,
        tier_2_count: result.tier_2_count,
        tier_3_count: result.tier_3_count,
        untiered_count: result.untiered_count,
        timestamp: result.timestamp,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('tier-enriched-batch: failed', {
      organisation_id: organisationId,
      error: errorMsg,
    })

    return NextResponse.json(
      { error: `Tiering failed: ${errorMsg}` },
      { status: 500 }
    )
  }
}
