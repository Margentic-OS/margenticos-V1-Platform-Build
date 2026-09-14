// Asks the client whether a meeting happened, in one click, with no login.
//
// This is the PRIMARY path by which a meeting becomes billable (ADR-057). Attendance cannot
// be detected: Cal.com's automatic "didn't join" events fire only for its own video product
// and every client seat uses the client's own Meet, Teams or Zoom. So a person answers, or
// the monthly backstop applies. Nothing else decides.
//
// The link carries a signed token naming one meeting of one organisation. It expires AFTER
// the billing deadline, deliberately: a link that dies while the client still has time to
// answer would turn "we asked" into "they could not reply", and the backstop would then bill
// a meeting the client tried to dispute.
//
// A missing JWT_SECRET is reported as a failure, never swallowed. It means no client can be
// asked anything, and the backstop must not bill meetings nobody was asked about.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'
import { sendTransactionalEmailWithDedup } from './send-transactional-with-dedup'
import {
  ConfirmationSecretMissingError,
  generateConfirmationToken,
} from '@/lib/meetings/confirmation-token'
import { formatDeadline } from '@/lib/meetings/billing-deadline'
import {
  meetingConfirmationSubject,
  meetingConfirmationTemplate,
} from '@/lib/email/templates/meeting-confirmation'

/** Three days of slack past the deadline, so the link outlives the window it asks about. */
const GRACE_SECONDS = 3 * 24 * 60 * 60
const MINIMUM_LINK_LIFE_SECONDS = 7 * 24 * 60 * 60

export interface OutcomeConfirmationRequest {
  supabase: ServiceRoleClient
  organisationId: string
  /** The client's own company name, for the sign-off. */
  organisationName: string
  /** Who to greet. Falls back to the company name when no first name is recorded. */
  clientFirstName: string | null
  clientEmail: string
  meetingId: string
  prospectName: string | null
  scheduledStartAt: string | null
  deadline: Date
  /** null for the first ask; 0, 1, 2 for the reminders, counted back from the deadline. */
  reminderIndex: number | null
}

export type ConfirmationSendResult =
  | { sent: true }
  | { sent: false; reason: 'already_sent' | 'no_secret' | 'send_failed' | 'error' }

function describeMeetingTime(scheduledStartAt: string | null): string {
  if (!scheduledStartAt) return 'the time you booked'
  const when = new Date(scheduledStartAt)
  if (Number.isNaN(when.getTime())) return 'the time you booked'
  return when.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }) + ' at ' + when.toLocaleTimeString('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
  })
}

export async function sendOutcomeConfirmation(
  request: OutcomeConfirmationRequest,
): Promise<ConfirmationSendResult> {
  const {
    supabase, organisationId, organisationName, clientFirstName, clientEmail,
    meetingId, prospectName, scheduledStartAt, deadline, reminderIndex,
  } = request

  // The link must still work on the last day the client can use it.
  const secondsToDeadline = Math.floor((deadline.getTime() - Date.now()) / 1000) + GRACE_SECONDS
  const expiresIn = Math.max(MINIMUM_LINK_LIFE_SECONDS, secondsToDeadline)

  let token: string
  try {
    token = generateConfirmationToken(meetingId, organisationId, expiresIn)
  } catch (error) {
    if (error instanceof ConfirmationSecretMissingError) {
      // Loud, and it stops the backstop billing this meeting: nothing can be billed
      // unconfirmed unless confirmation_sent_at was actually stamped.
      logger.error('meeting outcome: cannot ask the client, JWT_SECRET is not configured', {
        organisation_id: organisationId,
        meeting_id: meetingId,
      })
      return { sent: false, reason: 'no_secret' }
    }
    throw error
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://margenticos-platform.vercel.app'
  const confirmationUrl = `${baseUrl}/confirm-meeting/${token}`

  const isReminder = reminderIndex !== null
  const subject = isReminder
    ? `Reminder: ${meetingConfirmationSubject()}`
    : meetingConfirmationSubject()

  try {
    const result = await sendTransactionalEmailWithDedup({
      supabase,
      organisationId,
      // Each ask is its own dedup key, so three reminders are three emails and a job that
      // runs twice in a day is still one of each.
      notificationType: isReminder ? `meeting_outcome_reminder_${reminderIndex}` : 'meeting_outcome_request',
      subjectId: meetingId,
      to: clientEmail,
      subject,
      html: meetingConfirmationTemplate({
        clientName: clientFirstName ?? organisationName,
        prospectName: prospectName ?? 'your prospect',
        meetingDate: describeMeetingTime(scheduledStartAt),
        windowClosesDate: formatDeadline(deadline),
        confirmationUrl,
        companyName: organisationName,
      }),
    })

    if (!result.sent) {
      return { sent: false, reason: result.reason === 'already_sent' || result.reason === 'race_condition' ? 'already_sent' : 'send_failed' }
    }
    return { sent: true }
  } catch (error) {
    logger.error('meeting outcome: confirmation send threw', {
      organisation_id: organisationId,
      meeting_id: meetingId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { sent: false, reason: 'error' }
  }
}
