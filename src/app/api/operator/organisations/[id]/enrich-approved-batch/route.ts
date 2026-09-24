// POST /api/operator/organisations/[id]/enrich-approved-batch
// Operator-only endpoint to trigger enrichment of approved prospects.
// - Operator authentication: required
// - Reads only approved+unenriched prospects
// - Returns enrichment run result with credits consumed, outcome counts
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO PATHS, CHOSEN BY AN EXPLICIT DATABASE FLAG
//
//   system_flags.queue_enrich = false  INLINE. Runs inside this request, making as many
//                                      100-prospect passes as the time budget allows, up to
//                                      ENRICHMENT_MAX_PER_REQUEST. What has always happened,
//                                      except that it used to stop after ONE pass and leave the
//                                      rest with nothing queued. Measured live 2026-09-23:
//                                      queue_enrich is false, so this is the live path.
//   system_flags.queue_enrich = true   QUEUED. This request only ENQUEUES and returns
//                                      immediately; the pg_cron worker does the work.
//
// The flag is read from the database and never inferred from NODE_ENV, VERCEL_URL, or
// the presence of a key. Rolling back is one UPDATE with no deploy, and isQueueEnabled
// fails closed to the inline path on any read error.
//
// THE RESPONSE SHAPES DIFFER, AND THE CALLER MUST NOT GUESS. The inline path can report
// credits_consumed because the work is finished when it answers. The queued path cannot:
// nothing has run yet. It returns queued:true and a count, and the UI reads that field
// rather than inferring from a zero credit count, which would be indistinguishable from
// an enrichment that found nothing.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { ENRICHMENT_PER_PRESS_LIMIT } from '@/lib/sourcing/enrichment-trigger'
import {
  enrichApprovedUntilDoneOrOutOfTime,
  ENRICHMENT_MAX_PER_REQUEST,
} from '@/lib/sourcing/enrichment-continuation'
import { isQueueEnabled } from '@/lib/queue/flags'
import { enqueueEnrichForOrganisation } from '@/lib/queue/enqueue/enrich'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'

export const dynamic = 'force-dynamic'
// Matches every other long-running route in this repo, and is the Hobby ceiling.
// This route had no declaration at all, so the INLINE path above ran under the platform
// default while twelve shorter routes asked for 300. Enrichment spends a credit per prospect
// through the can_enrich_contact handler, so a timeout mid-batch is money spent on work the
// caller never hears the result of. The QUEUED path returns immediately and does not need
// this; the inline path does.
export const maxDuration = 300

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

    const queued = await isQueueEnabled(supabase, 'enrich')

    logger.info('enrich-approved-batch: operator triggered', {
      operator_id: user.id,
      organisation_id: organisationId,
      path: queued ? 'queue' : 'inline',
    })

    // ── QUEUED PATH ─────────────────────────────────────────────────────────
    if (queued) {
      const enqueued = await enqueueEnrichForOrganisation(
        supabase,
        organisationId,
        `operator:${user.id}`,
      )

      if (!enqueued.ok) {
        return NextResponse.json({ error: enqueued.error }, { status: 500 })
      }

      logger.info('enrich-approved-batch: enqueued', {
        operator_id: user.id,
        organisation_id: organisationId,
        selected: enqueued.selected,
        created: enqueued.created,
        already_queued: enqueued.alreadyQueued,
      })

      return NextResponse.json({
        ok: true,
        queued: true,
        // Present only when the buyer gate did NOT run. The operator who clicked the
        // button reads this; a warning that only reaches a log stream is not a warning.
        buyer_gate_warning: enqueued.buyerGateWarning,
        result: {
          selected: enqueued.selected,
          queued: enqueued.created,
          already_queued: enqueued.alreadyQueued,
          rejected_before_spend: enqueued.rejectedBeforeSpend,
          // Named rather than left to inference: nothing has been enriched at this point
          // and no credit has been spent, so any number here would be a lie.
          message:
            enqueued.created > 0
              ? `${enqueued.created} prospect(s) queued for enrichment. The background worker picks them up within a minute.`
              : enqueued.alreadyQueued > 0
                ? `Nothing new to queue: all ${enqueued.alreadyQueued} eligible prospect(s) are already in the queue.`
                : 'Nothing to enrich. No approved prospects are awaiting enrichment.',
        },
      })
    }

    // ── INLINE PATH: KEEPS GOING UNTIL THE BACKLOG IS CLEAR ─────────────────
    //
    // This used to run enrichApprovedBatch ONCE, for at most ENRICHMENT_PER_PRESS_LIMIT (100),
    // and leave the rest untouched with nothing queued. An operator with 500 approved prospects
    // pressed five times.
    //
    // It now makes as many passes as fit the request's time budget, up to
    // ENRICHMENT_MAX_PER_REQUEST. The PER-PASS limit is unchanged, so each call to the trigger
    // does exactly what it always did; what changed is how many of them one press makes.
    //
    // THE SPEND. Enrichment costs one Apollo credit per prospect, so one press can now spend up
    // to ENRICHMENT_MAX_PER_REQUEST credits rather than 100. It is the same money the operator
    // was going to spend across five presses, on a backlog the screen already names, and no
    // prospect is enriched that pressing again would not have enriched. See
    // enrichment-continuation.ts for the full reasoning and the measured timings.
    const result = await enrichApprovedUntilDoneOrOutOfTime(supabase, organisationId)

    logger.info('enrich-approved-batch: triggered successfully', {
      operator_id: user.id,
      organisation_id: organisationId,
      presses: result.presses,
      credits_consumed: result.credits_consumed,
      enriched: result.enriched,
      remaining: result.remaining,
      stop_reason: result.stop_reason,
    })

    return NextResponse.json({
      ok: true,
      queued: false,
      result: {
        // 'failed' or 'success', which are EnrichmentRun's own words. Not a new 'error' value:
        // the single-pass response returned result.status from that union, so inventing a third
        // string here would change the contract any caller reading it already has.
        status: result.error ? 'failed' : 'success',
        batch_size: result.batch_size,
        total_requested: result.total_requested,
        enriched: result.enriched,
        missing: result.missing,
        credits_consumed: result.credits_consumed,
        error: result.error,
        // ── SAID PLAINLY, EVEN THOUGH IT USUALLY FINISHES ────────────────────
        //
        // Auto-continuing removes most presses, not all of them: a slow provider day or a
        // backlog above the ceiling still leaves work. `remaining` is read back with the
        // selection's own predicate rather than subtracted from a count, and is -1 when that
        // read failed, so a screen never renders "0 waiting" off an error.
        presses: result.presses,
        remaining: result.remaining,
        stop_reason: result.stop_reason,
        stop_message: result.stop_message,
        more_remain: result.remaining > 0,
        per_pass_limit: ENRICHMENT_PER_PRESS_LIMIT,
        max_per_request: ENRICHMENT_MAX_PER_REQUEST,
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
