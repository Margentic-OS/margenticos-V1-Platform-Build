// POST /api/webhooks/cal-com
//
// Cal.com booking notifications. Replaces the Calendly route, deleted 2026-09-11 (ADR-056).
//
// THE SIGNATURE IS THE AUTHENTICATION. A webhook carries no user session, so this route
// verifies x-cal-signature-256 against CALCOM_WEBHOOK_SECRET over the RAW request body, and
// only then touches the database, through the service-role client. The middleware matcher
// excludes all of /api, so no session check runs ahead of this (middleware-scope.test.ts).
//
// ANSWERS
//   401  signature missing, malformed or wrong. Nothing is read or written.
//   500  secret not configured, or the database failed while recording. The provider may
//        try again, and that is safe: a repeated delivery is a no-op.
//   400  signed, but not JSON, or a booking event with no booking uid.
//   200  recorded, already recorded, quarantined, or an event deliberately ignored. Every
//        trigger other than created, cancelled and rescheduled is ignored, meeting-ended
//        included, because it fires whether or not anyone attended.
//
// EVERY REFUSAL SAYS WHICH ONE IT WAS. "Our secret is not set", "Cal.com sent no signature",
// "the signature is not a real one" and "the two secrets differ" look identical from outside,
// and nobody can read either secret back to compare. So each carries a reason code in the
// response, and a Sentry record (which emails the operator) naming the reason in plain words
// and describing our secret by presence and length only. The value is never logged,
// returned or sent anywhere. route-refusals.test.ts proves both halves.
//
// It never answers 200 while discarding a booking: see record-booking-event.ts.

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { recordBookingEvent } from '@/lib/meetings/record-booking-event'
import {
  CAL_COM_PROVIDER,
  CAL_COM_SIGNATURE_HEADER,
  checkCalComSignature,
  parseCalComEvent,
  SIGNATURE_REFUSAL_EXPLANATION,
  type SignatureRefusal,
} from '@/lib/integrations/handlers/cal-com/webhook'

type Refusal = 'secret_not_configured' | SignatureRefusal

// The signature explanations name the vendor, so they come from the handler (ADR-001).
const REFUSAL_EXPLANATION: Record<Refusal, string> = {
  secret_not_configured:
    'CALCOM_WEBHOOK_SECRET is not set on this deployment, so no delivery can be verified. Set it in Vercel for this environment and redeploy.',
  ...SIGNATURE_REFUSAL_EXPLANATION,
}

// Describes our secret without revealing it. A value pasted with a trailing newline or space
// signs differently from the copy Cal.com holds; the two lengths differing is how that shows
// up here without either value ever being printed.
function describeSecret(secret: string | undefined) {
  return {
    secret_present: Boolean(secret),
    secret_length: secret?.length ?? 0,
    secret_trimmed_length: secret?.trim().length ?? 0,
  }
}

function refuse(reason: Refusal, secret: string | undefined, header: string | null): NextResponse {
  const record = {
    reason,
    explanation: REFUSAL_EXPLANATION[reason],
    ...describeSecret(secret),
    signature_header_present: header !== null,
    signature_header_length: header?.length ?? 0,
  }
  const notConfigured = reason === 'secret_not_configured'

  if (notConfigured) logger.error('cal-com webhook: delivery refused', record)
  else logger.warn('cal-com webhook: delivery refused', record)

  // Grouped by message, so a flood of bad requests is one Sentry issue with a count, not a
  // thousand operator emails.
  Sentry.captureMessage(`cal-com webhook refused: ${reason}`, {
    level: notConfigured ? 'error' : 'warning',
    extra: record,
  })

  return NextResponse.json(
    { error: notConfigured ? 'Webhook secret not configured' : 'Invalid signature', reason },
    { status: notConfigured ? 500 : 401 },
  )
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CALCOM_WEBHOOK_SECRET
  const header = request.headers.get(CAL_COM_SIGNATURE_HEADER)

  if (!secret) return refuse('secret_not_configured', secret, header)

  // The exact bytes received, before anything parses them. The signature covers these.
  const rawBody = await request.text()

  const signature = checkCalComSignature(rawBody, header, secret)
  if (!signature.ok) return refuse(signature.reason, secret, header)

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    logger.warn('cal-com webhook: signed delivery is not valid JSON')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = parseCalComEvent(body)

  if (event.kind === 'ignored') {
    logger.info('cal-com webhook: event ignored', { trigger: event.trigger })
    return NextResponse.json({ ignored: event.trigger })
  }

  if (event.kind === 'malformed') {
    logger.error('cal-com webhook: signed delivery could not be read as a booking', { reason: event.reason })
    Sentry.captureMessage(`cal-com webhook: malformed booking event: ${event.reason}`)
    return NextResponse.json({ error: event.reason }, { status: 400 })
  }

  try {
    const supabase = await createServiceRoleClient()
    const result = await recordBookingEvent(supabase, event, CAL_COM_PROVIDER)
    return NextResponse.json(result)
  } catch (error) {
    logger.error('cal-com webhook: recording failed', {
      booking_uid: event.bookingUid,
      error: error instanceof Error ? error.message : String(error),
    })
    Sentry.captureException(error, { extra: { webhook: 'cal-com', booking_uid: event.bookingUid } })
    return NextResponse.json({ error: 'Recording failed' }, { status: 500 })
  }
}
