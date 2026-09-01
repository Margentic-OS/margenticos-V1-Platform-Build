-- 20260901210000_revoke_anon_integrations_registry.sql
--
-- Status: APPLIED (verified live 2026-09-01)
--   Applied via MCP apply_migration as `revoke_anon_integrations_registry`,
--   recorded as version 20260901204306 (apply_migration stamps its own timestamp;
--   the filename timestamp is not the recorded version on this project).
--   Read-back passed in-transaction and again post-commit against committed state.
--   Database now holds ZERO anon-readable relations across 38 tables and 25 views,
--   zero anon-writable relations, and zero tables without RLS.
--   Smoke-tested signed in: /dashboard/operator, /dashboard/operator/clients/[id],
--   /dashboard/operator/sourcing-review and the client /dashboard all HTTP 200 with
--   no errors; the enrichment banner still resolves and renders Live Enrichment
--   Active through the operator session. No-session control still 307s to /login.
--
-- WHAT THIS DOES
-- Removes the automatic Supabase anon/authenticated grants from the last remaining
-- table that still carried them, and grants back only what its policy needs.
--
-- WHY IT WAS LEFT OUT LAST TIME
-- 20260901163000 revoked anon on 27 client-data tables and deliberately skipped this
-- one, because enrichment-mode-banner.tsx built a supabase-js client with the PUBLIC
-- ANON KEY in the browser and read this table from a useEffect. Revoking then would
-- have changed a live component's behaviour inside a security migration.
--
-- That read no longer exists. The banner now receives its mode as a prop, resolved
-- server-side in the operator layout by resolveEnrichmentMode() using the operator's
-- own session. Confirmed by the key-based sweep rather than by grepping for the client
-- factory: zero files in src/ both reference NEXT_PUBLIC_SUPABASE_ANON_KEY and touch
-- integrations_registry, and no client component performs any database query at all.
-- The factory grep is what missed this the first time, so it is not what was used.
--
-- WHAT anon COULD DO BEFORE THIS
-- Hold arwdDxtm. RLS held: an anon read returned 200 with zero rows, because the only
-- policy is operators_full_access_integrations and it requires is_operator(). But UPDATE
-- and DELETE reached the table and matched nothing, one policy change away from letting
-- an unauthenticated caller rewrite integrations_registry.config. That config is what
-- decides whether enrichment calls Apollo for real: config.enrichment_live is read by
-- shouldUseMockEnrichment on every enrichment run. Flipping it is a spend decision.
--
-- authenticated keeps all four verbs because operators_full_access_integrations is an
-- ALL policy, and the operator layout now reads this table through the session client.
-- Granting less would break the enrichment banner.
--
-- DRY RUN, before applying: executed in full inside BEGIN ... ROLLBACK against
-- production. anon dropped to all-false, authenticated kept all four, service_role kept
-- all four, and the count of anon-readable tables in `public` went to ZERO.

REVOKE ALL ON TABLE public.integrations_registry FROM PUBLIC;

REVOKE ALL ON TABLE public.integrations_registry FROM anon, authenticated;

GRANT ALL ON TABLE public.integrations_registry TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integrations_registry TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- READ-BACK, IN BOTH DIRECTIONS
--
-- Asserts the roles that must NOT have access as well as the ones that must. Checking
-- only the intended caller is what let the 2026-08-24 hole stay open while the
-- verification reported success.
--
-- Runs inside apply_migration's transaction so a bad grant set aborts rather than
-- commits, and is re-run afterwards against committed state.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v text; failures text[] := '{}'; anon_readable int;
BEGIN
  FOREACH v IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    IF has_table_privilege('anon', 'public.integrations_registry', v) THEN
      failures := failures || format('anon STILL HAS %s on integrations_registry', v);
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.integrations_registry', v) THEN
      failures := failures || format('authenticated LOST %s (operator banner will break)', v);
    END IF;
    IF NOT has_table_privilege('service_role', 'public.integrations_registry', v) THEN
      failures := failures || format('service_role LOST %s on integrations_registry', v);
    END IF;
  END LOOP;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'integrations_registry') THEN
    failures := failures || 'RLS IS OFF on integrations_registry';
  END IF;

  -- The whole-database property this migration completes. Views and matviews included,
  -- because a view over a locked table is the class the old relkind='r' audit could not
  -- see.
  SELECT count(*) INTO anon_readable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m')
     AND has_table_privilege('anon', c.oid, 'SELECT');

  IF anon_readable <> 0 THEN
    failures := failures || format('%s relation(s) in public are still anon-readable', anon_readable);
  END IF;

  IF array_length(failures, 1) > 0 THEN
    RAISE EXCEPTION 'PRIVILEGE VERIFICATION FAILED:%', chr(10) || array_to_string(failures, chr(10));
  END IF;

  RAISE NOTICE 'OK: anon holds nothing on integrations_registry; zero anon-readable relations in public.';
END $$;
