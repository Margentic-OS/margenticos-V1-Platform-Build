import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { resendClient } from './client'
import { recordEmailDeliveryFailure, type EmailDeliveryFailure } from './record-delivery-failure'
import { assertOperatorRecipient } from './recipient-audience'

const isDev = process.env.NODE_ENV === 'development'

// ─── WHO THE EMAIL IS FOR, AND WHY IT DECIDES WHICH RULES APPLY ──────────────
//
// 'customer'  reaches a client or a prospect. The full rule set applies, dashes included.
// 'operator'  reaches doug@margenticos.com and nobody else. Rendering checks apply;
//             the AI-tell style rules do not.
//
// The dash ban exists because MargenticOS's ICP is founder-led consulting firms burned by
// AI email, and an em dash is the most recognisable tell (CLAUDE.md, "Style rules for all
// generated content", which scopes itself to output that "reaches a client or prospect").
// An internal alert reaches neither. Applying a prospect-facing style rule to an internal
// alert was a category error, and it cost every operator notification this system has ever
// tried to send.
//
// DEFAULT IS 'customer', so an unlabelled email gets the strict rules. Forgetting the
// label can only ever make an email stricter, never laxer, and with the failure now
// recorded a wrongly-blocked email announces itself instead of vanishing.
export type EmailAudience = 'operator' | 'customer'

// NO `g` FLAG. These are used with .test(), and a global regex carries lastIndex between
// calls, so the same pattern against the same string returns true, then false, then true.
// Measured on 2026-09-07: /—/g .test('MargenticOS — Operator Alert') returns true, then
// false, then true. The patterns are module-level, so that state persisted ACROSS EMAILS.
// The validator was therefore not merely too strict, it was NON-DETERMINISTIC: it blocked
// roughly every other offending email and let the ones in between through. Any attempt to
// reason about which emails were rejected before this commit has to account for that.
const UNDEFINED_PATTERN = /\bundefined\b/i
const NULL_PATTERN = /\bnull\b/i
const NAN_PATTERN = /\bNaN\b/i
const EM_DASH_PATTERN = /—/
const EN_DASH_PATTERN = /–/

export function validateEmailContent(
  subject: string,
  html: string,
  text?: string,
  audience: EmailAudience = 'customer',
): string | null {
  const toCheck = [subject, html, ...(text ? [text] : [])]

  for (const content of toCheck) {
    // Rendering checks. These catch a template that was handed a missing variable, which
    // is a bug in any email whoever reads it, so they apply to both audiences.
    if (UNDEFINED_PATTERN.test(content)) {
      return `Email contains literal "undefined" string`
    }
    if (NULL_PATTERN.test(content)) {
      return `Email contains literal "null" string`
    }
    if (NAN_PATTERN.test(content)) {
      return `Email contains literal "NaN" string`
    }

    // Style checks. Customer-facing only, per the block comment above.
    if (audience === 'customer') {
      if (EM_DASH_PATTERN.test(content)) {
        return `Email contains em dash (—) — use colon or comma instead`
      }
      if (EN_DASH_PATTERN.test(content)) {
        return `Email contains en dash (–) — use colon or comma instead`
      }
    }
  }

  return null
}

// recordEmailDeliveryFailure guards itself, but the "sendTransactionalEmail never throws"
// contract is load-bearing and must not depend on a promise made in another module. If a
// future edit moves a line outside that module's try block, this keeps the contract.
async function recordFailureQuietly(failure: EmailDeliveryFailure): Promise<void> {
  try {
    await recordEmailDeliveryFailure(failure)
  } catch {
    // Deliberately empty. There is nowhere left to report to: the email channel is the
    // thing that just failed, and the durable channel is what threw.
  }
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
  /** Defaults to 'customer', the strict choice. See EmailAudience above. */
  audience?: EmailAudience
}

type SendResult =
  | { success: true; messageId: string }
  | { success: false; error: string }

export async function sendTransactionalEmail(params: SendEmailParams): Promise<SendResult> {
  const from = getFromAddress()
  const replyTo = getReplyTo()
  const audience = params.audience ?? 'customer'

  // Validate email content for undefined/null/NaN strings before sending.
  // This catches template rendering failures where variables were not provided.
  // Style rules apply to customer-facing mail only, per EmailAudience above.
  const validationError = validateEmailContent(params.subject, params.html, params.text, audience)
  if (validationError) {
    const message = `Email content validation failed: ${validationError}`
    logger.error('sendTransactionalEmail: content validation failed', {
      to: params.to,
      subject: params.subject,
      audience,
      error: validationError,
    })
    Sentry.captureException(new Error(message), {
      extra: {
        to: params.to,
        subject: params.subject,
        audience,
        validation_error: validationError,
        html_length: params.html.length,
        text_length: params.text?.length ?? 0,
      },
      tags: {
        component: 'sendTransactionalEmail',
        error_type: 'content_validation',
      },
    })
    // The durable half. The log line and the Sentry event above both fired on 2026-09-05
    // and the failure still went unnoticed for two days, because both need somebody to go
    // and look. This row is read by MON-030 on every sweep.
    await recordFailureQuietly({
      to: params.to,
      subject: params.subject,
      stage: 'content_validation',
      error: validationError,
      audience,
    })
    try {
      await Sentry.flush(2000)
    } catch {}
    return { success: false, error: message }
  }

  // ── Test override: NEVER honoured in production ─────────────────────────────
  //
  // TEST_EMAIL_RECIPIENT redirects EVERY email in the system to one address. It is meant
  // for staging, and until 2026-09-07 it was read unconditionally, production included,
  // with no guard of any kind. Set to a client's address in production it would have
  // delivered that client every agent failure with its raw error text, every other
  // client's alerts, and every reply notification. It was unset, which is the only reason
  // this was never an incident.
  //
  // It REFUSES TO SEND rather than quietly falling back to the real recipient. Falling
  // back would be the safe delivery and the unsafe signal: mail would keep flowing while
  // a production environment carried a staging override primed to misfire, and nothing
  // would ever reveal it. A hard stop cannot be mistaken for normal operation.
  const testRecipient = process.env.TEST_EMAIL_RECIPIENT

  if (testRecipient && process.env.NODE_ENV === 'production') {
    const message =
      'TEST_EMAIL_RECIPIENT is set in production. Every email would be redirected to it, ' +
      'so this send was refused. Remove the variable from the production environment.'
    logger.error('sendTransactionalEmail: refusing to send, test override set in production', {
      intended_to: params.to,
      subject: params.subject,
    })
    await recordFailureQuietly({
      to: params.to,
      subject: params.subject,
      stage: 'recipient_refused',
      error: message,
      audience,
    })
    return { success: false, error: message }
  }

  const finalTo = testRecipient || params.to

  if (testRecipient) {
    logger.info('sendTransactionalEmail: test recipient override active', {
      intended_to: params.to,
      test_to: testRecipient,
      subject: params.subject,
    })
  }

  // ── An operator-only email may never reach a client address ─────────────────
  //
  // This rides the SAME audience flag the style rules use, deliberately. That flag already
  // means "this is internal", and it should carry both consequences: relaxed content rules
  // AND a stricter recipient. One label, so the two cannot drift apart.
  //
  // Checked against finalTo, not params.to, so the override path above is covered too.
  // That is the case where the two faults combine.
  //
  // Resolved from the database, never a domain literal. `endsWith('@margenticos.com')` is
  // a Rule Zero violation and breaks for real: a client on the operator's own domain would
  // pass a domain check while being exactly the wrong recipient.
  if (audience === 'operator') {
    const verdict = await assertOperatorRecipient(finalTo)
    if (!verdict.ok) {
      const message = `Operator email blocked: ${verdict.reason}`
      logger.error('sendTransactionalEmail: operator recipient rejected', {
        subject: params.subject,
        reason: verdict.reason,
      })
      await recordFailureQuietly({
        to: finalTo,
        subject: params.subject,
        stage: 'recipient_refused',
        error: message,
        audience,
      })
      return { success: false, error: message }
    }
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
      extra: { to: params.to, subject: params.subject, audience },
    })
    // Recorded for the same reason as the validation failure above. A provider outage and
    // a rejected template are the same thing to the operator waiting on the alert.
    await recordFailureQuietly({
      to: params.to,
      subject: params.subject,
      stage: 'provider_send',
      error: message,
      audience,
    })
    // Flush before returning — serverless containers freeze on return, dropping buffered events.
    try { await Sentry.flush(2000) } catch {}
    return { success: false, error: message }
  }

  logger.info('sendTransactionalEmail succeeded', { to: params.to, subject: params.subject, messageId: data.id })
  return { success: true, messageId: data.id }
}
