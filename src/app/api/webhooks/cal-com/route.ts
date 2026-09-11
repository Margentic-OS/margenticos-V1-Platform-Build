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
//   401  signature missing or wrong. Nothing is read or written.
//   500  secret not configured, or the database failed while recording. The provider may
//        try again, and that is safe: a repeated delivery is a no-op.
//   400  signed, but not JSON, or a booking event with no booking uid.
//   200  recorded, already recorded, quarantined, or an event deliberately ignored. Every
//        trigger other than created, cancelled and rescheduled is ignored, meeting-ended
//        included, because it fires whether or not anyone attended.
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
  parseCalComEvent,
  verifyCalComSignature,
} from '@/lib/integrations/handlers/cal-com/webhook'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CALCOM_WEBHOOK_SECRET
  if (!secret) {
    logger.error('cal-com webhook: CALCOM_WEBHOOK_SECRET is not set, refusing every delivery')
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
  }

  // The exact bytes received, before anything parses them. The signature covers these.
  const rawBody = await request.text()

  if (!verifyCalComSignature(rawBody, request.headers.get(CAL_COM_SIGNATURE_HEADER), secret)) {
    logger.warn('cal-com webhook: signature missing or invalid, delivery rejected')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

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
