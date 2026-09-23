// Telling the operator that a client changed an answer they had already given.
//
// ─── WHAT THIS IS FOR ────────────────────────────────────────────────────────
//
// An intake edit can move the ground underneath a live strategy document. The flagging in
// flag-stale-documents.ts records that on the document itself, which is the durable half and
// the half that must never depend on an email. This is the other half: the operator is told,
// once, that it happened, and what moved.
//
// IT NEVER REGENERATES ANYTHING and it never says anything was regenerated. See ADR-047 and
// the template header.
//
// ─── FIRST SAVE IS NOT AN EDIT, AND THIS MODULE DOES NOT DECIDE THAT ─────────
//
// A client answering a question for the FIRST time must not produce a notification. No
// document was built without that answer, so nothing it feeds can have been written on a
// different premise, and an operator sent to look at a document that is fine learns to stop
// looking. Both callers already make that decision, because only they can see the previous
// value: saveIntakeResponse through isIntakeAnswerEdit, which returns false for a null
// previous, and saveBuyerProfile through changedBuyerProfileFields, which returns nothing
// for a null previous ROW (not an empty profile, which is a different state and reinstates
// the bug). This module is handed the changes and trusts them. Passing it a first answer
// would notify, and that is the caller's fault by construction rather than a check here,
// because the previous value does not survive the trip.
//
// ─── NEVER THROWS ────────────────────────────────────────────────────────────
//
// It runs after the client's answer is already saved. An exception here would turn a
// successful save into a failed one, and the answer is the thing that matters. Same contract
// as flagDocumentsStaleForIntakeEditSafely beside it, for the same reason.

import { createHash } from 'node:crypto'
import { logger } from '@/lib/logger'
import { createServiceRoleClient, type ServiceRoleClient } from '@/lib/supabase/service-role'
import { deriveSubjectId } from '@/lib/notifications/claim-notification'
import { sendTransactionalEmailWithDedup } from '@/lib/notifications/send-transactional-with-dedup'
import {
  clientRevisionNotifySubject,
  clientRevisionNotifyTemplate,
  clientRevisionNotifyTemplateText,
} from '@/lib/email/templates/client-revision-notify'
import type { IntakeAnswerChange } from '@/lib/intake/answer-change'

/**
 * The notifications_log discriminator. Free text in the database: there is no CHECK
 * constraint on notification_type, verified against the live catalog on 2026-09-23.
 */
export const INTAKE_EDIT_NOTIFICATION_TYPE = 'client_intake_answer_changed'

/**
 * The dedup key for one edit event.
 *
 * ─── WHY IT IS DERIVED FROM THE CHANGE ITSELF ───────────────────────────────
 *
 * notifications_log deduplicates on (organisation_id, notification_type, subject_id), and
 * subject_id is a uuid column, so a readable key has to go through deriveSubjectId. What
 * that key should CONTAIN is the real decision, and the obvious candidates are both wrong:
 *
 *   The field key alone     would send ONE email per question, for ever. A client who
 *                           corrects the same answer in March and again in June is told
 *                           about once. That is the permanent-suppression shape that
 *                           af594db was written to remove from this very helper.
 *
 *   A fresh uuid per call   would deduplicate nothing, and two requests racing on the same
 *                           blur would both send. The unique index is the only arbiter of
 *                           that race, and it cannot arbitrate distinct keys.
 *
 *   intake_responses.version looks right and is not: it is declared DEFAULT 1 and nothing
 *                           increments it. The upsert in saveIntakeResponse does not list
 *                           the column, and there is no trigger on the table. Measured on
 *                           the live catalog 2026-09-23: the only trigger on
 *                           intake_responses is set_updated_at. Keying on it would collapse
 *                           every edit of a field onto version 1.
 *
 * So the key is the CONTENT of the change: which answers moved, and from what to what. Two
 * concurrent saves of the same edit derive the same key and exactly one wins, which is the
 * race that actually happens. Two different edits derive different keys and both send.
 *
 * KNOWN AND ACCEPTED: a client who changes an answer from A to B, back to A, and to B again
 * derives the first key a second time, and the third notification is suppressed. That is the
 * right way round. By then the documents fed by that answer are ALREADY flagged stale from
 * the first edit, so flagDocumentsStaleForIntakeEdit returns nothing for the third, and the
 * suppressed email is the one that would have said "no live document was newly flagged".
 * Nothing an operator needs is lost.
 *
 * The values are hashed rather than concatenated raw so an answer of any length yields a
 * bounded key, and so nothing a client typed is stored in the notifications table.
 */
export function intakeEditSubjectKey(
  organisationId: string,
  changes: readonly IntakeAnswerChange[],
): string {
  const canonical = changes
    .map(c => `${c.fieldKey}\u0000${c.previous}\u0000${c.next}`)
    .sort()
    .join('\u0001')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `${INTAKE_EDIT_NOTIFICATION_TYPE}:${organisationId}:${digest}`
}

interface NotifyParams {
  organisationId: string
  changes: readonly IntakeAnswerChange[]
  /** What flagDocumentsStaleForIntakeEdit actually flagged. Often empty; never invented. */
  flaggedDocumentTypes: readonly string[]
}

/**
 * Send it, with a client of the caller's choosing.
 *
 * Exported separately from the wrapper so a test can hand it a fake, which is the same shape
 * flag-stale-documents.ts uses and for the same reason.
 */
export async function notifyOperatorOfIntakeEdit(
  service: ServiceRoleClient,
  { organisationId, changes, flaggedDocumentTypes }: NotifyParams,
): Promise<{ sent: boolean }> {
  // Nothing changed means there is nothing to say. Sending an empty notification would
  // train the operator to ignore the notification.
  if (changes.length === 0) return { sent: false }

  const { data: org, error: orgError } = await service
    .from('organisations')
    .select('name')
    .eq('id', organisationId) // explicit isolation filter
    .single()

  if (orgError || !org?.name) {
    logger.error('intake edit: could not read the organisation, operator not notified', {
      organisation_id: organisationId,
      error: orgError?.message,
      consequence: 'The answers are saved and any flagging has happened. The operator is ' +
        'not being told the client changed an answer.',
    })
    return { sent: false }
  }

  // THE OPERATOR, not the client. Deliberately not filtered by organisation_id: the operator
  // does not belong to the client's organisation. ADR-021, and the same lookup
  // send-operator-reply-notification.ts uses.
  //
  // A ROLE LOOKUP RATHER THAN RESEND_OPERATOR_EMAIL. The env var is one typo away from
  // sending a client another client's answers, which is the exact harm recipient-audience.ts
  // exists to catch; reading the role means the address is right by construction and the
  // guard is the second layer rather than the only one.
  const { data: operator, error: operatorError } = await service
    .from('users')
    .select('email')
    .eq('role', 'operator')
    .limit(1)
    .single()

  const operatorEmail = (operator as { email: string | null } | null)?.email
  if (operatorError || !operatorEmail) {
    logger.error('intake edit: no operator email could be resolved, operator not notified', {
      organisation_id: organisationId,
      error: operatorError?.message,
      consequence: 'A client changed an answer and nobody is being told.',
    })
    return { sent: false }
  }

  const templateParams = {
    orgName: org.name as string,
    orgId: organisationId,
    changes: changes.map(c => ({
      fieldLabel: c.fieldLabel,
      previous: c.previous,
      next: c.next,
    })),
    flaggedDocumentTypes,
  }

  const result = await sendTransactionalEmailWithDedup({
    supabase: service,
    organisationId,
    notificationType: INTAKE_EDIT_NOTIFICATION_TYPE,
    subjectId: deriveSubjectId(intakeEditSubjectKey(organisationId, changes)),
    to: operatorEmail,
    // Internal alert. Exempt from the customer-facing style rules, never from the rendering
    // checks: every value in the template is pre-rendered by answer-change.ts so that a real
    // null in the buyer profile cannot reach the validator as the word "null".
    audience: 'operator',
    subject: clientRevisionNotifySubject(templateParams.orgName, templateParams.changes),
    html: clientRevisionNotifyTemplate(templateParams),
    text: clientRevisionNotifyTemplateText(templateParams),
  })

  if (!result.sent) {
    logger.warn('intake edit: the operator notification did not send', {
      organisation_id: organisationId,
      reason: result.reason,
      changed_fields: changes.map(c => c.fieldKey),
    })
  }

  return { sent: result.sent }
}

/**
 * The same thing, building its own service-role client. What the server actions call.
 *
 * NEVER THROWS, and never blocks a save. It builds the client rather than accepting one so
 * that no call site can hand it a session client by mistake, which is belt and braces over
 * the ServiceRoleClient brand that already makes that a compile error.
 */
export async function notifyOperatorOfIntakeEditSafely(params: NotifyParams): Promise<void> {
  if (params.changes.length === 0) return

  try {
    const service = await createServiceRoleClient()
    await notifyOperatorOfIntakeEdit(service, params)
  } catch (err) {
    logger.error('intake edit: could not notify the operator at all', {
      organisation_id: params.organisationId,
      changed_fields: params.changes.map(c => c.fieldKey),
      error: String(err),
      consequence: 'The answers are saved and any document flagging has happened. The ' +
        'operator is not being told.',
    })
  }
}
