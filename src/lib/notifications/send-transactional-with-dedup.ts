// Helper for sending transactional emails with notifications_log dedup
// Used for event-driven emails (first_reply, first_meeting, etc.)
//
// ═══════════════════════════════════════════════════════════════════════════════
// A FAILED SEND USED TO BLOCK ITS OWN RETRY FOR EVER
//
// This wrote the notifications_log row, sent, and on failure returned
// { sent: false, reason: 'email_send_failed' } WITHOUT TOUCHING THE ROW. The row is the
// dedup key, so the next invocation read it, concluded the mail had already gone, and
// returned 'already_sent'. The notification was then suppressed permanently by its own
// bookkeeping, nothing retried it, and the table recorded an intent to send as though it
// were a delivery.
//
// It now RELEASES the claim when the send does not happen, so the next attempt retries.
//
// WHY THE CLAIM GOES THROUGH claimNotification RATHER THAN A FOURTH COPY OF THIS BLOCK
//
// claim-notification.ts already owns these semantics and its header already explains why
// they are what they are. Two things came free by using it:
//
//   1. CLAIM BY INSERTING, NEVER BY SELECTING. The old code did SELECT-then-INSERT. A
//      SELECT that finds nothing is not a claim: two overlapping workers can both read
//      empty and both send. Letting the unique index arbitrate means exactly one wins.
//      (The old code did handle 23505 afterwards, so this was narrower than it looks, but
//      the read was still a redundant round trip that could only ever disagree with it.)
//
//   2. The parameter is a ServiceRoleClient, which is a BRANDED type. notifications_log is
//      service-role only, RLS enabled with zero policies, so a session client here fails at
//      runtime with 42501 and reads back empty — the exact fault claim-notification.ts was
//      extracted to make impossible. This signature was plain SupabaseClient, which is
//      structurally identical to a session client and asserted a privilege it did not
//      enforce. Both real callers already hold a branded client, so tightening it changed
//      no call site and now a wrong one cannot compile.

import { logger } from '@/lib/logger'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { sendTransactionalEmail, type EmailAudience } from '@/lib/email/send'
import { claimNotification, releaseNotificationClaim } from './claim-notification'

export interface SendEmailWithDedupParams {
  supabase: ServiceRoleClient
  organisationId: string
  notificationType: string
  subjectId: string
  to: string
  subject: string
  html: string
  text?: string
  /** Defaults to 'customer' downstream. Set 'operator' for internal alerts. */
  audience?: EmailAudience
}

export async function sendTransactionalEmailWithDedup(
  params: SendEmailWithDedupParams
): Promise<{ sent: boolean; reason?: string }> {
  const claimParams = {
    organisationId: params.organisationId,
    notificationType: params.notificationType,
    subjectId: params.subjectId,
  }

  try {
    const claim = await claimNotification(params.supabase, claimParams)

    if (claim === 'already_sent') {
      // Someone else holds this subject. Either the mail went, or another worker is in the
      // middle of sending it. Not ours to send either way.
      return { sent: false, reason: 'already_sent' }
    }

    if (claim === 'failed') {
      // The claim could not be recorded, so a send here could not be deduplicated and would
      // repeat on the next run. claimNotification has already logged why.
      return { sent: false, reason: 'error' }
    }

    // Send the email. audience passes straight through: this wrapper carries operator
    // alerts as well as client mail, and swallowing the field here would silently put
    // every deduped operator notification back under the customer-facing style rules.
    const result = await sendTransactionalEmail({
      to: params.to,
      subject: params.subject,
      html: params.html,
      ...(params.text ? { text: params.text } : {}),
      ...(params.audience ? { audience: params.audience } : {}),
    })

    if (!result.success) {
      logger.warn('sendTransactionalEmailWithDedup: email send failed, releasing the claim', {
        organisation_id: params.organisationId,
        notification_type: params.notificationType,
        error: result.error,
      })
      // THE FIX. Without this the row stands and no later attempt can ever get past it.
      await releaseNotificationClaim(params.supabase, claimParams)
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
    // A throw between the claim and the send leaves the same stuck row a failed send did.
    // Release here too, and swallow anything this throws: the original error is the one
    // worth reporting.
    try {
      await releaseNotificationClaim(params.supabase, claimParams)
    } catch {
      // releaseNotificationClaim logs its own failures.
    }
    return { sent: false, reason: 'error' }
  }
}
