// POST /api/meetings/confirm
//
// Records whether a meeting happened: 'held' or 'no_show'. A human answer here is what makes
// a meeting billable before the monthly backstop (ADR-057).
//
// WHO MAY ANSWER
//   A client, through the signed link in the confirmation email, with no login. The token
//     names one meeting of one organisation.
//   A signed-in client, for a meeting of their own organisation.
//   An operator, for any organisation's meeting.
//
// NEVER A FALSE "RECORDED". This route used to write through the login-based client. Clients
// hold only SELECT on meetings, so a client's update touched 0 rows, and the route read those
// 0 rows as "already locked" and answered "Meeting confirmation already recorded" while nothing
// had been written. A client who said "no-show" was told it was recorded and the meeting
// stayed booked. Now the caller is identified first, the write goes through the service-role
// client scoped explicitly to that meeting and organisation, and every answer says plainly
// whether the decision was recorded. An update that touches no row is reported as NOT
// recorded, never as success. confirm-meeting.test.ts proves it.
//
// SCANNER SAFETY. Only POST is exported. An email security scanner that pre-fetches a link
// cannot change anything: the link opens a page, and the page's button posts here.

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import {
  ConfirmationSecretMissingError,
  verifyConfirmationToken,
} from '@/lib/meetings/confirmation-token'

type Decision = 'held' | 'no_show'
type DecidedBy = 'client' | 'operator'

interface ConfirmationRequest {
  token?: string
  meeting_id?: string
  decision?: string
}

interface Caller {
  decidedBy: DecidedBy
  meetingId: string
  /** null only for an operator, who may answer for any organisation. */
  organisationId: string | null
}

const DECISION_LABEL: Record<string, string> = {
  held: 'held (it happened)',
  no_show: 'a no-show',
  booked: 'still booked',
  canceled: 'cancelled',
  rescheduled: 'rescheduled',
}

function answer(status: number, recorded: boolean, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ recorded, message, ...extra }, { status })
}

async function identifyCaller(body: ConfirmationRequest): Promise<Caller | NextResponse> {
  if (body.token) {
    let decoded
    try {
      decoded = verifyConfirmationToken(body.token)
    } catch (error) {
      if (error instanceof ConfirmationSecretMissingError) {
        logger.error('meeting confirmation: JWT_SECRET is not configured, so no link can be checked')
        Sentry.captureMessage('meeting confirmation refused: secret_not_configured', 'error')
        return answer(500, false,
          'Meeting confirmation is not set up yet, so your answer was not recorded. Please reply to the email instead.',
          { reason: 'secret_not_configured' })
      }
      throw error
    }
    if (!decoded) {
      return answer(401, false, 'This confirmation link is invalid or has expired, so your answer was not recorded.',
        { reason: 'invalid_token' })
    }
    return { decidedBy: 'client', meetingId: decoded.meeting_id, organisationId: decoded.organisation_id }
  }

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return answer(401, false, 'Please sign in to record this.', { reason: 'not_signed_in' })

  const { data: userRow } = await session
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!userRow) return answer(403, false, 'Your account could not be found, so nothing was recorded.', { reason: 'unknown_user' })
  if (!body.meeting_id) return answer(400, false, 'Missing meeting_id, so nothing was recorded.', { reason: 'missing_meeting_id' })

  if (userRow.role === 'operator') return { decidedBy: 'operator', meetingId: body.meeting_id, organisationId: null }
  if (!userRow.organisation_id) return answer(403, false, 'Your account has no organisation, so nothing was recorded.', { reason: 'no_organisation' })
  return { decidedBy: 'client', meetingId: body.meeting_id, organisationId: userRow.organisation_id }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    let body: ConfirmationRequest
    try {
      body = (await request.json()) as ConfirmationRequest
    } catch {
      return answer(400, false, 'The request could not be read, so nothing was recorded.', { reason: 'invalid_json' })
    }

    if (body.decision !== 'held' && body.decision !== 'no_show') {
      return answer(400, false, 'Invalid decision. Must be "held" or "no_show".', { reason: 'invalid_decision' })
    }
    const decision: Decision = body.decision

    const caller = await identifyCaller(body)
    if (caller instanceof NextResponse) return caller

    const db = await createServiceRoleClient()

    let read = db
      .from('meetings')
      .select('id, organisation_id, meeting_status, held_decision_locked, held_confirmed_by, is_billable')
      .eq('id', caller.meetingId)
    if (caller.organisationId) read = read.eq('organisation_id', caller.organisationId)
    const { data: meeting, error: readError } = await read.maybeSingle()

    if (readError) {
      logger.error('meeting confirmation: meeting read failed', { meeting_id: caller.meetingId, error: readError.message })
      Sentry.captureException(readError, { extra: { action: 'confirm_meeting', meeting_id: caller.meetingId } })
      return answer(500, false, 'Something went wrong, so your answer was not recorded. Please try again.', { reason: 'read_failed' })
    }
    if (!meeting) {
      return answer(404, false, 'We could not find that meeting, so nothing was recorded.', { reason: 'not_found' })
    }

    if (meeting.held_decision_locked) {
      return answer(409, false,
        `This meeting is already recorded as ${DECISION_LABEL[meeting.meeting_status] ?? meeting.meeting_status}. Your answer was not recorded.`,
        { reason: 'already_decided', current: { meeting_status: meeting.meeting_status, decided_by: meeting.held_confirmed_by } })
    }
    if (meeting.meeting_status !== 'booked') {
      return answer(409, false,
        `This meeting is ${DECISION_LABEL[meeting.meeting_status] ?? meeting.meeting_status}, so an answer cannot be recorded for it.`,
        { reason: 'not_booked', current: { meeting_status: meeting.meeting_status } })
    }

    const { data: written, error: writeError } = await db
      .from('meetings')
      .update({
        meeting_status: decision,
        held_confirmed_by: caller.decidedBy,
        held_decision_locked: true,
        is_billable: decision === 'held',
      })
      .eq('id', meeting.id)
      .eq('organisation_id', meeting.organisation_id)
      .eq('held_decision_locked', false)
      .eq('meeting_status', 'booked')
      .select('id, meeting_status, held_confirmed_by, is_billable')

    if (writeError) {
      logger.error('meeting confirmation: write failed', { meeting_id: meeting.id, error: writeError.message })
      Sentry.captureException(writeError, { extra: { action: 'confirm_meeting', meeting_id: meeting.id } })
      return answer(500, false, 'Something went wrong, so your answer was not recorded. Please try again.', { reason: 'write_failed' })
    }

    if (!written || written.length === 0) {
      // No row was written. Say so. The only honest "already" is one read back just now.
      const { data: now } = await db
        .from('meetings')
        .select('meeting_status, held_decision_locked, held_confirmed_by')
        .eq('id', meeting.id)
        .maybeSingle()
      if (now?.held_decision_locked) {
        return answer(409, false,
          `This meeting was recorded as ${DECISION_LABEL[now.meeting_status] ?? now.meeting_status} a moment ago. Your answer was not recorded.`,
          { reason: 'already_decided', current: { meeting_status: now.meeting_status, decided_by: now.held_confirmed_by } })
      }
      logger.error('meeting confirmation: update touched no row and the meeting is still undecided', { meeting_id: meeting.id })
      Sentry.captureMessage('meeting confirmation: update touched no row', 'error')
      return answer(500, false, 'Something went wrong, so your answer was not recorded. Please try again.', { reason: 'not_written' })
    }

    logger.info('meeting confirmation: recorded', {
      meeting_id: meeting.id,
      organisation_id: meeting.organisation_id,
      decision,
      decided_by: caller.decidedBy,
    })
    return answer(200, true, `Recorded: the meeting was ${DECISION_LABEL[decision]}.`, { meeting: written[0] })
  } catch (error) {
    logger.error('meeting confirmation: unhandled error', { error: error instanceof Error ? error.message : String(error) })
    Sentry.captureException(error, { extra: { action: 'confirm_meeting' } })
    return answer(500, false, 'Something went wrong, so your answer was not recorded. Please try again.', { reason: 'unhandled' })
  }
}
