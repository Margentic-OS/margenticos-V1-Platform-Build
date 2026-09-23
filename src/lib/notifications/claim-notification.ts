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

import { createHash } from 'node:crypto'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'

// ═════════════════════════════════════════════════════════════════════════════
// THE SUBJECT IS A uuid COLUMN, AND TWO CALLERS WERE PASSING PROSE
//
// notifications_log.subject_id is `uuid`. Most callers pass a real entity id and are fine.
// The two publish routes built a readable batch key instead:
//
//     `list_ready_${batchDate}_${batchHour}`   ->  "list_ready_2026-09-16_20"
//
// Postgres rejected every one of those with 22P02, invalid input syntax for type uuid. So
// claimNotification returned 'failed' on every call, and the routes then did exactly what
// they should: refused to send, because an unrecorded send cannot be deduplicated.
//
// The result was a fail-closed gate on a precondition that could never be met. The publish
// reported success, the error logged, and the client was never told their list was ready.
// Measured on production 2026-09-16: 34 prospects published, 0 list_ready rows ever written
// for that organisation, against 14 rows of five other types. Proven by probing the exact
// string inside BEGIN ... ROLLBACK.
//
// WHY A DERIVED UUID RATHER THAN A RANDOM ONE
//
// The subject is what the unique index deduplicates on:
// unique_notification_per_subject (organisation_id, notification_type, subject_id).
// crypto.randomUUID() would insert cleanly and destroy the property the batch key existed
// for: every publish would claim a fresh subject, the window would suppress nothing, and a
// double-click would email the client twice. The identifier has to be STABLE for the same
// batch key and DIFFERENT for a different one, which is exactly a namespaced hash.
//
// WHY NOT WIDEN THE COLUMN TO text
//
// That also works and is a smaller diff, but it changes an index every other notification
// type already depends on, and the rows in it today are all real uuids. Deriving keeps the
// column, the index and the existing rows untouched, and confines the change to the two
// callers that were wrong.

/**
 * A fixed namespace for derived notification subjects. RFC 4122 §4.3 name-based UUID.
 *
 * NEVER CHANGE THIS VALUE. Every derived subject id is a function of it, so changing it
 * re-derives every id, and the next publish in an already-notified window would read as a
 * fresh subject and email the client a second time. It is arbitrary, and that is fine; what
 * matters is that it is constant.
 */
const SUBJECT_NAMESPACE_UUID = '7c9e6f2a-4b1d-43e8-a05f-8c3d2e1b9a67'
const SUBJECT_NAMESPACE = Buffer.from(SUBJECT_NAMESPACE_UUID.replace(/-/g, ''), 'hex')

/**
 * Turn a human-readable batch key into a stable UUIDv5 the uuid column will accept.
 *
 * Deterministic: the same key always yields the same uuid, which is what preserves the
 * deduplication window. Callers that already hold a real entity uuid must NOT use this —
 * hashing those would change their stored subject ids and re-send notifications that have
 * already gone out.
 */
export function deriveSubjectId(key: string): string {
  const hash = createHash('sha1').update(SUBJECT_NAMESPACE).update(key, 'utf8').digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-')
}

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

/**
 * Give a claim back after the send it was taken for did not happen.
 *
 * WHY A CLAIM NEEDS A RELEASE AT ALL
 *
 * Claiming before sending is correct: an unrecorded send cannot be deduplicated, so the row
 * has to exist before the mail goes out. The consequence is that the row means "somebody
 * intends to send this", and when the send then fails the row is a lie that outlives the
 * attempt. Because the row IS the dedup key, the next attempt reads it, concludes the mail
 * already went, and the notification is suppressed for ever by its own bookkeeping. Nothing
 * retries it and nothing anywhere records that it never arrived.
 *
 * Releasing closes that. Claim, send, and on failure put the claim back so the next
 * invocation is free to try again.
 *
 * WHY NOT INSTEAD SEND FIRST AND RECORD AFTER
 *
 * Because the failure then runs the other way and is worse: a send that succeeds and a row
 * that fails to write means the next run sends a SECOND copy, and duplicate mail to a client
 * is not recoverable. Losing an alert is bad; mailing a prospect's reply notification twice,
 * or a client a duplicate, is worse. Claim-then-release keeps the safe failure direction and
 * removes the permanence.
 *
 * A FAILED RELEASE IS LOGGED AND SWALLOWED. If the delete itself fails, the row stays and
 * that subject stays deduped, which is exactly the old behaviour: no worse, and there is
 * nothing useful to do about it in the moment. It is logged at error because it is the one
 * case where a notification is still permanently lost.
 */
export async function releaseNotificationClaim(
  adminClient: ServiceRoleClient,
  params: { organisationId: string; notificationType: string; subjectId: string },
): Promise<void> {
  const { organisationId, notificationType, subjectId } = params

  const { error } = await adminClient
    .from('notifications_log')
    .delete()
    .eq('organisation_id', organisationId)
    .eq('notification_type', notificationType)
    .eq('subject_id', subjectId)

  if (error) {
    logger.error(
      'releaseNotificationClaim: could not release the claim, so this notification stays deduped and is permanently lost',
      {
        organisation_id: organisationId,
        notification_type: notificationType,
        subject_id: subjectId,
        error: error.message,
      },
    )
    return
  }

  logger.info('releaseNotificationClaim: claim released, the next attempt will retry', {
    organisation_id: organisationId,
    notification_type: notificationType,
    subject_id: subjectId,
  })
}
