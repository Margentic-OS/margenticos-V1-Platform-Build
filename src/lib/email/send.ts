import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { resendClient } from './client'

const isDev = process.env.NODE_ENV === 'development'

function getFromAddress(): string {
  if (process.env.RESEND_FROM_EMAIL) {
    return process.env.RESEND_FROM_EMAIL
  }
  if (isDev) {
    return 'onboarding@resend.dev'
  }
  throw new Error(
    'RESEND_FROM_EMAIL is required in non-development environments. ' +
    'Current NODE_ENV: ' + process.env.NODE_ENV
  )
}

interface SendEmailParams {
  to: string
  subject: string
  html: string
  text?: string
}

type SendResult =
  | { success: true; messageId: string }
  | { success: false; error: string }

export async function sendTransactionalEmail(params: SendEmailParams): Promise<SendResult> {
  const from = getFromAddress()

  const { data, error } = await resendClient.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    ...(params.text ? { text: params.text } : {}),
  })

  if (error || !data) {
    const message = error?.message ?? 'Unknown Resend error'
    logger.error('sendTransactionalEmail failed', { to: params.to, subject: params.subject, error: message })
    Sentry.captureException(new Error(`Resend send failed: ${message}`), {
      extra: { to: params.to, subject: params.subject },
    })
    return { success: false, error: message }
  }

  logger.info('sendTransactionalEmail succeeded', { to: params.to, subject: params.subject, messageId: data.id })
  return { success: true, messageId: data.id }
}
