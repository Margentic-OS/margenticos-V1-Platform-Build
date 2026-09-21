// READING A SCHEDULED JOB'S OWN SCHEDULE, FROM THE DATABASE.
//
// Two callers, one read:
//
//   the verification sweep   sizes its run so it finishes before the next firing, because
//                            two overlapping runs spend one per-minute allowance twice.
//   the operator screen      tells an operator when the next firing is, so a backlog of 38
//                            comes with a time rather than only a number.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY cron_schedule_registry AND NOT cron.job
//
// pg_cron's own catalog is the live truth, and it is the wrong thing to read here. It lives
// in the `cron` schema, which PostgREST does not expose, so reaching it means a SECURITY
// DEFINER function, a grant, and a verification of that grant in both directions per the
// database-security rules in CLAUDE.md. That is a lot of surface for a number used to size a
// timeout and to render a caption.
//
// cron_schedule_registry is an ordinary table in `public`, it holds the DECLARED schedule,
// and MON-025 exists to fail when the declared and live schedules disagree. So the registry
// is a truthful source with a monitor behind it, which is a better shape than a second
// privileged path into the catalog.
//
// A DISAGREEMENT DEGRADES SAFELY IN BOTH DIRECTIONS. If the registry says ten minutes and
// the job really fires every five, the sweep sizes a window too long and two runs could
// overlap; MON-025 is the thing that catches that, and it is already watching. If the
// registry says five and the job fires every ten, the sweep simply does less per run. The
// screen is off by the same amount and says "about", which it can afford to be.
//
// ═════════════════════════════════════════════════════════════════════════════
// A MISSING ROW IS NULL, NEVER A GUESS
//
// Every function here returns null rather than substituting a plausible default. A default
// invented at this layer would be a fourth copy of the period, and the callers each already
// know what to do without one: the sweep falls back to its own compiled budget, the screen
// says nothing about a next run. Both are correct answers to "we could not read it". A
// guessed ten minutes rendered as a time on an operator screen is not.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { parseMinuteInterval, nextRunAfter } from '@/lib/sourcing/cron-interval'

/**
 * The declared crontab for one job, or null if it cannot be read.
 *
 * A read failure is logged and returned as null rather than thrown. Neither caller can do
 * anything useful with an exception: the sweep would fail a run that was about to work, and
 * the screen would lose every count on the page over a decorative caption.
 */
export async function readCronSchedule(
  supabase: SupabaseClient,
  jobName: string,
): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('cron_schedule_registry')
      .select('schedule')
      .eq('jobname', jobName)
      .maybeSingle()

    if (error) {
      logger.warn('cron-schedule: could not read the declared schedule', {
        job_name: jobName,
        error: error.message,
      })
      return null
    }

    return (data as { schedule?: string } | null)?.schedule ?? null
  } catch (err) {
    logger.warn('cron-schedule: schedule read threw', {
      job_name: jobName,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * How often a job fires, in milliseconds, or null when that is not a knowable minute interval.
 *
 * Null covers three different situations on purpose, because the caller treats them the
 * same: no row, an unreadable table, and a schedule that is not a plain minute step (a daily
 * retention job, say). Distinguishing them would give the sweep a decision it has no better
 * answer to than "use the compiled budget".
 */
export async function readCronPeriodMs(
  supabase: SupabaseClient,
  jobName: string,
): Promise<number | null> {
  const schedule = await readCronSchedule(supabase, jobName)
  if (schedule === null) return null

  const interval = parseMinuteInterval(schedule)
  if (interval === null) {
    logger.warn('cron-schedule: the declared schedule is not a plain minute interval', {
      job_name: jobName,
      schedule,
    })
    return null
  }

  return interval.stepMinutes * 60_000
}

/**
 * When a job next fires, or null when that cannot be worked out.
 *
 * `now` is a parameter rather than read from the clock so the caller can render a time
 * consistent with the rest of a payload built in one pass, and so a test needs no fake timers.
 */
export async function readNextRunAt(
  supabase: SupabaseClient,
  jobName: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const schedule = await readCronSchedule(supabase, jobName)
  if (schedule === null) return null
  return nextRunAfter(schedule, now)
}
