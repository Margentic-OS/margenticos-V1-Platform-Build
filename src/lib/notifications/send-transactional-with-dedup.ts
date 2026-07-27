// Helper for sending transactional emails with notifications_log dedup
// Used for event-driven emails (first_reply, first_meeting, etc.)

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'

export interface SendEmailWithDedupParams {
  supabase: SupabaseClient
  organisationId: string
  notificationType: string
  subjectId: string
  to: string
  subject: string
  html: string
  text?: string
}

export async function sendTransactionalEmailWithDedup(
  params: SendEmailWithDedupParams
): Promise<{ sent: boolean; reason?: string }> {
  try {
    // Check if already sent via notifications_log
    const { data: existingLog } = await params.supabase
      .from('notifications_log')
      .select('id')
      .eq('organisation_id', params.organisationId)
      .eq('notification_type', params.notificationType)
      .eq('subject_id', params.subjectId)
      .single()

    if (existingLog) {
      logger.info('sendTransactionalEmailWithDedup: already sent (dedup)', {
        organisation_id: params.organisationId,
        notification_type: params.notificationType,
        subject_id: params.subjectId,
      })
      return { sent: false, reason: 'already_sent' }
    }

    // Log the notification (creates unique constraint entry)
    const { error: logError } = await params.supabase
      .from('notifications_log')
      .insert({
        organisation_id: params.organisationId,
        notification_type: params.notificationType,
        subject_id: params.subjectId,
      })

    if (logError) {
      if (logError.code === '23505') {
        // Race condition: another worker already sent it
        logger.info('sendTransactionalEmailWithDedup: race condition (already sent)', {
          organisation_id: params.organisationId,
          notification_type: params.notificationType,
          subject_id: params.subjectId,
        })
        return { sent: false, reason: 'race_condition' }
      }
      throw logError
    }

    // Send the email
    const result = await sendTransactionalEmail({
      to: params.to,
      subject: params.subject,
      html: params.html,
      ...(params.text ? { text: params.text } : {}),
    })

    if (!result.success) {
      logger.warn('sendTransactionalEmailWithDedup: email send failed', {
        organisation_id: params.organisationId,
        notification_type: params.notificationType,
        error: result.error,
      })
      return { sent: false, reason: 'email_send_failed' }
    }

    logger.info('sendTransactionalEmailWithDedup: email sent successfully', {
      organisation_id: params.organisationId,
      notification_type: params.notificationType,
      subject_id: params.subjectId,
    })

    return { sent: true }
  } catch (err) {
    logger.error('sendTransactionalEmailWithDedup: error', {
      organisation_id: params.organisationId,
      notification_type: params.notificationType,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: 'error' }
  }
}
