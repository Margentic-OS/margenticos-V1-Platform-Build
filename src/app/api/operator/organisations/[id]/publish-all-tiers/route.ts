// POST /api/operator/organisations/[id]/publish-all-tiers
// Operator publishes all tiered prospects for client review in a single action
//
// Effect:
//   1. Sets tier_published_at = now() for all unpublished prospects across all tiers
//   2. Sets client_review_status = 'pending_review' for all published prospects without status
//   3. Fires single LIST_READY email with total prospect count
//   4. Returns publish result with counts per tier
//
// Idempotency: backfill handles already-published prospects

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { sendTransactionalEmail } from '@/lib/email/send'
import { listReadyTemplate, listReadyTemplateText, listReadySubject } from '@/lib/email/templates/list-ready'

const TIERS = ['tier_1', 'tier_2', 'tier_3'] as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: organisationId } = await params

  try {
    // ── 1. Auth: operator role required ────────────────────────────────────
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: userRow } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!userRow || userRow.role !== 'operator') {
      return NextResponse.json({ error: 'Operator role required' }, { status: 403 })
    }

    // ── 2. Verify organisation exists ──────────────────────────────────────
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('id, name, founder_first_name, client_review_enabled')
      .eq('id', organisationId)
      .single()

    if (orgError || !org) {
      return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })
    }

    // Reject if client_review_enabled is false (bypass mode — auto-publish at tiering)
    if (org.client_review_enabled === false) {
      return NextResponse.json(
        {
          error: 'This organisation has client_review_enabled=false. Tiers are auto-published at tiering time.',
        },
        { status: 400 }
      )
    }

    // ── 3. Publish all tiers ──────────────────────────────────────────────
    const adminClient = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const publishedAt = new Date().toISOString()
    const tierResults: Record<string, number> = {}
    let totalNewPublished = 0

    // For each tier: publish new prospects and backfill status on existing ones
    for (const tier of TIERS) {
      // Step 1: Publish new prospects (set tier_published_at where it's null)
      const { data: newPublished, error: publishError } = await adminClient
        .from('prospects')
        .update({
          tier_published_at: publishedAt,
          client_review_status: 'pending_review',
        })
        .eq('organisation_id', organisationId)
        .eq('sourced_tier', tier)
        .is('tier_published_at', null)
        .eq('suppressed', false)
        .select('id')

      if (publishError) {
        logger.error('publish-all-tiers: update failed', {
          organisation_id: organisationId,
          tier,
          error: publishError.message,
        })
        throw publishError
      }

      const newCount = newPublished?.length ?? 0
      tierResults[tier] = newCount
      totalNewPublished += newCount

      // Step 2: Backfill status on already-published prospects
      const { error: backfillError } = await adminClient
        .from('prospects')
        .update({ client_review_status: 'pending_review' })
        .eq('organisation_id', organisationId)
        .eq('sourced_tier', tier)
        .not('tier_published_at', 'is', null)
        .is('client_review_status', null)
        .eq('suppressed', false)

      if (backfillError) {
        logger.warn('publish-all-tiers: backfill failed', {
          organisation_id: organisationId,
          tier,
          error: backfillError.message,
        })
      }
    }

    // Count total prospects now published and ready for review
    const { count: totalPublishedCount, error: countError } = await adminClient
      .from('prospects')
      .select('id', { count: 'exact' })
      .eq('organisation_id', organisationId)
      .not('tier_published_at', 'is', null)
      .eq('suppressed', false)

    if (countError) {
      logger.error('publish-all-tiers: count failed', {
        organisation_id: organisationId,
        error: countError.message,
      })
      throw countError
    }

    const publishedCount = totalPublishedCount ?? 0

    logger.info('publish-all-tiers: all tiers published', {
      organisation_id: organisationId,
      tier_results: tierResults,
      total_new_published: totalNewPublished,
      total_published_count: publishedCount,
      published_at: publishedAt,
    })

    // ── 4. Fire email 2 (LIST_READY) if new prospects were published ──────
    // Use narrow dedupe window (1 hour): only suppress duplicates within 60 minutes
    // This allows re-publishes after the window to notify again
    const batchDate = publishedAt.split('T')[0]
    const batchHour = publishedAt.split('T')[1]?.substring(0, 2) || '00'
    const batchId = `list_ready_${batchDate}_${batchHour}`

    if (totalNewPublished > 0) {
      try {
        // Check if email already sent in this hour
        const { data: existingLog } = await supabase
          .from('notifications_log')
          .select('id')
          .eq('organisation_id', organisationId)
          .eq('notification_type', 'list_ready')
          .eq('subject_id', batchId)
          .single()

        if (!existingLog) {
          // Log notification (creates unique constraint entry)
          await supabase.from('notifications_log').insert({
            organisation_id: organisationId,
            notification_type: 'list_ready',
            subject_id: batchId,
          })

          // Fetch client email
          const { data: clientUser } = await supabase
            .from('users')
            .select('email')
            .eq('organisation_id', organisationId)
            .eq('role', 'client')
            .single()

          if (clientUser?.email) {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
            const reviewUrl = `${appUrl}/dashboard/prospect-tiers`
            const lockDate = new Date(new Date(publishedAt).getTime() + 4 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })

            if (!Number.isFinite(publishedCount) || publishedCount <= 0) {
              logger.warn('publish-all-tiers: suppressed list_ready email — prospect count invalid', {
                organisation_id: organisationId,
                prospect_count: publishedCount,
              })
              Sentry.captureMessage(
                `list_ready email suppressed: invalid prospect count ${publishedCount}`,
                'warning'
              )
            } else {
              await sendTransactionalEmail({
                to: clientUser.email,
                subject: listReadySubject(lockDate),
                html: listReadyTemplate({
                  clientFirstName: org.founder_first_name,
                  prospectCount: publishedCount,
                  reviewUrl,
                  lockDate,
                }),
                text: listReadyTemplateText({
                  clientFirstName: org.founder_first_name,
                  prospectCount: publishedCount,
                  reviewUrl,
                  lockDate,
                }),
              })

              logger.info('publish-all-tiers: list_ready email sent', {
                organisation_id: organisationId,
                client_email: clientUser.email,
              })
            }
          }
        }
      } catch (emailError) {
        logger.warn('publish-all-tiers: email send failed (non-blocking)', {
          organisation_id: organisationId,
          error: emailError instanceof Error ? emailError.message : String(emailError),
        })
      }
    }

    return NextResponse.json({
      ok: true,
      result: {
        tier_results: tierResults,
        total_published_count: publishedCount,
        published_at: publishedAt,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('publish-all-tiers: failed', {
      organisation_id: params.then(p => p.id),
      error: errorMsg,
    })

    Sentry.captureException(err, {
      extra: { endpoint: '/publish-all-tiers' },
    })

    return NextResponse.json({ error: `Publish failed: ${errorMsg}` }, { status: 500 })
  }
}
