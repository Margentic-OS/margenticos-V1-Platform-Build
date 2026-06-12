// POST /api/cron/auto-approve
//
// Called by Vercel Cron on an hourly schedule. Finds all pending document
// suggestions whose auto-approve window has elapsed and promotes them to active
// strategy documents using the existing approve_document_suggestion transaction.
//
// Auth: Vercel injects CRON_SECRET as the Authorization bearer token on every
// cron invocation. Any request without a valid token is rejected immediately.
//
// Uses service_role to act across all organisations without RLS interference.
// This is intentional — the cron acts as a system process, not a user.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { triggerCascadeIfEligible } from '@/lib/agents/cascade/trigger-cascade'
import { notifyAfterPromotion } from '@/lib/notifications/notify-after-promotion'
import { sendTransactionalEmail } from '@/lib/email/send'
import {
  approvalReminderTemplate,
  approvalReminderSubject,
} from '@/lib/email/templates/approval-reminder'
import * as Sentry from '@sentry/nextjs'

// Written into reviewed_by to identify auto-approved suggestions in the DB.
const SYSTEM_AUTO_APPROVE_ID = '00000000-0000-0000-0000-000000000001'

export async function POST(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ────────────────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Fetch all pending suggestions with their org's approval window ──────────
  const { data: pending, error: fetchError } = await supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, created_at, update_trigger, organisations(auto_approve_window_hours)')
    .eq('status', 'pending')

  if (fetchError) {
    logger.error('Auto-approve cron: failed to fetch pending suggestions', {
      error: fetchError.message,
    })
    return NextResponse.json({ error: 'Failed to fetch suggestions.' }, { status: 500 })
  }

  if (!pending || pending.length === 0) {
    logger.info('Auto-approve cron: no pending suggestions found')
    return NextResponse.json({ processed: 0, succeeded: 0, failed: 0 })
  }

  const now = Date.now()
  let succeeded = 0
  let failed = 0

  const due = pending.filter((s) => {
    // Supabase returns foreign-key joins as arrays in its inferred types.
    const orgs = s.organisations as unknown as { auto_approve_window_hours: number }[] | null
    const windowHours = orgs?.[0]?.auto_approve_window_hours ?? 72
    const dueAt = new Date(s.created_at).getTime() + windowHours * 60 * 60 * 1000
    return dueAt <= now
  })

  logger.info('Auto-approve cron: processing due suggestions', {
    total_pending: pending.length,
    due_count: due.length,
  })

  for (const suggestion of due) {
    try {
      const { error: rpcError } = await supabase.rpc('approve_document_suggestion', {
        p_suggestion_id: suggestion.id,
        p_reviewer_id: SYSTEM_AUTO_APPROVE_ID,
      })

      if (rpcError) {
        // The RPC raises this when the suggestion is no longer pending — it was
        // approved or rejected by the operator between our query and this call.
        // Not a failure: the suggestion was handled. Skip it cleanly.
        if (rpcError.message.includes('not in pending status')) {
          logger.info('Auto-approve cron: suggestion already handled, skipping', {
            suggestion_id: suggestion.id,
            organisation_id: suggestion.organisation_id,
            document_type: suggestion.document_type,
          })
          continue
        }
        throw new Error(rpcError.message)
      }

      logger.info('Auto-approve cron: suggestion auto-approved', {
        suggestion_id: suggestion.id,
        organisation_id: suggestion.organisation_id,
        document_type: suggestion.document_type,
      })
      succeeded++

      // Notify client and cascade in sequence.
      await notifyAfterPromotion(supabase, {
        organisation_id: suggestion.organisation_id,
        suggestion_id: suggestion.id,
        document_type: suggestion.document_type,
        update_trigger: suggestion.update_trigger,
      })
      await triggerCascadeIfEligible(supabase, suggestion.organisation_id, suggestion.document_type)
    } catch (err) {
      logger.error('Auto-approve cron: failed to approve suggestion', {
        suggestion_id: suggestion.id,
        organisation_id: suggestion.organisation_id,
        document_type: suggestion.document_type,
        error: err instanceof Error ? err.message : String(err),
      })
      failed++
    }
  }

  logger.info('Auto-approve cron: batch complete', {
    processed: due.length,
    succeeded,
    failed,
  })

  // ── Send approval reminders for suggestions due within 12 hours ───────────────
  const REMINDER_WINDOW_MS = 12 * 60 * 60 * 1000
  const reminderCutoff = new Date(now + REMINDER_WINDOW_MS).getTime()

  const remindersNeeded = pending.filter((s) => {
    const orgs = s.organisations as unknown as { auto_approve_window_hours: number }[] | null
    const windowHours = orgs?.[0]?.auto_approve_window_hours ?? 72
    const dueAt = new Date(s.created_at).getTime() + windowHours * 60 * 60 * 1000

    // Due within 12 hours but not already due
    return dueAt > now && dueAt <= reminderCutoff
  })

  let remindersLogged = 0
  let remindersFailed = 0

  for (const suggestion of remindersNeeded) {
    try {
      const orgs = suggestion.organisations as unknown as { auto_approve_window_hours: number }[] | null
      const windowHours = orgs?.[0]?.auto_approve_window_hours ?? 72
      const dueAt = new Date(suggestion.created_at).getTime() + windowHours * 60 * 60 * 1000
      const autoApprovesAt = new Date(dueAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })

      // Try to log the reminder (dedup by unique constraint)
      const { error: logError } = await supabase
        .from('notifications_log')
        .insert({
          organisation_id: suggestion.organisation_id,
          notification_type: 'approval_reminder',
          subject_id: suggestion.id,
        })

      if (logError && logError.code !== '23505') {
        throw new Error(`Reminder log failed: ${logError.message}`)
      }

      // If already logged (constraint violation), skip send
      if (logError?.code === '23505') {
        logger.info('Auto-approve cron: reminder already sent for this suggestion', {
          suggestion_id: suggestion.id,
          organisation_id: suggestion.organisation_id,
        })
        continue
      }

      // Log succeeded, send email to operator
      const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
      if (!operatorEmail) {
        logger.warn('Auto-approve cron: RESEND_OPERATOR_EMAIL not set — reminder skipped', {
          suggestion_id: suggestion.id,
        })
        continue
      }

      // Fetch org name for the email
      const { data: org } = await supabase
        .from('organisations')
        .select('name')
        .eq('id', suggestion.organisation_id)
        .single()

      const orgName = org?.name ?? 'Organisation'

      const result = await sendTransactionalEmail({
        to: operatorEmail,
        subject: approvalReminderSubject(orgName),
        html: approvalReminderTemplate({
          orgName,
          docType: suggestion.document_type,
          autoApprovesAt,
        }),
      })

      if (result.success) {
        logger.info('Auto-approve cron: approval reminder sent', {
          suggestion_id: suggestion.id,
          organisation_id: suggestion.organisation_id,
          document_type: suggestion.document_type,
          auto_approves_at: autoApprovesAt,
        })
        remindersLogged++
      } else {
        logger.warn('Auto-approve cron: approval reminder send failed', {
          suggestion_id: suggestion.id,
          organisation_id: suggestion.organisation_id,
          error: result.error,
        })
        remindersFailed++
      }
    } catch (err) {
      logger.error('Auto-approve cron: reminder batch error', {
        suggestion_id: suggestion.id,
        organisation_id: suggestion.organisation_id,
        error: err instanceof Error ? err.message : String(err),
      })
      Sentry.captureException(err, {
        extra: { suggestion_id: suggestion.id },
        tags: { component: 'auto-approve-reminder' },
      })
      remindersFailed++
    }
  }

  if (remindersNeeded.length > 0) {
    logger.info('Auto-approve cron: reminders batch complete', {
      total: remindersNeeded.length,
      sent: remindersLogged,
      failed: remindersFailed,
    })
  }

  return NextResponse.json({
    processed: due.length,
    succeeded,
    failed,
    reminders_due: remindersNeeded.length,
    reminders_sent: remindersLogged,
    reminders_failed: remindersFailed,
  })
}
