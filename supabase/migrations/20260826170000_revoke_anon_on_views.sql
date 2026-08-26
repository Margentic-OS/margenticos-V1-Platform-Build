-- Close the view-over-RLS-table bypass to anon.
--
-- Status: NOT APPLIED. Written and awaiting Doug's go-ahead.
--
-- The instruction for these nine was explicitly "report, do not batch-revoke them blind".
-- The tracing below is what turns a blind revoke into an informed one, but the decision
-- was reserved and reserving it still stands even though the measurements came back
-- supporting the change. Applying it because the evidence happens to agree would be
-- taking a decision that was not mine to take.
--
-- To apply: Supabase MCP apply_migration, then read back
--   has_table_privilege('anon', 'public.mon_019', 'SELECT')          -> expect false
--   has_table_privilege('authenticated', 'public.mon_019', 'SELECT') -> expect false
--   has_table_privilege('service_role', 'public.mon_019', 'SELECT')  -> expect true
-- and confirm the next monitor-sweep firing still records events for all 20 monitors.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED, AND HOW IT DIFFERED FROM WHAT WAS REPORTED
--
-- A Postgres view executes with its OWNER's privileges unless created with
-- security_invoker = true. Every view in this database is owned by postgres. So an
-- anon-readable view over an RLS-protected table returns that table's rows to anon, and
-- RLS is never consulted, because the query is not running as the caller.
--
-- Demonstrated end to end before writing this migration:
--
--     as anon:  SELECT count(*) FROM public.cron_heartbeats;   ->  0 rows   (RLS holds)
--     as anon:  SELECT * FROM public.mon_019;                  ->  returns data
--
-- Same underlying table. The view is the difference.
--
-- ── THE PART THAT WAS REPORTED AND IS NOT TRUE ──
--
-- client_organisation_view was reported as exposing id, name, slug, contract_start_date,
-- pipeline_unlocked, pipeline_unlock_at, meetings_count, created_at and updated_at FOR
-- EVERY ORGANISATION to anyone holding the anon key. It does not, and this migration
-- deliberately does not claim that it did.
--
-- Its definition ends `WHERE id = get_my_organisation_id()`. It self-scopes to the
-- caller's own organisation. And get_my_organisation_id() is SECURITY DEFINER with
-- EXECUTE DENIED to anon, so an anon read does not return the wrong rows, it fails:
--
--     as anon:  SELECT * FROM public.client_organisation_view;
--     ERROR 42501: permission denied for function get_my_organisation_id
--
-- It also fails CLOSED if that ever changed, because the function reads
-- `organisation_id FROM users WHERE id = auth.uid()`, and auth.uid() is NULL for anon, so
-- the predicate becomes `id = NULL` and matches nothing.
--
-- The severity therefore ran the opposite way to the report: the monitoring views nobody
-- worried about are the ones bypassing RLS, and the client view that looked alarming is
-- self-scoped and denied.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE STANDING AUDIT NEVER FOUND ANY OF IT
--
-- The audit query in CLAUDE.md filtered `c.relkind = 'r'`, which is ordinary TABLES.
-- Views are 'v'. It had never looked at a view and had been returning zero rows since it
-- was written. Corrected in the same commit as this migration.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- SCOPE OF THIS MIGRATION: THE NINE mon_* VIEWS, AND ONLY THOSE
--
-- Every reader traced before revoking, because a revoke that breaks a read looks
-- identical to a read with no data, and RLS silently returning zero rows on a
-- client-facing path has bitten this build three times.
--
--   the monitor sweep      reads mon_NNN as SERVICE_ROLE
--                          (src/app/api/cron/monitor-sweep/route.ts)
--   the operator dashboard reads monitor_checks and monitor_events, NOT the views
--                          (src/app/api/operator/monitor-data/route.ts, service client)
--
-- Nothing reads a mon_* view as anon or as authenticated. Confirmed by grep across
-- *.ts/*.tsx/*.sql and by reading both routes.
--
-- What leaks without this: which scheduled jobs exist, when each last ran, whether it is
-- failing, and the free-text detail with its counts. No client data, no organisation
-- data, no prospect data. Low severity, which is why this is a revoke and not an
-- incident. It is still an unauthenticated read of internal operational state, and it is
-- free to close.
--
-- mon_006 and mon_011 through mon_018 are NOT listed because they are already denied to
-- anon, and mon_021 and mon_022 were created locked down. Revoking them again would be
-- harmless and is left out so this file lists exactly what it changes.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NOT IN SCOPE, DELIBERATELY
--
-- client_organisation_view. Its anon SELECT grant is useless today, so removing it is
-- defence in depth rather than a fix, and it is a CLIENT-FACING view whose only purpose
-- is to serve an authenticated user their own organisation. Nothing reads it yet.
-- Changing grants or setting security_invoker on a client-facing view under a premise
-- that turned out to be wrong is exactly the wrong order of operations. Raised for a
-- separate decision, with the measurements above, in BACKLOG.

REVOKE ALL ON public.mon_001 FROM PUBLIC;
REVOKE ALL ON public.mon_002 FROM PUBLIC;
REVOKE ALL ON public.mon_003 FROM PUBLIC;
REVOKE ALL ON public.mon_004 FROM PUBLIC;
REVOKE ALL ON public.mon_005 FROM PUBLIC;
REVOKE ALL ON public.mon_007 FROM PUBLIC;
REVOKE ALL ON public.mon_010 FROM PUBLIC;
REVOKE ALL ON public.mon_019 FROM PUBLIC;
REVOKE ALL ON public.mon_020 FROM PUBLIC;

REVOKE ALL ON public.mon_001 FROM anon, authenticated;
REVOKE ALL ON public.mon_002 FROM anon, authenticated;
REVOKE ALL ON public.mon_003 FROM anon, authenticated;
REVOKE ALL ON public.mon_004 FROM anon, authenticated;
REVOKE ALL ON public.mon_005 FROM anon, authenticated;
REVOKE ALL ON public.mon_007 FROM anon, authenticated;
REVOKE ALL ON public.mon_010 FROM anon, authenticated;
REVOKE ALL ON public.mon_019 FROM anon, authenticated;
REVOKE ALL ON public.mon_020 FROM anon, authenticated;

GRANT SELECT ON public.mon_001 TO service_role;
GRANT SELECT ON public.mon_002 TO service_role;
GRANT SELECT ON public.mon_003 TO service_role;
GRANT SELECT ON public.mon_004 TO service_role;
GRANT SELECT ON public.mon_005 TO service_role;
GRANT SELECT ON public.mon_007 TO service_role;
GRANT SELECT ON public.mon_010 TO service_role;
GRANT SELECT ON public.mon_019 TO service_role;
GRANT SELECT ON public.mon_020 TO service_role;
