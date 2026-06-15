import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

// Auto-held resolution: Dashboard-load fallback (MVP approach when pg_cron is not scheduled)
// Resolves meetings past their scheduled_start_at + auto_held_window_hours window.
// Formula: scheduled_start_at + (auto_held_window_hours) < now()
// Exclusions: canceled, rescheduled, already-locked meetings.

interface AutoheldResult {
  resolved_count: number
  org_id: string
}

export async function resolveAutoHeldMeetings(): Promise<AutoheldResult[]> {
  try {
    const supabase = await createClient()

    // Fetch all organisations with their auto_held_window_hours
    const { data: orgs, error: orgsError } = await supabase
      .from('organisations')
      .select('id, auto_held_window_hours')

    if (orgsError) {
      logger.error('auto-held resolution: failed to fetch organisations', {
        error: orgsError.message,
      })
      throw orgsError
    }

    if (!orgs || orgs.length === 0) {
      return []
    }

    const results: AutoheldResult[] = []

    for (const org of orgs) {
      // Calculate window close time
      const windowHours = org.auto_held_window_hours
      const now = new Date()

      // Find meetings eligible for auto-hold
      const { data: eligibleMeetings, error: fetchError } = await supabase
        .from('meetings')
        .select('id, scheduled_start_at')
        .eq('organisation_id', org.id)
        .eq('meeting_status', 'booked')
        .eq('held_decision_locked', false)
        .not('scheduled_start_at', 'is', null)

      if (fetchError) {
        logger.error('auto-held resolution: failed to fetch meetings', {
          organisation_id: org.id,
          error: fetchError.message,
        })
        Sentry.captureException(fetchError, {
          extra: { action: 'resolve_autoheld', org_id: org.id },
        })
        continue
      }

      if (!eligibleMeetings || eligibleMeetings.length === 0) {
        continue
      }

      // Filter meetings where window has closed
      const toAutoHold = eligibleMeetings.filter(m => {
        if (!m.scheduled_start_at) return false
        const scheduledTime = new Date(m.scheduled_start_at).getTime()
        const windowEnd = scheduledTime + windowHours * 60 * 60 * 1000
        return now.getTime() >= windowEnd
      })

      if (toAutoHold.length === 0) {
        continue
      }

      // Update all eligible meetings to auto-held
      const { error: updateError, count } = await supabase
        .from('meetings')
        .update({
          meeting_status: 'held',
          held_confirmed_by: 'auto',
          held_decision_locked: true,
          is_billable: true,
        })
        .eq('organisation_id', org.id)
        .eq('meeting_status', 'booked')
        .eq('held_decision_locked', false)
        .in(
          'id',
          toAutoHold.map(m => m.id)
        )

      if (updateError) {
        logger.error('auto-held resolution: update failed', {
          organisation_id: org.id,
          error: updateError.message,
        })
        Sentry.captureException(updateError, {
          extra: {
            action: 'resolve_autoheld_update',
            org_id: org.id,
            count: toAutoHold.length,
          },
        })
        continue
      }

      logger.info('auto-held resolution: meetings resolved', {
        organisation_id: org.id,
        resolved_count: count ?? toAutoHold.length,
      })

      results.push({
        resolved_count: count ?? toAutoHold.length,
        org_id: org.id,
      })
    }

    return results
  } catch (error) {
    logger.error('auto-held resolution: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    Sentry.captureException(error, { extra: { action: 'resolve_autoheld' } })
    return []
  }
}
