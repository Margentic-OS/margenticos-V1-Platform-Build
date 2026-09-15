// GET/POST /api/cron/warmup-halfway
// Checks for warmups inside the halfway WINDOW and sends one progress email.
//
// ═══════════════════════════════════════════════════════════════════════════
// THIS ROUTE IS NOT SCHEDULED, ON PURPOSE (2026-09-15)
//
// There is no pg_cron job for it and no Vercel cron: vercel.json has no `crons` key at
// all, so pg_cron is the only scheduler in this system. It has therefore NEVER RUN, and
// cron_heartbeats has never held a row for it.
//
// It is kept rather than deleted because the email is worth sending: it tells a client
// nothing is wrong during the one stretch of onboarding where nothing visibly happens,
// which is exactly when a new client gets nervous. Its sibling intake-nudge was deleted in
// the same commit, because that one needed a writer for a column nothing writes.
//
// BEFORE SCHEDULING IT, read the window note below. Wiring it as it was written would have
// emailed MargenticOS about a warmup that started 2026-06-22, roughly 85 days earlier.
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { sendTransactionalEmail } from '@/lib/email/send'
import { warmupHalfwayTemplate, warmupHalfwayTemplateText, warmupHalfwaySubject } from '@/lib/email/templates/warmup-halfway'

// ── The window, and why a floor alone was wrong ─────────────────────────────
//
// The original query was `warmup_started_at <= now - 17 days` with NO UPPER BOUND, so it
// selected every warmup ever started that is more than 17 days old. Measured 2026-09-15:
// that is MargenticOS, whose warmup began 2026-06-22, about 85 days ago, for a campaign
// that has already contacted all 95 of its prospects. It would have been told its domains
// were "about halfway through their warming cycle, on schedule", and given a first-send
// date in the past.
//
// A halfway note is only true inside a window. Below the floor it is early; above the
// ceiling the warmup is finished and the message is false. The ceiling is four days wider
// than the floor so that a daily job cannot miss an organisation by running late, while
// staying far short of the ~34-day cycle the email itself describes.
const WARMUP_MILESTONE_DAYS = 17
const WARMUP_WINDOW_CLOSES_DAYS = 21

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
    const DAY_MS = 24 * 60 * 60 * 1000
    // The window is [windowOpens, milestoneDate]: started at least 17 days ago, and not
    // more than 21. Both bounds are dates, so the comparison reads the same way round as
    // the timestamps do: a LATER start is a MORE RECENT warmup.
    const milestoneDate = new Date(now.getTime() - WARMUP_MILESTONE_DAYS * DAY_MS).toISOString()
    const windowOpens   = new Date(now.getTime() - WARMUP_WINDOW_CLOSES_DAYS * DAY_MS).toISOString()

    // Organisations whose warmup began inside the halfway window, excluding archived ones.
    const { data: orgs, error: orgsError } = await supabase
      .from('organisations')
      .select('id, name, warmup_started_at')
      .is('archived_at', null)
      .not('warmup_started_at', 'is', null)
      .lte('warmup_started_at', milestoneDate)
      .gte('warmup_started_at', windowOpens)

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
