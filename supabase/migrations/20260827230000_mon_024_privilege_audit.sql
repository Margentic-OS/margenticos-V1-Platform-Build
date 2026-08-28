-- MON-024: anon and authenticated hold no privilege beyond what is intended.
--
-- Status: APPLIED (verified live 2026-08-27, recorded remotely as 20260828001730)
--
-- Read-back after apply:
--   mon_024 -> OK, "440 privilege(s) across 29 RLS-backed table(s), and 2 read(s) on views
--              that run as the caller. No table with RLS off, no owner-executing view, and
--              no write grant on any view. Scanned 63 relations."
--   mon_024               anon/authenticated: every privilege false. service_role: true.
--   client_prospects_view anon: every privilege false. authenticated: SELECT only.
--
-- PROVED TO GO RED, each probe inside BEGIN ... ROLLBACK:
--   ALTER TABLE patterns DISABLE ROW LEVEL SECURITY
--     -> PROBLEM, "...a table with RLS OFF... patterns (anon), patterns (authenticated)."
--   ALTER VIEW client_prospects_view SET (security_invoker = false)
--     -> PROBLEM, "...a view that does NOT run as the caller..."
--   GRANT UPDATE, DELETE ON client_prospects_view TO authenticated
--     -> PROBLEM, "...client_prospects_view (authenticated: DELETE/UPDATE)..."
--   the same view rewritten over a schema with no relations
--     -> UNKNOWN, "Nothing to evaluate... This is not a pass."
-- A monitor that has never been seen to go red is a monitor nobody has tested.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS: THE AUDIT WAS THE BUG, THREE TIMES RUNNING
--
-- CLAUDE.md has carried a privilege audit query since 2026-08-25. It has been corrected
-- once already, when it turned out that `relkind = 'r'` meant it had never looked at a
-- view, and had been returning zero rows reassuringly for as long as it existed.
--
-- The corrected version still read one privilege: SELECT. It asks who can READ.
--
-- So on 2026-08-26 client_organisation_view was examined, its read path measured
-- correctly, and cleared. It was auto-updatable, owner-executing, and anon and
-- authenticated both held the full arwdDxtm default on it. A signed-in client could
-- UPDATE their own organisation row through it, including pipeline_unlocked, which is the
-- operator-controlled phased unlock. See ADR-039, which measured that write succeeding.
-- The write grants were invisible to the query that was looking for problems.
--
-- Three instances of one shape: a check that runs, reports success, and cannot see the
-- class it was written to find. The fix for the class is not a better query in a markdown
-- file. It is a query that RUNS WITHOUT BEING REMEMBERED, which is the same reasoning
-- that turned the commit gate from prose into a hook on 2026-08-27.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT "INTENDED" MEANS HERE, STATED SO IT CAN BE ARGUED WITH
--
-- Supabase runs ALTER DEFAULT PRIVILEGES on the public schema granting the full set to
-- anon and authenticated, so EVERY relation created in public starts life granted to
-- both, by name. Treating that default as a fault would put ~35 tables permanently red,
-- and a permanently red monitor is one nobody reads. So the line is drawn at whether a
-- SECOND GATE exists underneath the grant:
--
--   table, RLS ON            intended. RLS is the gate. Counted in the detail line so the
--                            single-layer posture stays visible rather than forgotten.
--   table, RLS OFF           PROBLEM. Nothing stands between the role and every row.
--   view, security_invoker   SELECT intended. The view runs as the caller, so RLS on the
--                            base tables is consulted as a real second gate.
--   view, security_invoker,  PROBLEM. ADR-039: the predicate constrains WHICH ROWS, only
--     with a write grant     the grant constrains WHAT OPERATIONS. A read-only view gets
--                            SELECT and nothing else.
--   view, owner-executing    PROBLEM for ANY privilege. It does not consult RLS at all, so
--   or materialised view     the grant is the whole of the protection.
--
-- This is deliberately NOT an allowlist of relation names. An allowlist would have to be
-- edited by the same person who just added the thing it is meant to catch.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- IT REPORTS A DISTINCT STATE WHEN IT HAS NOTHING TO EVALUATE
--
-- Every rule above is of the form "no relation is in a bad state". Over an empty catalog
-- they are all vacuously true and the check reads OK, which is the failure this codebase
-- keeps having: the monitor sweep whose loop never reached mon_019 and reported healthy,
-- the migration scan that proved history rather than present state, the fake that
-- swallowed .limit(). So a scan finding NO relations at all returns UNKNOWN and says so.
-- OK here means "I looked at N relations and they were fine", never "I looked at nothing".

CREATE OR REPLACE VIEW public.mon_024 AS
WITH rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity,
         COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'security_invoker'), 'false') = 'true' AS security_invoker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm')
),
-- EVERY privilege, not SELECT. MAINTAIN is Postgres 17 and is included because the point
-- of this monitor is that a partial list is how the last two misses happened.
held AS (
  SELECT r.relname, r.relkind, r.relrowsecurity, r.security_invoker,
         who.rolname, p.priv
    FROM rel r
    CROSS JOIN (SELECT unnest(ARRAY['anon', 'authenticated']) AS rolname) who
    CROSS JOIN (SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                    'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS priv) p
   WHERE has_table_privilege(who.rolname, r.oid, p.priv)
),
classified AS (
  SELECT h.*,
    CASE
      WHEN h.relkind = 'r' AND NOT h.relrowsecurity      THEN 'unprotected_table'
      WHEN h.relkind = 'r'                               THEN 'rls_backed_table'
      WHEN NOT h.security_invoker                        THEN 'rls_bypassing_view'
      WHEN h.priv <> 'SELECT'                            THEN 'view_write_grant'
      ELSE 'invoker_view_read'
    END AS verdict
  FROM held h
),
tally AS (
  SELECT
    (SELECT count(*) FROM rel) AS relations_scanned,
    count(*) FILTER (WHERE verdict = 'unprotected_table')  AS unprotected,
    count(*) FILTER (WHERE verdict = 'rls_bypassing_view') AS bypassing,
    count(*) FILTER (WHERE verdict = 'view_write_grant')   AS view_writes,
    count(*) FILTER (WHERE verdict = 'rls_backed_table')   AS rls_backed,
    count(*) FILTER (WHERE verdict = 'invoker_view_read')  AS invoker_reads,
    (SELECT count(DISTINCT relname) FROM classified WHERE verdict = 'rls_backed_table') AS rls_backed_relations,
    (SELECT string_agg(DISTINCT relname || ' (' || rolname || ')', ', ')
       FROM classified WHERE verdict = 'unprotected_table')  AS unprotected_names,
    (SELECT string_agg(DISTINCT relname || ' (' || rolname || ')', ', ')
       FROM classified WHERE verdict = 'rls_bypassing_view') AS bypassing_names,
    (SELECT string_agg(w.relname || ' (' || w.rolname || ': ' || w.privs || ')', ', ')
       FROM (SELECT relname, rolname, string_agg(priv, '/' ORDER BY priv) AS privs
               FROM classified WHERE verdict = 'view_write_grant'
              GROUP BY relname, rolname) w)                 AS view_write_names
  FROM classified
)
SELECT
  'MON-024'::text AS check_code,
  CASE
    -- NOTHING TO EVALUATE is its own answer, never OK. See the header.
    WHEN t.relations_scanned = 0 THEN 'UNKNOWN'::text
    WHEN t.unprotected > 0 OR t.bypassing > 0 OR t.view_writes > 0 THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN t.relations_scanned = 0
      THEN 'Nothing to evaluate: no tables, views or materialised views found in schema '
        || 'public. This is not a pass. Either the catalog query is wrong or this is not '
        || 'the database you think it is.'
    WHEN t.unprotected > 0
      THEN 'anon or authenticated can reach a table with RLS OFF, so nothing at all stands '
        || 'between them and every row: ' || COALESCE(t.unprotected_names, '?') || '.'
    WHEN t.bypassing > 0
      THEN 'anon or authenticated hold privileges on a view that does NOT run as the caller, '
        || 'so RLS on its base tables is never consulted: ' || COALESCE(t.bypassing_names, '?') || '.'
    WHEN t.view_writes > 0
      THEN 'A client-reachable view carries WRITE privileges, which is a write path into its '
        || 'base tables: ' || COALESCE(t.view_write_names, '?')
        || '. ADR-039: a read-only view gets SELECT and nothing else.'
    ELSE t.rls_backed || ' privilege(s) across ' || t.rls_backed_relations || ' RLS-backed table(s), '
      || 'and ' || t.invoker_reads || ' read(s) on views that run as the caller. '
      || 'No table with RLS off, no owner-executing view, and no write grant on any view. '
      || 'Scanned ' || t.relations_scanned || ' relations. Note that on the RLS-backed tables '
      || 'RLS is the ONLY layer: the grant underneath it is the Supabase default.'
  END AS detail,
  now() AS last_run
FROM tally t;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-024',
  'Nobody signed-out or signed-in can reach more than they should',
  'Reads the live catalog for all eight table privileges, not just SELECT, held by anon or '
    || 'authenticated across every table, view and materialised view in public. Fails on a '
    || 'table with RLS off, on any privilege held on a view that does not run as the caller, '
    || 'and on any write privilege on a client-reachable view. Returns UNKNOWN, not OK, if it '
    || 'finds no relations to check.',
  'data_integrity',
  1,
  false,
  NULL,
  'The two public roles, the signed-out visitor and any signed-in user, can only reach the '
    || 'data we meant them to reach, and can only read it rather than change it.',
  'This is the check that stands between a client and another client''s data, and between a '
    || 'client and settings only you control. It exists because the previous version of it '
    || 'asked who could READ and never asked who could WRITE, and a view that let a signed-in '
    || 'client change their own account settings passed that check twice. Nothing breaks when '
    || 'this goes wrong. It just quietly becomes possible.',
  'Read the detail line: it names the table or view, which role, and which operations. Then '
    || 'fix it with a migration that revokes by name and grants the real caller back, and read '
    || 'the privilege back for every role afterwards, in both directions. Never drop and '
    || 'recreate a view to fix it: Supabase re-grants both public roles the full set on '
    || 'creation, so a drop puts the problem straight back.'
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

-- ═════════════════════════════════════════════════════════════════════════════
-- GRANTS ON THE NEW VIEW ITSELF
--
-- Tighter than the older mon_* views were, for the reason this monitor exists. It reads
-- the privilege layout of the whole schema, which is a map of where to attack.

REVOKE ALL ON public.mon_024 FROM PUBLIC;
REVOKE ALL ON public.mon_024 FROM anon, authenticated;
GRANT SELECT ON public.mon_024 TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- THE FIRST THING MON-024 FOUND, FIXED HERE SO IT IS NOT BORN RED
--
-- client_prospects_view is the client's READ surface for their own prospects. It is
-- security_invoker, so ADR-039's first clause was already satisfied and it was not part of
-- the 2026-08-26 leak. But authenticated held the full default set on it, including
-- INSERT, UPDATE, DELETE and TRUNCATE, and information_schema reports the view
-- is_updatable = YES.
--
-- The blast radius is smaller than client_organisation_view's was, because
-- security_invoker means RLS on prospects still applies to the caller, and the only client
-- UPDATE policy there is already scoped to their own organisation. So this is a REDUNDANT
-- write path rather than an escalation: it grants nothing the client cannot already do on
-- the base table. It should still not be there, for the reason ADR-039 gives about
-- client_organisation_view: the view's safety would then rest entirely on the policies of
-- a different table, and a later legitimate policy change reopens it silently.
--
-- ADR-039 clause 2, applied to the relation it missed: a read-only view gets SELECT and
-- nothing else. Revoked rather than dropped and recreated, because a drop loses the ACL
-- and Supabase's default privileges re-grant the full set at creation.
--
-- Nothing in src/ writes through this view: it is referenced only by generated types.

REVOKE ALL ON public.client_prospects_view FROM anon, authenticated;
GRANT SELECT ON public.client_prospects_view TO authenticated;
