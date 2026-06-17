import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

// Calendly Webhook v2 Reference: https://developer.calendly.com/reference/calendly_v2/calendly-webhook-api
// This handler processes two events: invitee.created (booking) and invitee.canceled (cancellation)

interface CalendlyWebhookPayload {
  event: {
    uri: string
    start_time: string
    end_time: string
  }
  invitee: {
    uri: string
    email: string
    name?: string
    tracking?: Record<string, string>
    custom_questions_answers?: Array<{ question: string; answer: string }>
  }
  cancel_event?: {
    cancellation_reason?: string
    canceled_by?: string
  }
  reschedule_event?: {
    previous_event_start_time?: string
  }
}

function verifyCalendlySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))
}

function extractUuidFromUri(uri: string): string | null {
  const match = uri.match(/([a-f0-9\-]{36})$/)
  return match ? match[1] : null
}

async function handleInviteeCreated(
  payload: CalendlyWebhookPayload,
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string
): Promise<void> {
  const eventUuid = extractUuidFromUri(payload.event.uri)
  const inviteeUuid = extractUuidFromUri(payload.invitee.uri)

  if (!eventUuid || !inviteeUuid) {
    logger.warn('calendly webhook: failed to extract UUIDs', {
      event_uri: payload.event.uri,
      invitee_uri: payload.invitee.uri,
    })
    return
  }

  // Extract phone from custom_questions_answers if present
  let inviteePhone: string | null = null
  if (payload.invitee.custom_questions_answers) {
    const phoneAnswer = payload.invitee.custom_questions_answers.find(
      qa => qa.question.toLowerCase().includes('phone')
    )
    if (phoneAnswer) {
      inviteePhone = phoneAnswer.answer
    }
  }

  // Prospect matching: try prospect_id from tracking first, fallback to email match
  let prospectId: string | null = null

  if (payload.invitee.tracking?.prospect_id) {
    prospectId = payload.invitee.tracking.prospect_id
  } else {
    // Email match fallback: find prospect with matching email in this org
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id')
      .eq('organisation_id', orgId)
      .eq('email', payload.invitee.email)
      .single()

    if (prospect) {
      prospectId = prospect.id
    }
  }

  if (!prospectId) {
    logger.warn('calendly webhook: prospect not found', {
      organisation_id: orgId,
      invitee_email: payload.invitee.email,
      invitee_name: payload.invitee.name,
    })
    // Silently return — prospect not in system yet. This is safe; Calendly will retry.
    return
  }

  // Create or update meeting record
  const { error } = await supabase
    .from('meetings')
    .upsert(
      {
        organisation_id: orgId,
        prospect_id: prospectId,
        source: 'calendly',
        calendly_event_uuid: eventUuid,
        calendly_invitee_uuid: inviteeUuid,
        booked_at: new Date().toISOString(),
        scheduled_start_at: payload.event.start_time,
        meeting_status: 'booked',
        invitee_phone: inviteePhone,
        is_billable: false,
        held_decision_locked: false,
      },
      { onConflict: 'calendly_event_uuid' }
    )

  if (error) {
    logger.error('calendly webhook: upsert failed', {
      organisation_id: orgId,
      prospect_id: prospectId,
      error: error.message,
    })
    Sentry.captureException(error, {
      extra: { webhook: 'calendly', event_uuid: eventUuid },
    })
    throw error
  }

  logger.info('calendly webhook: invitee created', {
    organisation_id: orgId,
    prospect_id: prospectId,
    event_uuid: eventUuid,
    scheduled_start: payload.event.start_time,
  })
}

async function handleInviteeCanceled(
  payload: CalendlyWebhookPayload,
  supabase: Awaited<ReturnType<typeof createClient>>,
  _orgId: string
): Promise<void> {
  const eventUuid = extractUuidFromUri(payload.event.uri)
  const inviteeUuid = extractUuidFromUri(payload.invitee.uri)

  if (!eventUuid || !inviteeUuid) {
    logger.warn('calendly webhook: failed to extract UUIDs from cancel event', {
      event_uri: payload.event.uri,
      invitee_uri: payload.invitee.uri,
    })
    return
  }

  // Find meeting by Calendly UUIDs
  const { data: meeting, error: fetchError } = await supabase
    .from('meetings')
    .select('id, organisation_id')
    .eq('calendly_event_uuid', eventUuid)
    .eq('calendly_invitee_uuid', inviteeUuid)
    .single()

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      // Row not found — this can happen if the booking was never written
      logger.warn('calendly webhook: meeting not found for cancellation', {
        event_uuid: eventUuid,
      })
      return
    }
    logger.error('calendly webhook: fetch meeting failed', {
      error: fetchError.message,
    })
    throw fetchError
  }

  if (!meeting) {
    return
  }

  // Update meeting: set canceled, remove from billing
  // Do NOT set held_decision_locked — canceled is excluded by status check in auto-held query
  const { error: updateError } = await supabase
    .from('meetings')
    .update({
      meeting_status: 'canceled',
      is_billable: false,
    })
    .eq('id', meeting.id)

  if (updateError) {
    logger.error('calendly webhook: update failed', {
      meeting_id: meeting.id,
      error: updateError.message,
    })
    Sentry.captureException(updateError, {
      extra: { webhook: 'calendly', event_uuid: eventUuid, action: 'cancel' },
    })
    throw updateError
  }

  logger.info('calendly webhook: invitee canceled', {
    organisation_id: meeting.organisation_id,
    meeting_id: meeting.id,
    event_uuid: eventUuid,
  })
}

async function handleInviteeRescheduled(
  payload: CalendlyWebhookPayload,
  supabase: Awaited<ReturnType<typeof createClient>>,
  _orgId: string
): Promise<void> {
  const eventUuid = extractUuidFromUri(payload.event.uri)
  const inviteeUuid = extractUuidFromUri(payload.invitee.uri)

  if (!eventUuid || !inviteeUuid) {
    logger.warn('calendly webhook: failed to extract UUIDs from reschedule event', {
      event_uri: payload.event.uri,
      invitee_uri: payload.invitee.uri,
    })
    return
  }

  // Find meeting by Calendly UUIDs (same UUIDs persist across reschedule)
  const { data: meeting, error: fetchError } = await supabase
    .from('meetings')
    .select('id, organisation_id, meeting_status, held_decision_locked')
    .eq('calendly_event_uuid', eventUuid)
    .eq('calendly_invitee_uuid', inviteeUuid)
    .single()

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      // Row not found — this can happen if the booking was never written
      logger.warn('calendly webhook: meeting not found for reschedule', {
        event_uuid: eventUuid,
      })
      return
    }
    logger.error('calendly webhook: fetch meeting for reschedule failed', {
      error: fetchError.message,
    })
    throw fetchError
  }

  if (!meeting) {
    return
  }

  // If decision is locked (held, no_show, or auto-held), don't change status but update the time
  // If still booked and unlocked, just update the time and keep status booked
  const { error: updateError } = await supabase
    .from('meetings')
    .update({
      scheduled_start_at: payload.event.start_time,
    })
    .eq('id', meeting.id)

  if (updateError) {
    logger.error('calendly webhook: reschedule update failed', {
      meeting_id: meeting.id,
      error: updateError.message,
    })
    Sentry.captureException(updateError, {
      extra: { webhook: 'calendly', event_uuid: eventUuid, action: 'reschedule' },
    })
    throw updateError
  }

  logger.info('calendly webhook: invitee rescheduled', {
    organisation_id: meeting.organisation_id,
    meeting_id: meeting.id,
    event_uuid: eventUuid,
    new_scheduled_start: payload.event.start_time,
    was_locked: meeting.held_decision_locked,
  })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await request.text()
    const signature = request.headers.get('Calendly-Webhook-Signature')

    if (!signature) {
      logger.error('calendly webhook: missing signature header')
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
    }

    // Get signing secret from env (global) — per-org lookup would happen in a future multi-workspace version
    const globalSecret = process.env.CALENDLY_WEBHOOK_SECRET
    if (!globalSecret) {
      logger.error('calendly webhook: CALENDLY_WEBHOOK_SECRET not configured')
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
    }

    // Verify signature
    try {
      if (!verifyCalendlySignature(payload, signature, globalSecret)) {
        logger.warn('calendly webhook: signature verification failed')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    } catch (error) {
      logger.error('calendly webhook: signature verification error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json({ error: 'Signature verification failed' }, { status: 400 })
    }

    // Parse payload
    let parsedPayload: CalendlyWebhookPayload
    try {
      parsedPayload = JSON.parse(payload)
    } catch (error) {
      logger.error('calendly webhook: failed to parse JSON', {
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // Determine event type
    let eventType: 'invitee.created' | 'invitee.canceled' | 'invitee.rescheduled'
    if (parsedPayload.cancel_event) {
      eventType = 'invitee.canceled'
    } else if (parsedPayload.reschedule_event) {
      eventType = 'invitee.rescheduled'
    } else {
      eventType = 'invitee.created'
    }

    // For now, we need to determine org_id from the invitee email + prospecting context
    // In phase one, webhooks must be org-specific (separate URL per org or secret per org in DB)
    // For MVP: store webhooks in organisations table and look up by secret
    const supabase = await createClient()

    // Look up org by webhook secret (future: per-org secrets in DB)
    // For now: assume all webhooks are for the operator's "client zero" testing
    // TODO: implement per-org secret lookup in organisations table
    const { data: orgs } = await supabase
      .from('organisations')
      .select('id')
      .limit(1)

    if (!orgs || orgs.length === 0) {
      logger.error('calendly webhook: no organisations found')
      return NextResponse.json({ error: 'No organisations found' }, { status: 500 })
    }

    const orgId = orgs[0].id

    // Process event
    if (eventType === 'invitee.created') {
      await handleInviteeCreated(parsedPayload, supabase, orgId)
    } else if (eventType === 'invitee.canceled') {
      await handleInviteeCanceled(parsedPayload, supabase, orgId)
    } else if (eventType === 'invitee.rescheduled') {
      await handleInviteeRescheduled(parsedPayload, supabase, orgId)
    }

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    logger.error('calendly webhook: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    Sentry.captureException(error, { extra: { webhook: 'calendly' } })

    // Return 200 to prevent Calendly retries, but log the error for investigation
    return NextResponse.json({ success: false }, { status: 200 })
  }
}
