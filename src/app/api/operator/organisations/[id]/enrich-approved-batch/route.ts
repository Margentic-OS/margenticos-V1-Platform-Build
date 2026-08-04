// POST /api/operator/organisations/[id]/enrich-approved-batch
// Operator-only endpoint to trigger enrichment of approved prospects.
// - Operator authentication: required
// - Reads only approved+unenriched prospects
// - Calls enrichApprovedBatch trigger function
// - Returns enrichment run result with credits consumed, outcome counts

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { enrichApprovedBatch } from '@/lib/sourcing/enrichment-trigger'
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

    // Verify organisation exists and is not archived
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('id')
      .eq('id', organisationId)
      .is('archived_at', null)
      .single()

    if (orgError || !org) {
      return NextResponse.json({ error: 'Organisation not found or archived' }, { status: 404 })
    }

    logger.info('enrich-approved-batch: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
    })

    // Trigger enrichment
    const result = await enrichApprovedBatch(supabase, organisationId, 100)

    logger.info('enrich-approved-batch: triggered successfully', {
      operator_id: user.id,
      organisation_id: organisationId,
      status: result.status,
      credits_consumed: result.credits_consumed,
      enriched: result.unique_enriched_records,
    })

    return NextResponse.json({
      ok: true,
      result: {
        status: result.status,
        batch_size: result.batch_size,
        total_requested: result.total_requested_enrichments,
        enriched: result.unique_enriched_records,
        missing: result.missing_records,
        credits_consumed: result.credits_consumed,
        error: result.error_message || null,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('enrich-approved-batch: failed', {
      organisation_id: organisationId,
      error: errorMsg,
    })

    return NextResponse.json(
      { error: `Enrichment failed: ${errorMsg}` },
      { status: 500 }
    )
  }
}
