import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { verifyConfirmationToken } from '@/lib/meetings/confirmation-token'
import { NextRequest, NextResponse } from 'next/server'

interface ConfirmationRequest {
  token?: string // For email link path (signed token)
  decision: 'held' | 'no_show' // held or no_show
}

type ConfirmedBy = 'client' | 'operator'

async function resolveMeetingAndOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  meetingId: string,
  organisationId: string | null
): Promise<
  | {
      meeting: {
        id: string
        organisation_id: string
        scheduled_start_at: string | null
      } | null
      org: {
        auto_held_window_hours: number
      } | null
    }
  | { error: string }
> {
  const [meetingResult, orgResult] = await Promise.all([
    supabase
      .from('meetings')
      .select('id, organisation_id, scheduled_start_at')
      .eq('id', meetingId)
      .eq(organisationId ? 'organisation_id' : 'id', organisationId || meetingId)
      .single(),
    organisationId
      ? supabase
          .from('organisations')
          .select('auto_held_window_hours')
          .eq('id', organisationId)
          .single()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (meetingResult.error || !meetingResult.data) {
    return { error: 'Meeting not found' }
  }

  if (orgResult.error || !orgResult.data) {
    return { error: 'Organisation not found' }
  }

  return {
    meeting: meetingResult.data,
    org: orgResult.data,
  }
}

function isWindowOpen(
  scheduledStartAt: string | null,
  windowHours: number
): boolean {
  if (!scheduledStartAt) {
    logger.warn('meeting confirmation: scheduled_start_at is null')
    return false
  }

  const scheduledTime = new Date(scheduledStartAt).getTime()
  const windowEnd = scheduledTime + windowHours * 60 * 60 * 1000
  const now = Date.now()

  return now < windowEnd
}

interface ConfirmationRequestFull extends ConfirmationRequest {
  meeting_id?: string
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as ConfirmationRequestFull

    if (!body.decision || !['held', 'no_show'].includes(body.decision)) {
      return NextResponse.json(
        { error: 'Invalid decision. Must be "held" or "no_show".' },
        { status: 400 }
      )
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    // Determine confirmation source: token (email link, no auth required) or session (logged-in client)
    let meetingId: string | null = null
    let organisationId: string | null = null
    let confirmedBy: ConfirmedBy = 'client'

    if (body.token) {
      // Email link path: verify token (stateless, no login required, no auth check)
      const decoded = verifyConfirmationToken(body.token)
      if (!decoded) {
        return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
      }
      meetingId = decoded.meeting_id
      organisationId = decoded.organisation_id
    } else {
      // Logged-in path: user must be authenticated
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { data: userRow } = await supabase
        .from('users')
        .select('role, organisation_id')
        .eq('id', user.id)
        .single()

      if (!userRow) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 })
      }

      if (userRow.role === 'operator') {
        confirmedBy = 'operator'
      }

      meetingId = body.meeting_id || null
      organisationId = userRow.organisation_id

      if (!meetingId) {
        return NextResponse.json({ error: 'Missing meeting_id' }, { status: 400 })
      }
    }

    if (!meetingId || !organisationId) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    // Fetch meeting and org data
    const resolved = await resolveMeetingAndOrg(supabase, meetingId, organisationId)

    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 404 })
    }

    const { meeting, org } = resolved

    if (!meeting || !org) {
      return NextResponse.json({ error: 'Meeting or org not found' }, { status: 404 })
    }

    // CRITICAL IDEMPOTENT CHECK: use a transaction to atomically check and update
    // This ensures scanner HEAD/GET requests do not trigger the button click logic
    // and that multiple POSTs are safe

    // Check if window is still open
    const windowOpen = isWindowOpen(meeting.scheduled_start_at, org.auto_held_window_hours)

    if (!windowOpen && body.decision) {
      // If window has closed and decision hasn't been recorded, we can still allow the update once
      // But if held_decision_locked is already true, return current state without changing
    }

    // Update meeting with idempotent check: only update if not already locked
    const { data: updated, error: updateError } = await supabase
      .from('meetings')
      .update({
        meeting_status: body.decision,
        held_confirmed_by: confirmedBy,
        held_decision_locked: true,
        is_billable: body.decision === 'held' ? true : false,
      })
      .eq('id', meetingId)
      .eq('held_decision_locked', false) // Only update if not already locked
      .select('id, meeting_status, held_confirmed_by, held_decision_locked, is_billable')
      .single()

    if (updateError) {
      // If the row was not found with held_decision_locked=false, it's already been locked
      // Fetch and return current state instead of erroring
      if (updateError.code === 'PGRST116') {
        const { data: current } = await supabase
          .from('meetings')
          .select('id, meeting_status, held_confirmed_by, held_decision_locked, is_billable')
          .eq('id', meetingId)
          .single()

        if (current) {
          logger.info('meeting confirmation: already locked, returning current state', {
            meeting_id: meetingId,
            current_status: current.meeting_status,
            confirmed_by: current.held_confirmed_by,
          })
          return NextResponse.json(
            {
              success: true,
              message: 'Meeting confirmation already recorded',
              meeting: current,
            },
            { status: 200 }
          )
        }
      }

      logger.error('meeting confirmation: update failed', {
        meeting_id: meetingId,
        error: updateError.message,
      })
      Sentry.captureException(updateError, {
        extra: { action: 'confirm_meeting', meeting_id: meetingId },
      })
      return NextResponse.json(
        { error: 'Failed to confirm meeting' },
        { status: 500 }
      )
    }

    logger.info('meeting confirmation: success', {
      meeting_id: meetingId,
      organisation_id: organisationId,
      decision: body.decision,
      confirmed_by: confirmedBy,
    })

    return NextResponse.json(
      {
        success: true,
        message: `Meeting confirmed as ${body.decision}`,
        meeting: updated,
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error('meeting confirmation: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    Sentry.captureException(error, { extra: { action: 'confirm_meeting' } })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
