// POST /api/operator/organisations/[id]/enrich-approved-batch
// Operator-only endpoint to trigger enrichment of approved prospects.
// - Operator authentication: required
// - Reads only approved+unenriched prospects
// - Returns enrichment run result with credits consumed, outcome counts
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO PATHS, CHOSEN BY AN EXPLICIT DATABASE FLAG
//
//   system_flags.queue_enrich = false  INLINE. enrichApprovedBatch runs the whole batch
//                                      inside this request. What has always happened.
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
import { enrichApprovedBatch } from '@/lib/sourcing/enrichment-trigger'
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

    // ── INLINE PATH ─────────────────────────────────────────────────────────
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
      queued: false,
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
