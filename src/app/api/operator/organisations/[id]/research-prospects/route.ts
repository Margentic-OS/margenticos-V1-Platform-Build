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
// ═════════════════════════════════════════════════════════════════════════════
// TWO PATHS, CHOSEN BY AN EXPLICIT DATABASE FLAG
//
//   system_flags.queue_research = false  INLINE. The batch runs inside this request, and
//                                        runResearchBatchForOrg refuses anything that
//                                        would not finish inside the 240s budget. At
//                                        46.8s per fetching prospect that is about FIVE.
//   system_flags.queue_research = true   QUEUED. This request only ENQUEUES and returns
//                                        immediately. The pg_cron worker does the work,
//                                        ten prospects in flight at a time, with no
//                                        per-request ceiling at all.
//
// The queued path is the whole reason the queue exists: the five-per-click limit is what
// made onboarding a client with hundreds of unresearched prospects impractical.
//
// use_stored_findings is honoured on the INLINE path only. job_queue carries no payload,
// so a queued job always runs with the safe default of TRUE. A request that asks for
// false while the queue is on is REFUSED rather than silently downgraded: quietly
// ignoring an explicit instruction to re-fetch every source would be worse than saying
// no, because the caller would believe fresh research had been ordered.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { runResearchBatchForOrg, type ResearchScope } from '@/lib/operator/research-batch-entry'
import { isQueueEnabled } from '@/lib/queue/flags'
import { enqueueResearchForOrganisation } from '@/lib/queue/enqueue/research'
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

    const queued = await isQueueEnabled(supabase, 'research')

    logger.info('research-prospects: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
      scope,
      use_stored_findings: useStoredFindings,
      path: queued ? 'queue' : 'inline',
    })

    // ── QUEUED PATH ─────────────────────────────────────────────────────────
    if (queued) {
      // Refused, not silently downgraded. See the header.
      if (!useStoredFindings) {
        return NextResponse.json({
          error:
            'Refused: use_stored_findings=false cannot be honoured while research runs through ' +
            'the queue, because a queued job carries no per-job options and always uses the safe ' +
            'default. Re-fetching every source is a paid operation and must not happen by ' +
            'accident. Run it from the CLI, which stays on the inline path.',
        }, { status: 400 })
      }

      const enqueued = await enqueueResearchForOrganisation(
        supabase,
        organisationId,
        scope as ResearchScope,
        `operator:${user.id}`,
      )

      if (!enqueued.ok) {
        // A refusal is the guard working, not a server fault.
        logger.warn('research-prospects: enqueue refused', {
          operator_id: user.id,
          organisation_id: organisationId,
          error: enqueued.error,
        })
        return NextResponse.json({ error: enqueued.error }, { status: 400 })
      }

      logger.info('research-prospects: enqueued', {
        operator_id: user.id,
        organisation_id: organisationId,
        scope,
        selected: enqueued.selected,
        created: enqueued.created,
        already_queued: enqueued.alreadyQueued,
      })

      return NextResponse.json({
        ok: true,
        queued: true,
        result: {
          scope: enqueued.scope,
          selected: enqueued.selected,
          queued: enqueued.created,
          already_queued: enqueued.alreadyQueued,
          message:
            enqueued.created > 0
              ? `${enqueued.created} prospect(s) queued for research. The background worker runs ` +
                'up to ten at a time and takes roughly a minute per prospect.'
              : `Nothing new to queue: all ${enqueued.alreadyQueued} eligible prospect(s) are already in the queue.`,
        },
      })
    }

    // ── INLINE PATH ─────────────────────────────────────────────────────────
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
      // Named explicitly so the caller reads a field rather than inferring the path from
      // which keys happen to be present.
      queued: false,
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
