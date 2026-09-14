// Tells the operator which meetings are about to bill unconfirmed, while there is still time
// to chase the client.
//
// Best effort, like every other operator alert: a failure here is logged and never stops the
// sweep or changes a meeting. The same list is on the operator meetings screen, so this email
// is the prompt to go and look, not the only copy of the information.

import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import {
  meetingsDueToBillSubject,
  meetingsDueToBillTemplate,
  type DueToBillRow,
} from '@/lib/email/templates/meetings-due-to-bill'

export type { DueToBillRow }

export async function sendDueToBillNotification(
  rows: DueToBillRow[],
): Promise<{ sent: boolean }> {
  if (rows.length === 0) return { sent: false }

  const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
  if (!operatorEmail) {
    logger.warn('meetings due to bill: RESEND_OPERATOR_EMAIL not set, operator not told', {
      meetings: rows.length,
      never_asked: rows.filter(row => row.neverAsked).length,
    })
    return { sent: false }
  }

  try {
    const result = await sendTransactionalEmail({
      to: operatorEmail,
      // Internal alert. Exempt from the customer-facing style rules, never from the
      // rendering checks. See EmailAudience in src/lib/email/send.ts.
      audience: 'operator',
      subject: meetingsDueToBillSubject(rows),
      html: meetingsDueToBillTemplate(rows),
    })
    if (!result.success) {
      logger.error('meetings due to bill: operator email failed', {
        meetings: rows.length,
        error: result.error,
      })
    }
    return { sent: result.success }
  } catch (error) {
    logger.error('meetings due to bill: operator email threw', {
      meetings: rows.length,
      error: error instanceof Error ? error.message : String(error),
    })
    return { sent: false }
  }
}
