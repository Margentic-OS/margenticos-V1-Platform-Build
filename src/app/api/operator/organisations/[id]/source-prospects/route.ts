// POST /api/operator/organisations/[id]/source-prospects
// Operator-only endpoint to source prospects for one organisation.
//
// Request body: { target_batch_size: number }
// Effect: runs the sourcing orchestrator, writing survivors as pending_review prospects.
//
// Auth, client construction and failure reporting follow the send path exactly. See
// /api/operator/organisations/[id]/enrich-approved-batch, which is the same shape.
//
// Long work: the batch runs inside this request. There is no queue. runSourcingForOrg
// refuses a batch size that would not finish inside the budget, with an explicit error.

import { NextRequest, NextResponse } from 'next/server'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { runSourcingForOrg, SOURCING_MAX_BATCH_SIZE } from '@/lib/operator/sourcing-entry'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'

export const dynamic = 'force-dynamic'
// Matches every other long-running route in this repo, and is the Hobby ceiling.
export const maxDuration = 300

interface SourceProspectsRequest {
  target_batch_size?: number
}

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
    const supabase = asServiceRoleClient(createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    ))

    const { user, authorized } = await requireOperator(sessionClient, supabase)
    if (!authorized || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // An absent body is a client bug, not a reason to guess a batch size that spends
    // Apollo credits. Nothing is defaulted.
    let body: SourceProspectsRequest
    try {
      body = (await request.json()) as SourceProspectsRequest
    } catch {
      return NextResponse.json(
        { error: 'Request body must be JSON containing target_batch_size.' },
        { status: 400 }
      )
    }

    const targetBatchSize = body.target_batch_size
    if (typeof targetBatchSize !== 'number' || !Number.isInteger(targetBatchSize) || targetBatchSize < 1) {
      return NextResponse.json(
        { error: `target_batch_size must be a whole number of 1 or more (max ${SOURCING_MAX_BATCH_SIZE}).` },
        { status: 400 }
      )
    }

    logger.info('source-prospects: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
      target_batch_size: targetBatchSize,
    })

    const result = await runSourcingForOrg({
      supabase,
      organisation_id: organisationId,
      target_batch_size: targetBatchSize,
      trigger_type: 'operator_manual',
      created_by: user.id,
    })

    if (!result.ok) {
      // A refusal is the entry point working, not a server fault. 400 so the panel shows
      // the reason rather than a generic failure.
      logger.warn('source-prospects: refused or failed', {
        operator_id: user.id,
        organisation_id: organisationId,
        error: result.error,
      })
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    logger.info('source-prospects: completed', {
      operator_id: user.id,
      organisation_id: organisationId,
      candidates_sourced: result.candidates_sourced,
      candidates_qualified: result.candidates_qualified,
    })

    return NextResponse.json({
      ok: true,
      result: {
        candidates_sourced: result.candidates_sourced,
        candidates_qualified: result.candidates_qualified,
        run_timestamp: result.run_timestamp,
        estimated_seconds: result.estimated_seconds,
        sourcing_run_id: result.sourcing_run_id,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('source-prospects: failed', {
      organisation_id: organisationId,
      error: errorMsg,
    })

    Sentry.captureException(err, { extra: { endpoint: '/source-prospects', organisationId } })

    return NextResponse.json({ error: `Sourcing failed: ${errorMsg}` }, { status: 500 })
  }
}
