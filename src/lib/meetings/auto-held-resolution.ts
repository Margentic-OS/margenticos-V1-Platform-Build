import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

// Auto-held resolution. Resolves meetings past their scheduled_start_at +
// auto_held_window_hours window.
// Formula: scheduled_start_at + (auto_held_window_hours) < now()
// Exclusions: canceled, rescheduled, already-locked meetings.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE CLIENT IS A REQUIRED PARAMETER. IT USED TO BE OPTIONAL, AND THAT HID A
// DEFECT FOR A MONTH.
//
// The signature was `resolveAutoHeldMeetings(supabase?: SupabaseClient)` with
// `supabase || await createServerClient()` as the body's first line. createServerClient
// is the anon-key-plus-session-cookie client. The only production caller is the cron
// route, which built a service-role client correctly and then called this with NO
// ARGUMENT, so every real run used the fallback and ran as `anon` with no cookies.
//
// Every test passed a mock client, so the fallback path — the only path production
// used — was exercised by nothing.
//
// Until 2026-09-01 that read SUCCEEDED and RLS filtered it to zero rows, so the job
// returned [] and reported success. The revoke migration of that date removed anon's
// grant, and the same read began failing outright. The job had already been resolving
// nothing since 2026-08-09: 31 consecutive runs, all ok=true, one distinct detail
// string, while three live organisations existed.
//
// The parameter is required now rather than defaulted to the service-role client,
// because a default identity is a decision made silently at a distance from the
// caller. Making it required moves that decision to the call site and makes omitting
// it a compile error.
// ═══════════════════════════════════════════════════════════════════════════════

export interface AutoheldResult {
  resolved_count: number
  org_id: string
}

export interface AutoHeldRun {
  /** Organisations actually read and walked. NOT the number that had work to do. */
  organisations_examined: number
  /** Only those where at least one meeting was resolved. */
  organisations_with_resolutions: AutoheldResult[]
  meetings_resolved: number
  /**
   * Organisations whose per-org read or update was refused or errored. The run
   * continues past these so one bad org cannot stop the rest, but a non-zero value
   * here must never be reported as a healthy run.
   */
  organisations_failed: number
}

// A read that returns nothing and a read that was refused are different events, and
// this function must never collapse them. It THROWS on a refused organisations read.
// It previously caught that error and returned [], which the caller could not tell
// apart from "no organisations needed work".
export async function resolveAutoHeldMeetings(
  supabase: SupabaseClient
): Promise<AutoHeldRun> {
  const client = supabase

  // Fetch all organisations with their auto_held_window_hours, excluding archived orgs
  const { data: orgs, error: orgsError } = await client
    .from('organisations')
    .select('id, auto_held_window_hours')
    .is('archived_at', null)

  // Deliberately not caught anywhere below. A denied read is a failed run, and the
  // caller stamps ok=false on the strength of this throwing.
  if (orgsError) {
    logger.error('auto-held resolution: failed to fetch organisations', {
      error: orgsError.message,
    })
    Sentry.captureException(orgsError, { extra: { action: 'resolve_autoheld_orgs_read' } })
    throw new Error(`auto-held resolution: organisations read failed: ${orgsError.message}`)
  }

  if (!orgs || orgs.length === 0) {
    return {
      organisations_examined: 0,
      organisations_with_resolutions: [],
      meetings_resolved: 0,
      organisations_failed: 0,
    }
  }

  const results: AutoheldResult[] = []
  let organisationsFailed = 0

  for (const org of orgs) {
    // Calculate window close time
    const windowHours = org.auto_held_window_hours
    const now = new Date()

    // Find meetings eligible for auto-hold.
    //
    // A meeting with NO PROSPECT is never eligible. A booking that could not be tied to a
    // prospect is still recorded (record-booking-event.ts), but billing is per qualified
    // meeting, and qualification needs a prospect to judge. Auto-holding it would bill a
    // stranger who found the booking link. The same filter is repeated on the update below,
    // so either one alone still holds the line. auto-held-excludes-unmatched.test.ts proves it.
    const { data: eligibleMeetings, error: fetchError } = await client
      .from('meetings')
      .select('id, scheduled_start_at')
      .eq('organisation_id', org.id)
      .eq('meeting_status', 'booked')
      .eq('held_decision_locked', false)
      .not('scheduled_start_at', 'is', null)
      .not('prospect_id', 'is', null)

    if (fetchError) {
      organisationsFailed++
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
    const { error: updateError, count } = await client
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
      .not('prospect_id', 'is', null)   // never bill a meeting with no prospect; see the read above
      .in(
        'id',
        toAutoHold.map(m => m.id)
      )

    if (updateError) {
      organisationsFailed++
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

  return {
    organisations_examined: orgs.length,
    organisations_with_resolutions: results,
    meetings_resolved: results.reduce((sum, r) => sum + r.resolved_count, 0),
    organisations_failed: organisationsFailed,
  }
}
