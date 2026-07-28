// GET/POST /api/cron/intake-nudge
// Cron job: checks for incomplete intakes (< 80%) with no activity in 48h
// Sends INTAKE_NUDGE email (fire once per org per intake cycle)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { sendTransactionalEmail } from '@/lib/email/send'
import { intakeNudgeTemplate, intakeNudgeTemplateText, intakeNudgeSubject } from '@/lib/email/templates/intake-nudge'

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
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()

    // Find organisations with incomplete intake and no activity in 48h
    const { data: orgs, error: orgsError } = await supabase
      .from('organisations')
      .select('id, name, contract_start_date, founder_first_name')
      .filter(
        'intake_last_activity_at',
        'lt',
        fortyEightHoursAgo
      )

    if (orgsError) {
      throw orgsError
    }

    if (!orgs || orgs.length === 0) {
      logger.info('intake-nudge: no organisations need nudge', { checked_at: now.toISOString() })
      return NextResponse.json({ ok: true, nudged_count: 0 })
    }

    let nudgedCount = 0

    for (const org of orgs) {
      try {
        // Check intake completeness
        const { data: intakeRows } = await supabase
          .from('intake_responses')
          .select('is_critical, response_value')
          .eq('organisation_id', org.id)

        const criticalRows = (intakeRows ?? []).filter(r => r.is_critical)
        const answeredRows = criticalRows.filter(r => (r.response_value ?? '').trim().length > 0)
        const completeness = criticalRows.length > 0
          ? Math.round((answeredRows.length / criticalRows.length) * 100)
          : 0

        if (completeness >= 80) {
          // Intake is complete, skip
          continue
        }

        // Log and send email (dedup via notifications_log)
        const { error: logError } = await supabase
          .from('notifications_log')
          .insert({
            organisation_id: org.id,
            notification_type: 'intake_nudge',
            subject_id: org.id,
          })

        if (logError) {
          if (logError.code === '23505') {
            // Already sent this nudge
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
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
          const intakeUrl = `${appUrl}/dashboard/intake`

          // Format kickoff date from contract_start_date
          let kickoffDate = 'your kickoff call'
          if (org.contract_start_date) {
            const kickoffDateObj = new Date(org.contract_start_date)
            kickoffDate = kickoffDateObj.toLocaleDateString('en-GB', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          }

          await sendTransactionalEmail({
            to: clientUser.email,
            subject: intakeNudgeSubject(),
            html: intakeNudgeTemplate({
              clientFirstName: org.founder_first_name || 'there',
              completionPercent: completeness,
              intakeUrl,
              kickoffDate,
            }),
            text: intakeNudgeTemplateText({
              clientFirstName: org.founder_first_name || 'there',
              completionPercent: completeness,
              intakeUrl,
              kickoffDate,
            }),
          })

          nudgedCount++

          logger.info('intake-nudge: email sent', {
            organisation_id: org.id,
            completeness_percent: completeness,
          })
        }
      } catch (err) {
        logger.error('intake-nudge: error processing org', {
          organisation_id: org.id,
          error: err instanceof Error ? err.message : String(err),
        })
        Sentry.captureException(err, { extra: { organisation_id: org.id } })
      }
    }

    logger.info('intake-nudge: cron run complete', { nudged_count: nudgedCount })

    return NextResponse.json({ ok: true, nudged_count: nudgedCount })
  } catch (err) {
    logger.error('intake-nudge: cron failed', {
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
