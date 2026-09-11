// Tells the operator about a booking that could not be tied to a prospect, or that arrived
// on a booking calendar belonging to no client.
//
// The booking is ALREADY RECORDED before this runs (record-booking-event.ts). This email is
// how a person finds out it needs a look, so a failure here is logged and never undoes or
// blocks the record. Best effort, like every other operator alert.

import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import {
  unmatchedBookingSubject,
  unmatchedBookingTemplate,
  type UnmatchedBookingNotice,
} from '@/lib/email/templates/unmatched-booking'

export type { UnmatchedBookingNotice }

export async function sendUnmatchedBookingNotification(
  notice: UnmatchedBookingNotice,
): Promise<{ sent: boolean }> {
  const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
  if (!operatorEmail) {
    logger.warn('unmatched booking: RESEND_OPERATOR_EMAIL not set, operator not told (the booking IS recorded)', {
      reason: notice.reason,
      booking_uid: notice.bookingUid,
    })
    return { sent: false }
  }

  try {
    const result = await sendTransactionalEmail({
      to: operatorEmail,
      // Internal alert. Exempt from the customer-facing style rules, never from the
      // rendering checks. See EmailAudience in src/lib/email/send.ts.
      audience: 'operator',
      subject: unmatchedBookingSubject(notice),
      html: unmatchedBookingTemplate(notice),
    })
    if (!result.success) {
      logger.error('unmatched booking: operator email failed (the booking IS recorded)', {
        reason: notice.reason,
        booking_uid: notice.bookingUid,
        error: result.error,
      })
    }
    return { sent: result.success }
  } catch (error) {
    logger.error('unmatched booking: operator email threw (the booking IS recorded)', {
      reason: notice.reason,
      booking_uid: notice.bookingUid,
      error: error instanceof Error ? error.message : String(error),
    })
    return { sent: false }
  }
}
