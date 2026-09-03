-- Retires the three-day strategy-document auto-approval.
--
-- Status: APPLIED (verified live 2026-09-03)
--
-- Client approval on strategy documents is removed, so the daily cron that promoted
-- anything still 'pending' after three days has nothing left to decide. It is
-- unscheduled here rather than left running against a column nothing reads.
--
-- MON-007 watched that cron's heartbeat. A monitor whose subject no longer exists
-- reports PROBLEM for ever and trains the operator to ignore the board, so the view
-- and its registry row go with the job. The sweep's MONITORS pair list is edited in
-- the same commit; the pair-list test fails if a mon_NNN view created by a migration
-- is not queried, and mon_007 was created in the baseline rather than in a migration,
-- so that test is not what protects this. The protection is that both halves are in
-- one commit.
--
-- NOT TOUCHED: the hourly 'auto-approve' job (jobid 5). That one auto-approves
-- pending rows in document_suggestions, which is the operator's approval queue and a
-- different mechanism entirely. Its reminder email goes to the operator, not to a
-- client, and remains true.
--
-- ─── DOWN ─────────────────────────────────────────────────────────────────────
-- Re-schedule with the definition in 20260605_auto_approve_cron.sql's sibling, and
-- restore mon_007 from supabase/baseline/schema.sql.

BEGIN;

-- Unschedule. Wrapped so a re-run against a database where the job is already gone
-- succeeds rather than aborting the migration.
DO $$
BEGIN
  PERFORM cron.unschedule('strategy-doc-auto-approve');
EXCEPTION WHEN others THEN
  RAISE NOTICE 'strategy-doc-auto-approve was not scheduled; nothing to unschedule';
END $$;

DROP VIEW IF EXISTS public.mon_007;

UPDATE public.monitor_checks
SET title                     = 'Strategy doc auto-approve (RETIRED)',
    description               = 'Retired 2026-09-03. Client approval on strategy documents was removed, so there is no approval window to time out. Kept for its event history only.',
    category                  = 'unscheduled',
    is_scheduled              = false,
    expected_interval_minutes = NULL,
    plain_meaning             = 'This check no longer runs. It watched a daily job that auto-approved strategy documents after three days.',
    plain_impact              = 'None. The job it watched was unscheduled deliberately and the documents it acted on are now live as soon as they are produced.',
    plain_action              = 'Nothing. This row is kept so the events it recorded before 2026-09-03 still have a check to belong to.'
WHERE code IN ('MON-007', 'MON-007-UNSCHEDULED');

COMMIT;
