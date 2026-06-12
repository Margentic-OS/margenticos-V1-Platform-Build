import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import {
  revisionProcessedTemplate,
  revisionProcessedSubject,
} from '@/lib/email/templates/revision-processed'
import {
  docsReadyTemplate,
  docsReadySubject,
} from '@/lib/email/templates/docs-ready'
import {
  versionPendingTemplate,
  versionPendingSubject,
} from '@/lib/email/templates/version-pending'

interface PromotionContext {
  organisation_id: string
  suggestion_id: string
  document_type: string
  update_trigger: string | null
}

/**
 * Notifies the client after a strategy document suggestion is promoted to active.
 * Branches on priority:
 * 1. If update_trigger is 'client_revision', send revision_processed to the client
 * 2. Else if all 4 docs now active AND docs_ready not yet sent, send docs_ready
 * 3. Else if docs_ready was previously sent, send version_pending for this doc
 * 4. Otherwise (early cascades), send nothing
 *
 * Resolves the client user by organisation_id and role='client'.
 * Wraps all sends so promotion always succeeds (failures captured to Sentry only).
 */
export async function notifyAfterPromotion(
  supabase: SupabaseClient,
  context: PromotionContext
): Promise<void> {
  const { organisation_id, suggestion_id, document_type, update_trigger } = context

  try {
    // Resolve client user email for this organisation
    const { data: clientUser, error: userError } = await supabase
      .from('users')
      .select('email')
      .eq('organisation_id', organisation_id)
      .eq('role', 'client')
      .single()

    if (userError || !clientUser?.email) {
      const message = userError?.message ?? 'No client user found'
      logger.warn(
        'notifyAfterPromotion: no client user found for organisation (misconfiguration)',
        { organisation_id, document_type, error: message }
      )
      Sentry.withScope((scope) => {
        scope.setExtra('organisation_id', organisation_id)
        scope.setExtra('document_type', document_type)
        scope.setExtra('error', message)
        Sentry.captureMessage(
          `No client user for organisation ${organisation_id} — notifications cannot be sent`,
          'warning'
        )
      })
      return
    }

    const clientEmail = clientUser.email
    const orgName = await fetchOrgName(supabase, organisation_id)

    // ── Priority 1: Revision processed ────────────────────────────────────────
    if (update_trigger === 'client_revision') {
      await logAndSend(
        supabase,
        {
          to: clientEmail,
          subject: revisionProcessedSubject(orgName, document_type),
          html: revisionProcessedTemplate({
            orgName,
            docType: document_type,
          }),
        },
        organisation_id,
        'revision_processed',
        suggestion_id
      )
      return
    }

    // ── Priority 2: All 4 docs active + docs_ready not sent ──────────────────
    const allDocsSent = await allFourDocsActive(supabase, organisation_id)
    const docsReadyLogged = await hasNotificationLog(
      supabase,
      organisation_id,
      'docs_ready'
    )

    if (allDocsSent && !docsReadyLogged) {
      await logAndSend(
        supabase,
        {
          to: clientEmail,
          subject: docsReadySubject(orgName),
          html: docsReadyTemplate({ orgName, orgId: organisation_id }),
        },
        organisation_id,
        'docs_ready',
        organisation_id
      )
      return
    }

    // ── Priority 3: docs_ready sent, send version_pending ────────────────────
    if (docsReadyLogged) {
      await logAndSend(
        supabase,
        {
          to: clientEmail,
          subject: versionPendingSubject(orgName, document_type),
          html: versionPendingTemplate({
            orgName,
            docType: document_type,
          }),
        },
        organisation_id,
        'version_pending',
        suggestion_id
      )
      return
    }

    // ── Priority 4: Early cascade, no notification ─────────────────────────────
    logger.info(
      'notifyAfterPromotion: early cascade (not all docs ready yet), skipping notification',
      { organisation_id, document_type }
    )
  } catch (err) {
    // Never let notification failures fail the promotion itself.
    // Log to Sentry for visibility, but swallow the error so the caller
    // (approval route or auto-approve cron) continues successfully.
    Sentry.captureException(err, {
      extra: {
        organisation_id,
        suggestion_id,
        document_type,
        update_trigger,
      },
      tags: {
        component: 'notifyAfterPromotion',
      },
    })
    try {
      await Sentry.flush(2000)
    } catch {}
    logger.error('notifyAfterPromotion: notification wrapper error', {
      organisation_id,
      document_type,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Inserts a log row with dedup, then sends the email.
 * If the log insert fails with constraint violation (already sent), skips silently.
 */
async function logAndSend(
  supabase: SupabaseClient,
  emailParams: { to: string; subject: string; html: string },
  organisation_id: string,
  notification_type: string,
  subject_id: string
): Promise<void> {
  // Log insertion with dedup: unique constraint blocks duplicates.
  // If the row already exists, the insert fails with constraint violation.
  // We catch that and treat it as already-sent (idempotent).
  const { error: logError } = await supabase
    .from('notifications_log')
    .insert({
      organisation_id,
      notification_type,
      subject_id,
    })

  if (logError) {
    if (logError.code === '23505') {
      // Constraint violation: this exact notification was already sent.
      logger.info(
        'logAndSend: notification already logged (dedup), skipping send',
        { organisation_id, notification_type, subject_id }
      )
      return
    }
    // Other errors are real problems.
    throw new Error(
      `Failed to log notification: ${logError.message} (${logError.code})`
    )
  }

  // Log succeeded. Send the email.
  const result = await sendTransactionalEmail(emailParams)
  if (!result.success) {
    logger.warn(
      'logAndSend: email send failed after log insert',
      { organisation_id, notification_type, subject_id, error: result.error }
    )
    // Don't throw — notification was logged, email failure is not fatal.
  }
}

/**
 * Checks if all four document types have an active version.
 */
async function allFourDocsActive(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('document_type')
    .eq('organisation_id', organisation_id)
    .eq('status', 'active')

  if (error) {
    logger.error('allFourDocsActive: query failed', {
      organisation_id,
      error: error.message,
    })
    return false
  }

  const types = new Set(data?.map((d) => d.document_type) ?? [])
  return types.has('icp') && types.has('tov') && types.has('positioning') && types.has('messaging')
}

/**
 * Checks if a notification of this type has been sent for this organisation.
 */
async function hasNotificationLog(
  supabase: SupabaseClient,
  organisation_id: string,
  notification_type: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('notifications_log')
    .select('id')
    .eq('organisation_id', organisation_id)
    .eq('notification_type', notification_type)
    .limit(1)

  if (error) {
    logger.error('hasNotificationLog: query failed', {
      organisation_id,
      notification_type,
      error: error.message,
    })
    return false
  }

  return (data?.length ?? 0) > 0
}

/**
 * Fetches organisation name for use in email templates.
 */
async function fetchOrgName(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<string> {
  const { data, error } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', organisation_id)
    .single()

  if (error || !data?.name) {
    logger.warn('fetchOrgName: could not resolve org name', {
      organisation_id,
      error: error?.message,
    })
    return 'Your Organisation'
  }

  return data.name
}
