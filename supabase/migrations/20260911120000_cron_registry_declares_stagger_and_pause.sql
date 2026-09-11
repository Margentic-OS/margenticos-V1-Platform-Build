-- Status: NOT YET APPLIED.
--
-- The cron registry catches up with the 2026-09-10 stagger, learns that a job can be
-- switched off ON PURPOSE, and MON-025 and MON-001 both read that declaration. See ADR-054.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WAS WRONG
--
-- DATABASE-EVIDENCED, production, read 2026-09-11. 20260910140000_stagger_cron_offsets.sql
-- moved eleven jobs with cron.alter_job and never touched cron_schedule_registry, which still
-- held the pre-stagger schedules (last updated 2026-09-04). MON-025 has read PROBLEM since,
-- naming all eleven. MON-025 was right; the registry was stale.
--
-- Separately, MON-001 has read PROBLEM ("over 75 minutes ago") since auto-approve was paused
-- on 2026-09-10 (ADR-052). Nothing was broken. The monitor had no way to know the pause was
-- deliberate, because nothing anywhere declared it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY NOTHING CAUGHT THE STAGGER BEFORE IT WAS APPLIED
--
-- cron-schedule-registry.test.ts is the half that holds this table to the migration files.
-- Its cron.alter_job parser matched only `schedule := '...'`. The stagger wrote
-- `schedule => '...'`, the standard named-argument notation. Measured: 0 of the stagger's 11
-- alter_job calls matched, 11 of 11 once `=>` is accepted. So the scan never saw the stagger,
-- the files still appeared to declare the old schedules, the old seed agreed with them, and
-- the test passed 8 of 8 on e4c2161. Its only guard on alter_job was
-- `expect(alterJobs).toBeGreaterThanOrEqual(0)`, which cannot fail.
--
-- Fixed in the same commit as this file: both notations are read, and an alter_job that
-- changes a schedule or on/off state the scan cannot attribute now THROWS instead of being
-- skipped. With the fix and without this migration, that test fails naming all eleven.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES
--
-- 1. cron_schedule_registry.active: whether the migrations declare the job ON. Default true.
--
-- 2. Declares auto-approve OFF in a migration. ADR-052's pause migration
--    (20260910230000_pause_auto_approve_cron.sql) is applied in production but exists only on
--    the unmerged auto-approve-pause branch, so main's files declared the job ON: a rebuild
--    from main would have re-enabled a job ADR-052 says must not run. The statement below is
--    CONDITIONAL on the job being active, and it is not, so in production it calls nothing.
--    It exists for a rebuild. If auto-approve-pause merges as well, both files say off and the
--    last one wins, so the two cannot disagree.
--
-- 3. Re-seeds all twelve rows with the schedules live since the stagger.
--
-- 4. mon_025 compares on/off as well as schedule. Switched off but declared on, and running
--    but declared off, are both PROBLEM. Switched off AS DECLARED is not a finding, and is
--    named in the detail line so it is never hidden.
--
-- 5. mon_001 reads OK, with a detail saying switched off as declared, only when BOTH sides
--    agree: the pg_cron job is inactive AND this table declares it off. Either side alone is
--    not enough. A job switched off by hand with no declaration stays PROBLEM, and so does a
--    job that is on and stalled, exactly as before.
--
-- WHY OK AND NOT A FOURTH STATE. monitor_events.state accepts OK, PROBLEM and UNKNOWN only.
-- ADR-035 settled how a monitor with more answers than that collapses: the traffic light
-- answers "should you act", the detail answers "what is known". A deliberate pause needs no
-- action. UNKNOWN is wrong twice over: it means "could not read", which is false here, and a
-- resting UNKNOWN makes a check born dark (ADR-035).
--
-- The cron.job lookups below are by jobname, never by jobid, for the same reason as the stagger.
-- This file never reads or writes cron.job.command, which carries a bearer token.

-- ── 1. The column ─────────────────────────────────────────────────────────────

ALTER TABLE public.cron_schedule_registry
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.cron_schedule_registry.active IS
  'Whether the migrations declare this job ON. False means switched off on purpose, and '
  'MON-025 and MON-001 read it. Held to the migration files by cron-schedule-registry.test.ts.';

-- ── 2. auto-approve is declared off (ADR-052) ────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-approve' AND active) THEN
    PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'auto-approve'), active => false);
  END IF;
END $$;

-- ── 3. The registry, matching what is live ───────────────────────────────────
--
-- active is the THIRD column on purpose: the CI scan reads it by position.
-- notes are COALESCEd, so a row passed NULL here keeps the story it already had.

INSERT INTO public.cron_schedule_registry (jobname, schedule, active, declared_by, notes) VALUES
  ('process-replies',           '1-59/5 * * * *',   true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('reap-agent-runs',           '2-59/10 * * * *',  true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('synthesis-batch-sweep',     '3-59/5 * * * *',   true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('verify-pending',            '4-59/10 * * * *',  true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('monitor-sweep',             '5-59/15 * * * *',  true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('verify-catch-all',          '7-59/10 * * * *',  true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('instantly-poll',            '10-59/15 * * * *', true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('suppression-reconcile',     '15-59/30 * * * *', true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('resolve-auto-held',         '9 9 * * *',        true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('cron-heartbeats-retention', '19 3 * * *',       true,  '20260910140000_stagger_cron_offsets.sql', NULL),
  ('queue-worker',              '* * * * *',        true,  '20260824180000_queue_monitoring.sql',     NULL),
  ('auto-approve',              '30 * * * *',       false, '20260911120000_cron_registry_declares_stagger_and_pause.sql',
     'Paused 2026-09-10, not fixed and not deleted (ADR-052). Schedule from the stagger; kept so a resume needs one line. Do not resume without superseding ADR-052.')
ON CONFLICT (jobname) DO UPDATE SET
  schedule    = EXCLUDED.schedule,
  active      = EXCLUDED.active,
  declared_by = EXCLUDED.declared_by,
  notes       = COALESCE(EXCLUDED.notes, public.cron_schedule_registry.notes),
  updated_at  = now();

-- ── 4. MON-025 compares on/off as well as schedule ───────────────────────────

CREATE OR REPLACE VIEW public.mon_025 AS
WITH live AS (
  SELECT jobname, schedule, active FROM cron.job
),
declared AS (
  SELECT jobname, schedule, active FROM public.cron_schedule_registry
),
findings AS (
  SELECT
    (SELECT string_agg(d.jobname || ' runs ' || l.schedule || ', declared ' || d.schedule, ', '
                       ORDER BY d.jobname)
       FROM declared d JOIN live l USING (jobname)
      WHERE l.schedule IS DISTINCT FROM d.schedule)                             AS mismatched,
    (SELECT string_agg(l.jobname || ' (' || l.schedule || ')', ', ' ORDER BY l.jobname)
       FROM live l LEFT JOIN declared d USING (jobname)
      WHERE d.jobname IS NULL)                                                  AS unregistered,
    (SELECT string_agg(d.jobname || ' (declared ' || d.schedule || ')', ', ' ORDER BY d.jobname)
       FROM declared d LEFT JOIN live l USING (jobname)
      WHERE l.jobname IS NULL)                                                  AS missing,
    -- Switched off, and nothing declares it off. Someone paused it by hand.
    (SELECT string_agg(l.jobname, ', ' ORDER BY l.jobname)
       FROM declared d JOIN live l USING (jobname)
      WHERE NOT l.active AND d.active)                                          AS off_undeclared,
    -- Running, though the migrations declare it off. For auto-approve this is the dangerous
    -- direction: ADR-052 says it must not run.
    (SELECT string_agg(l.jobname, ', ' ORDER BY l.jobname)
       FROM declared d JOIN live l USING (jobname)
      WHERE l.active AND NOT d.active)                                          AS on_declared_off,
    -- Switched off as declared. Not a finding; named in the detail so it is never hidden.
    (SELECT string_agg(l.jobname, ', ' ORDER BY l.jobname)
       FROM declared d JOIN live l USING (jobname)
      WHERE NOT l.active AND NOT d.active)                                      AS off_as_declared,
    (SELECT count(*) FROM declared)                                             AS declared_count,
    (SELECT count(*) FROM live)                                                 AS live_count
)
SELECT
  'MON-025'::text AS check_code,
  CASE
    -- Vacuous truth is not a pass. See 20260903162000_mon_025_cron_schedule_drift.sql.
    WHEN f.declared_count = 0 OR f.live_count = 0 THEN 'UNKNOWN'::text
    WHEN f.mismatched IS NOT NULL
      OR f.unregistered IS NOT NULL
      OR f.missing IS NOT NULL
      OR f.off_undeclared IS NOT NULL
      OR f.on_declared_off IS NOT NULL             THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN f.declared_count = 0
      THEN 'Nothing to evaluate: cron_schedule_registry is empty, so there is nothing to '
        || 'compare the live jobs against. This is not a pass.'
    WHEN f.live_count = 0
      THEN 'Nothing to evaluate: cron.job holds no jobs at all. Either pg_cron is not '
        || 'installed here or every scheduled job is gone. This is not a pass.'
    ELSE trim(both ' ' FROM
         COALESCE('Schedule differs from the migration that declares it: ' || f.mismatched || '. ', '')
      || COALESCE('Scheduled but declared nowhere, so nothing governs it: ' || f.unregistered || '. ', '')
      || COALESCE('Declared but not scheduled: ' || f.missing || '. ', '')
      || COALESCE('Switched off, but declared on: ' || f.off_undeclared || '. ', '')
      || COALESCE('Running, but declared off: ' || f.on_declared_off || '. ', '')
      || CASE
           WHEN f.mismatched IS NULL AND f.unregistered IS NULL AND f.missing IS NULL
            AND f.off_undeclared IS NULL AND f.on_declared_off IS NULL
             THEN 'All ' || f.declared_count || ' declared job(s) are scheduled, on the schedule '
               || 'their migration declares, and on or off as declared. ' || f.live_count
               || ' job(s) live. '
           ELSE ''
         END
      || COALESCE('Switched off, as declared: ' || f.off_as_declared || '.', ''))
  END AS detail,
  now() AS last_run
FROM findings f;

REVOKE ALL ON public.mon_025 FROM PUBLIC;
REVOKE ALL ON public.mon_025 FROM anon, authenticated;
GRANT SELECT ON public.mon_025 TO service_role;

-- ── 5. MON-001 tells a deliberate pause from a stall ─────────────────────────
--
-- "Off" needs BOTH sides, the way MON-025 compares live against declared:
--   sw.live_active      what pg_cron is doing now      (cron.job.active)
--   sw.declared_active  what the migrations say         (cron_schedule_registry.active)
-- IS FALSE, not = false, so a missing job or a missing registry row is NULL, never "off",
-- and falls through to the heartbeat branches exactly as before.
--
-- The state CASE and the detail CASE test the same conditions in the same order.
-- mon-001-off-needs-declaration.test.ts holds them to that, because mon_026's two CASEs
-- drifted and narrated a failed read as a measured zero.
--
-- Still one row always: (SELECT 1) one, a CROSS JOIN to a one-row subquery, and the
-- LEFT JOIN LATERAL the 20260904190000 migration explains. Column list unchanged.

CREATE OR REPLACE VIEW public.mon_001 AS
  SELECT
    'MON-001'::text AS check_code,
    CASE
      WHEN sw.live_active IS FALSE AND sw.declared_active IS FALSE
       AND (latest.ran_at IS NULL OR EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 75)
        THEN 'OK'
      WHEN sw.live_active IS FALSE AND sw.declared_active IS FALSE
        THEN 'PROBLEM'
      WHEN sw.live_active IS FALSE
        THEN 'PROBLEM'
      WHEN latest.ran_at IS NULL
        THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 75
        THEN 'PROBLEM'
      WHEN latest.ok = false
        THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN sw.live_active IS FALSE AND sw.declared_active IS FALSE
       AND (latest.ran_at IS NULL OR EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 75)
        THEN 'Switched off, as declared: the pg_cron job is inactive and ' || sw.declared_by
          || ' declares it off, so no run is expected. Last run '
          || COALESCE(TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'), 'never') || '.'
      WHEN sw.live_active IS FALSE AND sw.declared_active IS FALSE
        THEN 'Declared off and inactive in pg_cron, yet it reported a run at '
          || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC')
          || '. Something other than its schedule is calling the route. ADR-052 says this job must not run.'
      WHEN sw.live_active IS FALSE
        THEN 'The pg_cron job is switched off and nothing declares it off, so this is not '
          || 'treated as deliberate. Declare it off in a migration, or switch it back on. Last run '
          || COALESCE(TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'), 'never') || '.'
      WHEN latest.ran_at IS NULL
        THEN 'auto-approve has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 75
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 75 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  CROSS JOIN (
    SELECT
      (SELECT bool_or(j.active) FROM cron.job j WHERE j.jobname = 'auto-approve')              AS live_active,
      (SELECT r.active FROM public.cron_schedule_registry r WHERE r.jobname = 'auto-approve')  AS declared_active,
      (SELECT r.declared_by FROM public.cron_schedule_registry r WHERE r.jobname = 'auto-approve') AS declared_by
  ) sw
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'auto-approve'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;

REVOKE ALL ON public.mon_001 FROM PUBLIC;
REVOKE ALL ON public.mon_001 FROM anon, authenticated;
GRANT SELECT ON public.mon_001 TO service_role;

-- ── 6. What the board says about both ────────────────────────────────────────

UPDATE public.monitor_checks SET
  description  = 'Reads the auto-approve job''s latest heartbeat: PROBLEM when it is over 75 '
    || 'minutes old or failed. When the pg_cron job is inactive AND cron_schedule_registry '
    || 'declares it off, reads OK with a detail saying so, unless it has reported a run in the '
    || 'last 75 minutes. Switched off with no declaration reads PROBLEM.',
  plain_action = 'Read the detail. "Switched off, as declared" needs nothing: the job is paused '
    || 'on purpose (ADR-052). "Nothing declares it off" means someone paused it by hand: add a '
    || 'migration declaring it off, or switch it back on. Anything else means the job is on and '
    || 'not running cleanly: read its rows in cron_heartbeats.'
WHERE code = 'MON-001';

UPDATE public.monitor_checks SET
  description  = 'Compares cron.job against cron_schedule_registry, which holds the last schedule '
    || 'and on/off state each job is given by a migration. Fails on a schedule that differs, a '
    || 'live job declared nowhere, a declared job that is not scheduled, a job switched off that '
    || 'is declared on, and a job running that is declared off. A job switched off as declared '
    || 'is named in the detail, not failed. Returns UNKNOWN, not OK, when either side is empty. '
    || 'The registry itself is held to the migration files by a test.'
WHERE code = 'MON-025';
