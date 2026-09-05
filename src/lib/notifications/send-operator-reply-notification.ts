// Tells the OPERATOR that a reply needs actioning. Once per reply, every reply.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THIS REPLACES, AND WHY ALL THREE PARTS WERE WRONG
//
// sendFirstReplyEmail, deleted in the same commit, did three things:
//
//   1. It emailed the CLIENT. The recipient query was `users` where role = 'client'.
//      Measured 2026-09-04: there is no path anywhere in this codebase that notifies an
//      operator about a reply. The one person who has to act received nothing, ever.
//
//   2. It fired ONCE PER ORGANISATION, for the lifetime of that organisation, because
//      subject_id was the organisation id under a UNIQUE
//      (organisation_id, notification_type, subject_id). Production held exactly one such
//      row, written 2026-09-03, so that notification was already spent for that client and
//      no future reply could ever produce another. The Locked decision "First reply and
//      first meeting are notifications, not onboarding" says they RECUR for the life of the
//      account. The decision wins.
//
//   3. Its copy promised the defect: "This is the only reply notification you'll get from
//      me." Repointing the recipient without rewriting that would have sent an operator a
//      promise never to tell them again.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEDUP KEY IS THE SIGNAL ID
//
// subject_id = the signal that carried the reply. One reply event, one notification, and
// two runs over the same signal cannot double-send. signals.id is a uuid and subject_id is
// uuid NOT NULL, so it fits the column as it stands with no migration.
//
// The notification_type also changes, from 'first_reply' to 'reply_needs_action'. That is
// deliberate and it is what makes this safe to ship: the existing spent row is
// ('first_reply', <org id>), and nothing here can collide with it. The old row is simply
// inert. No backfill, no deletion, no migration.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT HAPPENS IF A SEND FAILS UNDER THE NEW KEY — READ THIS BEFORE CHANGING IT
//
// sendTransactionalEmailWithDedup writes the log row BEFORE it sends, and a send failure
// leaves the row behind. That trap is NOT fixed here, on purpose: it is its own row and its
// own fix, and changing it in the same pass as the key would be two live changes to one
// mechanism at once.
//
// Under the OLD key a single failed send permanently blocked every future reply
// notification for that organisation, because there was only ever one row to write.
//
// Under the NEW key a failed send blocks the notification FOR THAT ONE REPLY only. The next
// reply carries a different signal id, writes a different row, and sends normally. So the
// blast radius goes from "this client never hears about a reply again" to "one reply's
// notification is lost". That is strictly better, and it is why changing the key first is
// safe even with the ordering trap still live.
//
// It is not harmless. A lost notification is a reply the operator is not told about, and
// nothing retries it. What stops that being silent is MON-028, which reports the draft
// ageing in the queue regardless of whether any email was sent.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmailWithDedup } from './send-transactional-with-dedup'
import {
  operatorReplyTemplate,
  operatorReplyTemplateText,
  operatorReplySubject,
} from '@/lib/email/templates/operator-reply'

// Only events at or after this instant notify. Carried over from the module this replaces,
// for the same reason: without it, a backfill or a replay of historical signals would mail
// the operator once per row for every reply the system has ever seen.
const FEATURE_ACTIVATION_DATE = new Date('2026-07-27').toISOString()

const NOTIFICATION_TYPE = 'reply_needs_action'

export interface SendOperatorReplyNotificationParams {
  supabase: SupabaseClient
  organisationId: string
  signalId: string
  prospectId: string | null
  classifiedIntent: string | null
  signalCreatedAt: string
}

export async function sendOperatorReplyNotification(
  params: SendOperatorReplyNotificationParams,
): Promise<{ sent: boolean }> {
  try {
    if (params.signalCreatedAt < FEATURE_ACTIVATION_DATE) {
      logger.info('operator reply notification: event predates activation, skipping', {
        signal_id: params.signalId,
        signal_created_at: params.signalCreatedAt,
      })
      return { sent: false }
    }

    // The client whose campaign this reply came from. Named in the subject so the operator
    // can tell two clients' replies apart in an inbox without opening either.
    const { data: org, error: orgError } = await params.supabase
      .from('organisations')
      .select('name')
      .eq('id', params.organisationId)
      .single()

    if (orgError || !org) {
      logger.error('operator reply notification: failed to read the organisation', {
        organisation_id: params.organisationId,
        error: orgError?.message,
      })
      return { sent: false }
    }

    let prospectName: string | null = null
    let prospectCompany: string | null = null
    if (params.prospectId) {
      const { data: prospect } = await params.supabase
        .from('prospects')
        .select('first_name, company_name')
        .eq('id', params.prospectId)
        .single()

      if (prospect) {
        prospectName = prospect.first_name
        prospectCompany = prospect.company_name
      }
    }

    // THE OPERATOR, not the client. ADR-021: operator lookups are cross-organisation, so
    // this is deliberately not filtered by organisation_id — the operator does not belong
    // to the client's organisation.
    const { data: operator, error: operatorError } = await params.supabase
      .from('users')
      .select('email')
      .eq('role', 'operator')
      .limit(1)
      .single()

    if (operatorError || !operator?.email) {
      // Loud. If no operator can be resolved, nobody is being told a prospect replied, and
      // that is the exact silence this module exists to end.
      logger.error('operator reply notification: no operator email could be resolved', {
        organisation_id: params.organisationId,
        signal_id: params.signalId,
        error: operatorError?.message,
      })
      return { sent: false }
    }

    const templateParams = {
      clientName: org.name,
      prospectName,
      prospectCompany,
      classifiedIntent: params.classifiedIntent,
    }

    const result = await sendTransactionalEmailWithDedup({
      supabase: params.supabase,
      organisationId: params.organisationId,
      notificationType: NOTIFICATION_TYPE,
      // One notification per REPLY EVENT. See the header for what a failed send does here.
      subjectId: params.signalId,
      to: operator.email,
      subject: operatorReplySubject(templateParams),
      html: operatorReplyTemplate(templateParams),
      text: operatorReplyTemplateText(templateParams),
    })

    return { sent: result.sent }
  } catch (err) {
    // Never throws. This runs inside reply processing, and a notification failure must not
    // stop a reply being handled or leave the signal to retry for a reason unrelated to it.
    logger.error('operator reply notification: error', {
      organisation_id: params.organisationId,
      signal_id: params.signalId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false }
  }
}
