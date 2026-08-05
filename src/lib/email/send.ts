import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { resendClient } from './client'

const isDev = process.env.NODE_ENV === 'development'

// Word-boundary pattern for undefined/null/NaN detection.
// Matches literal instances only (not substrings in URLs or object IDs).
const UNDEFINED_PATTERN = /\bundefined\b/gi
const NULL_PATTERN = /\bnull\b/gi
const NAN_PATTERN = /\bNaN\b/gi
const EM_DASH_PATTERN = /—/g
const EN_DASH_PATTERN = /–/g

function validateEmailContent(subject: string, html: string, text?: string): string | null {
  const toCheck = [subject, html, ...(text ? [text] : [])]

  for (const content of toCheck) {
    if (UNDEFINED_PATTERN.test(content)) {
      return `Email contains literal "undefined" string`
    }
    if (NULL_PATTERN.test(content)) {
      return `Email contains literal "null" string`
    }
    if (NAN_PATTERN.test(content)) {
      return `Email contains literal "NaN" string`
    }
    if (EM_DASH_PATTERN.test(content)) {
      return `Email contains em dash (—) — use colon or comma instead`
    }
    if (EN_DASH_PATTERN.test(content)) {
      return `Email contains en dash (–) — use colon or comma instead`
    }
  }

  return null
}

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

function getReplyTo(): string | undefined {
  return process.env.REPLY_TO_EMAIL || process.env.RESEND_FROM_EMAIL || undefined
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
  const replyTo = getReplyTo()

  // Validate email content for undefined/null/NaN strings before sending.
  // This catches template rendering failures where variables were not provided.
  const validationError = validateEmailContent(params.subject, params.html, params.text)
  if (validationError) {
    const message = `Email content validation failed: ${validationError}`
    logger.error('sendTransactionalEmail: content validation failed', {
      to: params.to,
      subject: params.subject,
      error: validationError,
    })
    Sentry.captureException(new Error(message), {
      extra: {
        to: params.to,
        subject: params.subject,
        validation_error: validationError,
        html_length: params.html.length,
        text_length: params.text?.length ?? 0,
      },
      tags: {
        component: 'sendTransactionalEmail',
        error_type: 'content_validation',
      },
    })
    try {
      await Sentry.flush(2000)
    } catch {}
    return { success: false, error: message }
  }

  // Test override: if TEST_EMAIL_RECIPIENT is set, redirect all emails to it
  // Used during staging/testing to avoid sending real emails to real addresses
  const testRecipient = process.env.TEST_EMAIL_RECIPIENT
  const finalTo = testRecipient || params.to

  if (testRecipient) {
    logger.info('sendTransactionalEmail: test recipient override active', {
      intended_to: params.to,
      test_to: testRecipient,
      subject: params.subject,
    })
  }

  const { data, error } = await resendClient.emails.send({
    from,
    to: finalTo,
    subject: params.subject,
    html: params.html,
    ...(params.text ? { text: params.text } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  })

  if (error || !data) {
    const message = error?.message ?? 'Unknown Resend error'
    logger.error('sendTransactionalEmail failed', { to: params.to, subject: params.subject, error: message })
    Sentry.captureException(new Error(`Resend send failed: ${message}`), {
      extra: { to: params.to, subject: params.subject },
    })
    // Flush before returning — serverless containers freeze on return, dropping buffered events.
    try { await Sentry.flush(2000) } catch {}
    return { success: false, error: message }
  }

  logger.info('sendTransactionalEmail succeeded', { to: params.to, subject: params.subject, messageId: data.id })
  return { success: true, messageId: data.id }
}
