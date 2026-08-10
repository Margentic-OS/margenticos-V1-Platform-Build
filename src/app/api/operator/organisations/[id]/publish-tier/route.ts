// POST /api/operator/organisations/[id]/publish-tier
// Operator publishes a tier for client review
//
// Request body: { tier: 'tier_1' | 'tier_2' | 'tier_3' }
// Effect:
//   1. Sets tier_published_at = now() for all unpublished prospects in that tier
//   2. Fires email 2 (LIST_READY) if first publish of this batch
//   3. Returns publish result
//
// Idempotency: silent skip if tier already published

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { sendTransactionalEmail } from '@/lib/email/send'
import { listReadyTemplate, listReadyTemplateText, listReadySubject } from '@/lib/email/templates/list-ready'

type TierName = 'tier_1' | 'tier_2' | 'tier_3'

interface PublishTierRequest {
  tier: TierName
}

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

    // ── 2. Parse request body ──────────────────────────────────────────────
    const body = (await request.json()) as PublishTierRequest
    const tier = body.tier

    if (!['tier_1', 'tier_2', 'tier_3'].includes(tier)) {
      return NextResponse.json(
        { error: 'Invalid tier. Must be tier_1, tier_2, or tier_3.' },
        { status: 400 }
      )
    }

    // ── 3. Verify organisation exists ──────────────────────────────────────
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

    // ── 4. Publish tier: set tier_published_at for unpublished prospects ───
    const adminClient = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const publishedAt = new Date().toISOString()

    const { data: publishedProspects, error: publishError } = await adminClient
      .from('prospects')
      .update({
        tier_published_at: publishedAt,
        client_review_status: 'pending_review',
      })
      .eq('organisation_id', organisationId)
      .eq('sourced_tier', tier)
      .is('tier_published_at', null) // Only unpublished prospects
      .eq('suppressed', false)
      .select('id')

    if (publishError) {
      logger.error('publish-tier: update failed', {
        organisation_id: organisationId,
        tier,
        error: publishError.message,
      })
      throw publishError
    }

    const publishedCount = publishedProspects?.length ?? 0

    logger.info('publish-tier: tier published', {
      organisation_id: organisationId,
      tier,
      published_count: publishedCount,
      published_at: publishedAt,
    })

    // ── 5. Fire email 2 (LIST_READY) if this is the first publish ─────────
    // Dedup across all tiers per day: one email per day regardless of how many tiers published
    // Use date as batch ID so tier_1, tier_2, tier_3 on same day all map to same email
    const batchDate = publishedAt.split('T')[0] // "2026-08-10"
    const batchId = `list_ready_${batchDate}`

    if (publishedCount > 0) {
      try {
        // Check if email already sent for this batch today
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

          // Fetch total published count across ALL tiers (matches what UI shows)
          // The client sees all tiers together on the page, so email shows total prospect count
          // not just this tier, ensuring it matches the running total they see on review page
          const { count: totalPublishedCount, error: countError } = await supabase
            .from('prospects')
            .select('id', { count: 'exact' })
            .eq('organisation_id', organisationId)
            .not('tier_published_at', 'is', null)
            .eq('suppressed', false)

          if (countError) {
            logger.warn('publish-tier: failed to fetch total published count', {
              organisation_id: organisationId,
              tier,
              error: countError.message,
            })
          }

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

            // Use total published count (not batch count) so email matches UI
            // Must be a finite number > 0 — never send list_ready for zero prospects
            const prospectCountForEmail = totalPublishedCount ?? publishedCount

            if (!Number.isFinite(prospectCountForEmail) || prospectCountForEmail <= 0) {
              logger.warn('publish-tier: suppressed list_ready email — prospect count invalid', {
                organisation_id: organisationId,
                tier,
                prospect_count: prospectCountForEmail,
              })
              Sentry.captureMessage(
                `list_ready email suppressed: invalid prospect count ${prospectCountForEmail}`,
                'warning'
              )
            } else {
              await sendTransactionalEmail({
                to: clientUser.email,
                subject: listReadySubject(lockDate),
                html: listReadyTemplate({
                  clientFirstName: org.founder_first_name,
                  prospectCount: prospectCountForEmail,
                  reviewUrl,
                  lockDate,
                }),
                text: listReadyTemplateText({
                  clientFirstName: org.founder_first_name,
                  prospectCount: prospectCountForEmail,
                  reviewUrl,
                  lockDate,
                }),
              })

              logger.info('publish-tier: list_ready email sent', {
                organisation_id: organisationId,
                tier,
                client_email: clientUser.email,
              })
            }
          }
        }
      } catch (emailError) {
        // Don't fail the publish if email fails
        logger.warn('publish-tier: email send failed (non-blocking)', {
          organisation_id: organisationId,
          tier,
          error: emailError instanceof Error ? emailError.message : String(emailError),
        })
      }
    }

    return NextResponse.json({
      ok: true,
      result: {
        tier,
        published_count: publishedCount,
        published_at: publishedAt,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('publish-tier: failed', {
      organisation_id: params.then(p => p.id),
      error: errorMsg,
    })

    Sentry.captureException(err, {
      extra: { endpoint: '/publish-tier' },
    })

    return NextResponse.json({ error: `Publish failed: ${errorMsg}` }, { status: 500 })
  }
}
