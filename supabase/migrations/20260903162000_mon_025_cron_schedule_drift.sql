-- MON-025: every scheduled job runs on the schedule its migrations declare.
--
-- Status: APPLIED (verified live 2026-09-03; production and the test project)
--
-- Read-back after apply, production:
--   mon_025 -> OK, "All 11 declared job(s) are scheduled, active, and running on the
--              schedule their migration declares. 11 job(s) live."
--   cron_schedule_registry  anon/authenticated: SELECT false. service_role: true. RLS on.
--   mon_025                 anon/authenticated: SELECT false. service_role: true.
--   mon_024 still OK after both relations were added.
--
-- PROVED TO GO RED, each probe inside BEGIN ... ROLLBACK:
--   registry set to the old */30 for verify-catch-all, reproducing the 2026-09-01 state
--     -> PROBLEM, "verify-catch-all runs */10 * * * *, declared */30 * * * *"
--   cron.alter_job verify-pending to */45, the hand change this monitor is named for
--     -> PROBLEM, "verify-pending runs */45 * * * *, declared */10 * * * *"
--   cron.alter_job monitor-sweep active := false
--     -> PROBLEM, "Declared and switched off: monitor-sweep"
--   registry row for auto-approve deleted
--     -> PROBLEM, "Scheduled but declared nowhere: auto-approve (0 * * * *)"
--   cron.unschedule('reap-agent-runs')
--     -> PROBLEM, "Declared but not scheduled: reap-agent-runs (declared */10 * * * *)"
--   registry emptied
--     -> UNKNOWN, "Nothing to evaluate... This is not a pass."
-- The test project, which has pg_cron and zero jobs, reads UNKNOWN rather than OK. A
-- monitor that has never been seen to go red is a monitor nobody has tested.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- verify-catch-all was moved from */30 to */10 with cron.alter_job on 2026-09-01. The
-- migration that declares it still said */30 until 2026-09-03. Nothing noticed, and nothing
-- could have: no instrument in this platform reads cron.job.schedule at all.
--
-- The damage is not the drift itself. It is that REPLAYING THE MIGRATION SILENTLY REVERTS
-- THE SCHEDULE. The job goes on running, on time, at a third of the intended rate, and
-- every existing monitor stays green because MON-002 measures staleness in cron_heartbeats
-- and a slower job is not a stale one. This is the same family as the monitor sweep whose
-- loop never reached mon_019: a check that runs, reports success, and cannot see the class
-- it was written to find.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A TABLE AND NOT A LIST INSIDE THE VIEW
--
-- The comparison needs two sides: what is live, and what the migrations declare. A view can
-- read cron.job. It cannot read a .sql file. So the declared side has to be MATERIALISED
-- somewhere the database can see, and a table seeded by migration is the same shape
-- monitor_checks itself already uses.
--
-- That creates the obvious risk of a THIRD source of truth that drifts from both. It is
-- closed from the other end, in CI:
-- src/app/api/cron/monitor-sweep/__tests__/cron-schedule-registry.test.ts scans every
-- migration for cron.schedule, cron.alter_job and cron.unschedule, computes the final
-- declared schedule per job in filename order, and fails if it disagrees with the seed
-- below. So this table cannot be edited into agreement with a drifted database without the
-- migration that justifies it.
--
-- Between them the two halves cover both directions:
--   live != registry   -> MON-025 goes red, continuously, in production
--   registry != files  -> the vitest test goes red, in CI, before merge
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT IT REPORTS, AND WHY 'NOTHING TO EVALUATE' IS NOT A PASS
--
--   schedule mismatch     a registered job runs on a schedule nobody declared
--   unregistered job      a live job with no registry row, so nothing governs it
--   missing job           a registered job that is not scheduled at all
--   inactive job          a registered job that exists and is switched off
--
-- An empty registry, or an empty cron.job, returns UNKNOWN rather than OK. Every rule here
-- is of the form "no job is in a bad state", and those are all vacuously true over an empty
-- set. This codebase has shipped that mistake often enough to name it in CLAUDE.md.

CREATE TABLE IF NOT EXISTS public.cron_schedule_registry (
  jobname      text PRIMARY KEY,
  schedule     text NOT NULL,
  -- The migration filename this schedule was last declared in. Diagnostic only: it tells a
  -- reader which file to open, and it is what the CI test writes back when it disagrees.
  declared_by  text NOT NULL,
  notes        text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Service-role only, both layers. RLS is what protects the rows today; the by-name REVOKE
-- is the second layer, because Supabase's ALTER DEFAULT PRIVILEGES grants every new table
-- in public to anon and authenticated BY NAME, and "RLS on, no policies" leaves that grant
-- sitting underneath. See the 2026-08-25 verification_calls incident in CLAUDE.md.
ALTER TABLE public.cron_schedule_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_schedule_registry FROM PUBLIC;
REVOKE ALL ON TABLE public.cron_schedule_registry FROM anon, authenticated;
GRANT ALL ON TABLE public.cron_schedule_registry TO service_role;

-- ── THE DECLARED SCHEDULES ────────────────────────────────────────────────────
--
-- One row per job that a migration in this repository schedules, carrying the LAST
-- schedule declared for it. Swept 2026-09-03 across every migration containing
-- cron.schedule, cron.alter_job or cron.unschedule.
--
-- strategy-doc-auto-approve is deliberately absent: 20260903100500 unschedules it, so its
-- final declared state is "not scheduled", and a row here would make MON-025 demand a job
-- that is meant to be gone.

INSERT INTO public.cron_schedule_registry (jobname, schedule, declared_by, notes) VALUES
  ('instantly-poll',            '*/15 * * * *', '20260428_instantly_polling.sql',                    NULL),
  ('process-replies',           '*/5 * * * *',  '20260429_reply_handling.sql',                       NULL),
  ('auto-approve',              '0 * * * *',    '20260605_auto_approve_cron.sql',                    NULL),
  ('reap-agent-runs',           '*/10 * * * *', '20260807_reap_agent_runs_pg_cron.sql',              NULL),
  ('monitor-sweep',             '*/15 * * * *', '20260807_schedule_monitor_sweep.sql',               NULL),
  ('resolve-auto-held',         '0 9 * * *',    '20260808_schedule_daily_crons.sql',                 NULL),
  ('queue-worker',              '* * * * *',    '20260824180000_queue_monitoring.sql',               NULL),
  ('verify-pending',            '*/10 * * * *', '20260825210000_verify_pending_pg_cron.sql',         NULL),
  ('verify-catch-all',          '*/10 * * * *', '20260903161000_verify_catch_all_schedule_10min.sql',
     'Moved off */30 live on 2026-09-01. The declaring migration was not updated until 2026-09-03, which is what MON-025 exists to catch.'),
  ('synthesis-batch-sweep',     '*/5 * * * *',  '20260826150000_synthesis_batch_sweep_pg_cron.sql',  NULL),
  ('cron-heartbeats-retention', '17 3 * * *',   '20260827233000_cron_heartbeats_grants_and_retention.sql', NULL)
ON CONFLICT (jobname) DO UPDATE SET
  schedule    = EXCLUDED.schedule,
  declared_by = EXCLUDED.declared_by,
  notes       = EXCLUDED.notes,
  updated_at  = now();

-- ── THE MONITOR ───────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.mon_025 AS
WITH live AS (
  SELECT jobname, schedule, active FROM cron.job
),
declared AS (
  SELECT jobname, schedule FROM public.cron_schedule_registry
),
findings AS (
  SELECT
    -- A registered job whose live schedule is not the declared one.
    (SELECT string_agg(d.jobname || ' runs ' || l.schedule || ', declared ' || d.schedule, ', '
                       ORDER BY d.jobname)
       FROM declared d JOIN live l USING (jobname)
      WHERE l.schedule IS DISTINCT FROM d.schedule)                             AS mismatched,
    -- A live job nobody declared. Not necessarily wrong, but nothing governs its schedule,
    -- so a change to it can never be detected.
    (SELECT string_agg(l.jobname || ' (' || l.schedule || ')', ', ' ORDER BY l.jobname)
       FROM live l LEFT JOIN declared d USING (jobname)
      WHERE d.jobname IS NULL)                                                  AS unregistered,
    -- A declared job that is not scheduled at all.
    (SELECT string_agg(d.jobname || ' (declared ' || d.schedule || ')', ', ' ORDER BY d.jobname)
       FROM declared d LEFT JOIN live l USING (jobname)
      WHERE l.jobname IS NULL)                                                  AS missing,
    -- A declared job that exists and is switched off.
    (SELECT string_agg(l.jobname, ', ' ORDER BY l.jobname)
       FROM declared d JOIN live l USING (jobname)
      WHERE NOT l.active)                                                       AS inactive,
    (SELECT count(*) FROM declared)                                             AS declared_count,
    (SELECT count(*) FROM live)                                                 AS live_count
)
SELECT
  'MON-025'::text AS check_code,
  CASE
    -- Vacuous truth is not a pass. See the header.
    WHEN f.declared_count = 0 OR f.live_count = 0 THEN 'UNKNOWN'::text
    WHEN f.mismatched IS NOT NULL
      OR f.unregistered IS NOT NULL
      OR f.missing IS NOT NULL
      OR f.inactive IS NOT NULL                    THEN 'PROBLEM'::text
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
      || COALESCE('Declared and switched off: ' || f.inactive || '. ', '')
      || CASE
           WHEN f.mismatched IS NULL AND f.unregistered IS NULL
            AND f.missing IS NULL AND f.inactive IS NULL
             THEN 'All ' || f.declared_count || ' declared job(s) are scheduled, active, and '
               || 'running on the schedule their migration declares. ' || f.live_count
               || ' job(s) live.'
           ELSE ''
         END)
  END AS detail,
  now() AS last_run
FROM findings f;

REVOKE ALL ON public.mon_025 FROM PUBLIC;
REVOKE ALL ON public.mon_025 FROM anon, authenticated;
GRANT SELECT ON public.mon_025 TO service_role;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-025',
  'Every scheduled job runs on the schedule we wrote down',
  'Compares cron.job against cron_schedule_registry, which holds the last schedule each job '
    || 'is given by a migration. Fails on a schedule that differs, a live job declared '
    || 'nowhere, a declared job that is not scheduled, and a declared job that is switched '
    || 'off. Returns UNKNOWN, not OK, when either side is empty. The registry itself is held '
    || 'to the migration files by a test in CI.',
  'data_integrity',
  1,
  false,
  NULL,
  'The automatic jobs that run this platform are running as often as they are supposed to, '
    || 'and every one of them is written down somewhere we can check.',
  'A job whose timing was changed by hand still looks perfectly healthy on this dashboard: '
    || 'it runs, it succeeds, it just does it less often than intended. Worse, the next time '
    || 'the database is rebuilt from its migration files, the hand change is silently undone '
    || 'and nothing says so. This happened on 2026-09-01 to the catch-all verification sweep '
    || 'and went unnoticed for two days.',
  'Read the detail line: it names the job, what it is running now, and what the migrations '
    || 'say it should run. Then decide which one is right. If the live schedule is correct, '
    || 'add a migration declaring it, so a rebuild keeps it. If the migration is correct, '
    || 'change the job back. Never edit the registry table on its own to make this go green: '
    || 'the CI test compares it against the migration files and will refuse.'
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
