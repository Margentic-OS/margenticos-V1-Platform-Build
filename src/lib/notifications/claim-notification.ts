// Claiming a one-time notification before sending it.
//
// WHY THIS EXISTS AS A FUNCTION
//
// Three call sites hand-rolled this block: publish-tier, publish-all-tiers and
// updateWarmupCompletedAt. All three did it through the SESSION client, and
// notifications_log is service-role only (RLS enabled, zero policies), so every insert
// failed with 42501 and every read came back empty. The two publish routes discarded the
// error and gated the send on a SELECT that could never find anything, so the dedup never
// applied. updateWarmupCompletedAt gated on the insert error instead, so it failed the
// other way and never sent at all.
//
// THE PARAMETER TYPE IS THE FIX
//
// This takes a ServiceRoleClient, which is a branded type. A session client does not
// satisfy it and will not compile. The original bug is therefore not something a future
// caller has to remember to avoid: it cannot be expressed. That is the point of putting
// the claim behind one function rather than fixing three copies of it.
//
// CLAIM BY INSERTING, NEVER BY SELECTING
//
// The claim is the INSERT against unique_notification_per_subject
// (organisation_id, notification_type, subject_id). A SELECT that finds nothing is not a
// claim: two overlapping publishes can both read empty and both send. Letting the unique
// index arbitrate means exactly one caller can win, and the loser sees 23505.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'

/**
 * 'claimed'      — this caller won; it is the one that must send.
 * 'already_sent' — someone already claimed this exact notification. Do not send.
 * 'failed'       — the claim could not be recorded. Do NOT send: an unrecorded send
 *                  cannot be deduplicated and would repeat on the next invocation.
 */
export type NotificationClaim = 'claimed' | 'already_sent' | 'failed'

export async function claimNotification(
  adminClient: ServiceRoleClient,
  params: { organisationId: string; notificationType: string; subjectId: string },
): Promise<NotificationClaim> {
  const { organisationId, notificationType, subjectId } = params

  const { error } = await adminClient.from('notifications_log').insert({
    organisation_id: organisationId,
    notification_type: notificationType,
    subject_id: subjectId,
  })

  if (!error) return 'claimed'

  // 23505 is unique_violation: the marker is already there, so the mail already went.
  // This is the expected, healthy outcome on a second call, not an error.
  if (error.code === '23505') {
    logger.info('claimNotification: already sent, skipping', {
      organisation_id: organisationId,
      notification_type: notificationType,
      subject_id: subjectId,
    })
    return 'already_sent'
  }

  logger.error('claimNotification: could not record the claim, refusing to send', {
    organisation_id: organisationId,
    notification_type: notificationType,
    subject_id: subjectId,
    error: error.message,
    code: error.code,
  })
  return 'failed'
}
