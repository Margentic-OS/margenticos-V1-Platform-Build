// GET/POST /api/cron/warmup-halfway
// Cron job: checks for warmups ~17 days old and sends progress email

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { sendTransactionalEmail } from '@/lib/email/send'
import { warmupHalfwayTemplate, warmupHalfwayTemplateText, warmupHalfwaySubject } from '@/lib/email/templates/warmup-halfway'

const WARMUP_MILESTONE_DAYS = 17

async function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(request: NextRequest) {
  // Verify CRON_SECRET for cron job security
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = await getAdminClient()
    const now = new Date()
    const milestoneDate = new Date(now.getTime() - WARMUP_MILESTONE_DAYS * 24 * 60 * 60 * 1000).toISOString()

    // Find organisations with warmup_started_at ~17 days ago
    const { data: orgs, error: orgsError } = await supabase
      .from('organisations')
      .select('id, name, warmup_started_at')
      .not('warmup_started_at', 'is', null)
      .lte('warmup_started_at', milestoneDate)

    if (orgsError) {
      throw orgsError
    }

    if (!orgs || orgs.length === 0) {
      logger.info('warmup-halfway: no organisations at milestone', { checked_at: now.toISOString() })
      return NextResponse.json({ ok: true, notified_count: 0 })
    }

    let notifiedCount = 0

    for (const org of orgs) {
      if (!org.warmup_started_at) continue

      try {
        // Dedup via notifications_log
        const { error: logError } = await supabase
          .from('notifications_log')
          .insert({
            organisation_id: org.id,
            notification_type: 'warmup_halfway',
            subject_id: org.id,
          })

        if (logError) {
          if (logError.code === '23505') {
            // Already sent this milestone email
            continue
          }
          throw logError
        }

        // Fetch client email
        const { data: clientUser } = await supabase
          .from('users')
          .select('email')
          .eq('organisation_id', org.id)
          .eq('role', 'client')
          .single()

        if (clientUser?.email) {
          // Calculate expected send date (warmup start + ~34 days)
          const sendDateObj = new Date(org.warmup_started_at)
          sendDateObj.setDate(sendDateObj.getDate() + 34)
          const sendDate = sendDateObj.toLocaleDateString('en-GB', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })

          await sendTransactionalEmail({
            to: clientUser.email,
            subject: warmupHalfwaySubject(),
            html: warmupHalfwayTemplate({
              sendDate,
            }),
            text: warmupHalfwayTemplateText({
              sendDate,
            }),
          })

          notifiedCount++

          logger.info('warmup-halfway: email sent', {
            organisation_id: org.id,
            warmup_started_at: org.warmup_started_at,
          })
        }
      } catch (err) {
        logger.error('warmup-halfway: error processing org', {
          organisation_id: org.id,
          error: err instanceof Error ? err.message : String(err),
        })
        Sentry.captureException(err, { extra: { organisation_id: org.id } })
      }
    }

    logger.info('warmup-halfway: cron run complete', { notified_count: notifiedCount })

    return NextResponse.json({ ok: true, notified_count: notifiedCount })
  } catch (err) {
    logger.error('warmup-halfway: cron failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    Sentry.captureException(err)

    return NextResponse.json(
      { error: 'Cron job failed' },
      { status: 500 }
    )
  }
}

// GET is alias for POST (common cron pattern)
export const GET = POST
