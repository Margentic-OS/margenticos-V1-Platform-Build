-- MON-019: the email verification sweep is alive AND succeeding.
--
-- WHY THIS EXISTS, and why the heartbeat alone was not enough.
--
-- /api/cron/verify-pending shipped without a cron_heartbeats row, which was fixed in 27668b4.
-- But writing the row only makes the data AVAILABLE. Nothing read it.
--
-- The liveness monitors in this database are one-per-job, each view filtering
-- cron_heartbeats by a literal job_name: MON-001 auto-approve, MON-002 instantly-poll,
-- MON-003 process-replies, MON-004 reap-agent-runs, MON-005 monitor-sweep, MON-007, MON-010.
-- There is no generic "any cron went quiet" check. So a new scheduled job is invisible until
-- it gets its own view, its own monitor_checks row, AND its name added to the sweep's
-- hardcoded viewNames array. All three are required; any one missing and the job is dark.
--
-- That is the same failure the Instantly poller had: it ran dead for four months.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THIS VIEW READS ok, UNLIKE mon_002. DELIBERATE.
--
-- mon_002's shape derives state from max(ran_at) STALENESS ALONE and uses ok only to pick a
-- detail string, so a cron that runs punctually and fails every single run reads OK there.
-- The monitor-sweep route documents that blind spot in its own header, and mon_016 was
-- written to avoid it. A new view should not inherit a known defect for the sake of
-- symmetry, so this one goes to PROBLEM on staleness OR on a failed run.
--
-- Threshold is 20 minutes against a 10-minute schedule: two missed firings, matching MON-004
-- which has the same cadence. One missed firing is noise, two is a pattern.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Status: APPLIED (verified live 2026-08-25 — mon_019 returned OK off the 23:00 heartbeat,
-- and monitor_checks.MON-019 read back with the intended title rather than a pre-existing row)

CREATE OR REPLACE VIEW public.mon_019 AS
  SELECT 'MON-019'::text AS check_code,
    CASE
      WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
      WHEN (EXTRACT(epoch FROM (now() - max(ran_at))) / 60::numeric) > 20::numeric THEN 'PROBLEM'::text
      -- Read the outcome, not just the pulse. See the note above.
      WHEN bool_or(NOT ok) FILTER (WHERE ran_at > now() - interval '60 minutes') THEN 'PROBLEM'::text
      ELSE 'OK'::text
    END AS state,
    COALESCE(
      max(CASE WHEN ok = false THEN detail ELSE NULL::text END),
      'Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text)
    ) AS detail,
    max(ran_at) AS last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'verify-pending'::text;

-- ON CONFLICT DO UPDATE, NOT DO NOTHING.
--
-- MON-016 was registered with ON CONFLICT (code) DO NOTHING, a pre-existing row won, and the
-- live monitor still reads "Prospects stuck at uploading" instead of queue-worker health. So
-- if the queue worker dies, the dashboard tells you to reset upload statuses. A seed that
-- silently loses to whatever is already there is not a seed, it is a coin toss.
INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-019',
  'Email verification sweep every 10m',
  'Confirms /api/cron/verify-pending is both running on schedule and succeeding. PROBLEM on '
    || 'two missed firings (20 minutes) or on any failed run in the last hour.',
  'liveness',
  1,
  true,
  10,
  'The job that checks whether prospect email addresses are real is running.',
  'If it stops, prospects never get a verification verdict. Research now REFUSES a prospect '
    || 'with no verdict, so the whole pipeline quietly stops producing copy rather than '
    || 'producing worse copy. Nothing would look broken.',
  'Check the verify-pending pg_cron job is still scheduled and active, then check the route '
    || 'is responding: SELECT status_code FROM net._http_response ORDER BY created DESC.'
)
ON CONFLICT (code) DO UPDATE SET
  title                     = EXCLUDED.title,
  description               = EXCLUDED.description,
  category                  = EXCLUDED.category,
  tier                      = EXCLUDED.tier,
  is_scheduled              = EXCLUDED.is_scheduled,
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  plain_meaning             = EXCLUDED.plain_meaning,
  plain_impact              = EXCLUDED.plain_impact,
  plain_action              = EXCLUDED.plain_action;
