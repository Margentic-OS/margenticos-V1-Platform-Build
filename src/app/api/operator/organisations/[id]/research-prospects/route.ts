// POST /api/operator/organisations/[id]/research-prospects
// Operator-only endpoint to run prospect research for one organisation.
//
// Request body: { scope: 'unresearched' | 'researched', use_stored_findings?: boolean }
// Effect: runs the research batch, writing prospect_research_results rows and updating
//         each prospect's classification and personalisation copy.
//
// Auth, client construction and failure reporting follow the send path exactly. See
// /api/operator/organisations/[id]/enrich-approved-batch, which is the same shape.
//
// TWO THINGS THIS ROUTE DELIBERATELY CANNOT DO:
//
//  1. It cannot pass allow_overwrite_trigger. Researching a prospect that already has a
//     personalisation trigger replaces that copy with new wording, or clears it entirely
//     when the judge holds. That has to be asked for explicitly, and no dashboard control
//     asks for it. The flag is not read from the body, so no request can set it.
//
//  2. It cannot set use_stored_findings without saying so. It defaults to true, the value
//     that reuses findings already on file instead of paying to fetch all four sources
//     again.
//
// Long work: the batch runs inside this request. There is no queue. runResearchBatchForOrg
// refuses a batch that would not finish inside the budget, with an explicit error.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { runResearchBatchForOrg, type ResearchScope } from '@/lib/operator/research-batch-entry'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'

export const dynamic = 'force-dynamic'
// Matches every other long-running route in this repo, and is the Hobby ceiling.
export const maxDuration = 300

const VALID_SCOPES: ResearchScope[] = ['unresearched', 'researched']

interface ResearchProspectsRequest {
  scope?: string
  use_stored_findings?: boolean
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
    const supabase = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { user, authorized } = await requireOperator(sessionClient, supabase)
    if (!authorized || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    let body: ResearchProspectsRequest
    try {
      body = (await request.json()) as ResearchProspectsRequest
    } catch {
      return NextResponse.json(
        { error: 'Request body must be JSON containing scope.' },
        { status: 400 }
      )
    }

    const scope = body.scope
    if (typeof scope !== 'string' || !VALID_SCOPES.includes(scope as ResearchScope)) {
      return NextResponse.json(
        { error: `scope must be one of: ${VALID_SCOPES.join(', ')}.` },
        { status: 400 }
      )
    }

    // Only an explicit false turns reuse off. An absent or malformed value keeps the safe
    // value, so a client that forgets the field cannot accidentally trigger a paid re-fetch
    // of every source.
    const useStoredFindings = body.use_stored_findings === false ? false : true

    logger.info('research-prospects: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
      scope,
      use_stored_findings: useStoredFindings,
    })

    const result = await runResearchBatchForOrg({
      supabase,
      organisation_id: organisationId,
      scope: scope as ResearchScope,
      use_stored_findings: useStoredFindings,
      // Deliberately not read from the body. See the header comment.
      allow_overwrite_trigger: false,
    })

    if (!result.ok) {
      // A refusal is the entry point working, not a server fault. 400 so the panel shows
      // the reason rather than a generic failure.
      logger.warn('research-prospects: refused or failed', {
        operator_id: user.id,
        organisation_id: organisationId,
        error: result.error,
      })
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    const { summary } = result

    logger.info('research-prospects: completed', {
      operator_id: user.id,
      organisation_id: organisationId,
      completed: summary.completed,
      failed: summary.failed,
      skipped: summary.skipped,
    })

    return NextResponse.json({
      ok: true,
      result: {
        prospects_selected: result.prospects_selected,
        use_stored_findings: result.use_stored_findings,
        estimated_seconds: result.estimated_seconds,
        total: summary.total,
        completed: summary.completed,
        failed: summary.failed,
        skipped: summary.skipped,
        failures: summary.failures,
        distinct_questions: summary.distinct_questions,
        // Non-empty means the batch-scoped uniqueness gate let a collision through, which
        // is a defect in the gate rather than a warning about the copy. Surfaced so it is
        // visible without reading the logs.
        bridge_frame_collisions: summary.bridge_frame_collisions.length,
        question_collisions: summary.question_collisions.length,
        // Report only. A non-zero total is worth reading and is never a failure.
        abstract_noun_total: summary.abstract_noun_total,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('research-prospects: failed', {
      organisation_id: organisationId,
      error: errorMsg,
    })

    Sentry.captureException(err, { extra: { endpoint: '/research-prospects', organisationId } })

    return NextResponse.json({ error: `Research failed: ${errorMsg}` }, { status: 500 })
  }
}
