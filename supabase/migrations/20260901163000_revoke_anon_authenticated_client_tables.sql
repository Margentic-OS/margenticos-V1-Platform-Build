-- 20260901163000_revoke_anon_authenticated_client_tables.sql
--
-- Status: APPLIED (verified live 2026-09-01)
--   Applied via MCP apply_migration as `revoke_anon_authenticated_client_tables`.
--   Section 5 passed in-transaction AND again post-commit against committed state.
--   anon: 27/27 tables now denied at the GRANT layer over live PostgREST (401/403),
--   where before every one returned HTTP 200 with RLS as the only filter.
--   Smoke-tested signed in: /dashboard and /dashboard/strategy/icp as a client,
--   /dashboard/operator and /dashboard/operator/clients/[id] as operator. All HTTP 200
--   with real data. No-session control still redirects to /login.
--   integrations_registry deliberately untouched, anon grants unchanged (still 1111).
--
-- WHAT THIS DOES
-- Removes the automatic Supabase grants that hand `anon` and `authenticated` full
-- arwdDxtm on 27 client-data tables, and grants back only what each role actually needs.
--
-- WHY
-- Supabase runs ALTER DEFAULT PRIVILEGES on the public schema, so every table created
-- there receives EXPLICIT BY-NAME grants to anon, authenticated and service_role at
-- creation time. Nothing added these deliberately. Measured 2026-09-01, all 27 tables
-- below carried anon=arwdDxtm/postgres — read, insert, update AND delete, not just SELECT.
--
-- RLS is currently the only thing stopping anon. It holds: anon sees 0 rows on every
-- table, verified over the live PostgREST endpoint with the anon key, not inferred from
-- GRANT statements. But there is no second layer. One permissive policy naming anon, or
-- one ALTER TABLE ... DISABLE ROW LEVEL SECURITY during debugging, and the UPDATE and
-- DELETE that today "run and match nothing" become a mass overwrite or a mass delete.
--
-- This migration adds that second layer. It does not change RLS, and does not touch
-- any policy.
--
-- NOT INCLUDED — integrations_registry
-- It is the one table with a real browser-side anon-key read:
-- src/components/operator/enrichment-mode-banner.tsx runs a raw supabase-js createClient
-- with NEXT_PUBLIC_SUPABASE_ANON_KEY inside a useEffect. Left alone pending a separate
-- decision. See the review notes.
--
-- SAFETY ARGUMENT FOR THE authenticated NARROWING
-- Each table's authenticated grant is narrowed to exactly the verbs its own policies
-- permit. This cannot break a call that works today: if a call succeeds now, a policy
-- must already permit that verb, and that verb is granted below. It can only convert a
-- call that already fails at RLS into one that fails at the grant instead.
--
-- LOCKING — measured, not assumed
-- REVOKE on a table takes only AccessShareLock on pg_class. It does NOT take
-- ACCESS EXCLUSIVE on the target table. Verified 2026-09-01 by reading pg_locks inside a
-- rolled-back transaction. Concurrent reads and writes are not blocked.

-- NOTE: no explicit BEGIN/COMMIT. MCP apply_migration wraps this file in a single
-- transaction, so the privilege swap is still atomic. An explicit BEGIN here would
-- nest, and the COMMIT would end apply_migration's transaction early.

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — REVOKE FROM PUBLIC
--
-- Per the CLAUDE.md pattern. Measured note: PUBLIC holds no grant on any of these
-- tables (no bare "=arwdDxtm/postgres" entry in any relacl), so every statement here
-- is a NO-OP. It is included because a REVOKE FROM PUBLIC that silently does nothing
-- is exactly the false-safety failure this project has already been bitten by, and
-- leaving it out would make a future reader wonder whether it was forgotten.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE
  public.agent_runs, public.campaigns, public.document_suggestions,
  public.enrichment_runs, public.faq_extractions, public.faqs,
  public.industry_tag_mappings, public.intake_files, public.intake_responses,
  public.intake_website_pages, public.integration_credentials, public.meetings,
  public.monitor_checks, public.monitor_events, public.notifications_log,
  public.organisations, public.patterns, public.polling_cursors,
  public.prospect_research_results, public.prospects, public.reply_drafts,
  public.reply_handling_actions, public.segments, public.signals,
  public.strategy_documents, public.users, public.users_pending_review
FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — REVOKE anon AND authenticated BY NAME
--
-- This is the statement that actually does the work. Both roles named explicitly,
-- because the grants were made explicitly by name.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE
  public.agent_runs, public.campaigns, public.document_suggestions,
  public.enrichment_runs, public.faq_extractions, public.faqs,
  public.industry_tag_mappings, public.intake_files, public.intake_responses,
  public.intake_website_pages, public.integration_credentials, public.meetings,
  public.monitor_checks, public.monitor_events, public.notifications_log,
  public.organisations, public.patterns, public.polling_cursors,
  public.prospect_research_results, public.prospects, public.reply_drafts,
  public.reply_handling_actions, public.segments, public.signals,
  public.strategy_documents, public.users, public.users_pending_review
FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — GRANT service_role BACK, EXPLICITLY
--
-- service_role is the real caller for almost everything: every agent, every cron
-- route, and the data half of every ADR-027 two-client route. Granted before the
-- authenticated grants so that if this migration were ever split, the privileged
-- path is restored first.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE
  public.agent_runs, public.campaigns, public.document_suggestions,
  public.enrichment_runs, public.faq_extractions, public.faqs,
  public.industry_tag_mappings, public.intake_files, public.intake_responses,
  public.intake_website_pages, public.integration_credentials, public.meetings,
  public.monitor_checks, public.monitor_events, public.notifications_log,
  public.organisations, public.patterns, public.polling_cursors,
  public.prospect_research_results, public.prospects, public.reply_drafts,
  public.reply_handling_actions, public.segments, public.signals,
  public.strategy_documents, public.users, public.users_pending_review
TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — GRANT authenticated BACK, ONLY WHERE A POLICY NEEDS IT
--
-- The session client (@/lib/supabase/server, anon key + session cookie) runs as
-- `authenticated`. Verb lists below are derived from pg_policies: the union of cmds
-- across policies naming `authenticated` OR the `public` ROLE (which includes it —
-- enrichment_runs is the only table relying on that, and missing it would have
-- broken the operator enrichment screens).
-- ─────────────────────────────────────────────────────────────────────────────

-- 4a. Tables with an ALL policy (or the full four as separate policies).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.campaigns, public.document_suggestions, public.enrichment_runs,
  public.faq_extractions, public.faqs, public.intake_responses,
  public.intake_website_pages, public.integration_credentials, public.meetings,
  public.organisations, public.patterns, public.prospects, public.reply_drafts,
  public.segments, public.signals, public.strategy_documents, public.users
TO authenticated;

-- 4b. Read-only for authenticated: every policy on these is SELECT.
GRANT SELECT ON TABLE
  public.agent_runs, public.polling_cursors, public.prospect_research_results,
  public.reply_handling_actions, public.users_pending_review
TO authenticated;

-- 4c. Mixed verb sets, granted exactly.
GRANT SELECT, INSERT, UPDATE ON TABLE public.industry_tag_mappings TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.intake_files          TO authenticated;

-- 4d. DELIBERATELY NOT GRANTED TO authenticated.
--
--   notifications_log  — has ZERO policies, so RLS already denies authenticated every
--                        row. The grant is inert today. Granting it back would restore
--                        an inert privilege and imply an access level that does not
--                        exist. See review note 3: one caller
--                        (dashboard/operator/clients/[id]/actions.ts:1060) writes here
--                        through the SESSION client and is already failing.
--
--   monitor_checks     — authenticated already holds NOTHING on these two, measured
--   monitor_events       2026-09-01 (a_sel/a_ins/a_upd/a_del all false), while anon
--                        held all four. Granting authenticated here would WIDEN access
--                        beyond today's state, which is outside this migration's brief.
--                        Their authenticated SELECT policies are currently dead letters.
--                        See review note 4.


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — READ-BACK VERIFICATION, IN BOTH DIRECTIONS
--
-- Checking only the role that must have access proves nothing about who else does;
-- that is the 2026-08-24 failure mode. This block asserts the roles that must NOT
-- have access as well, and RAISEs so a bad apply cannot be reported as a good one.
--
-- It runs TWICE, deliberately:
--   1. Here, inside apply_migration's transaction. A failure aborts the whole
--      migration, so a bad privilege set can never be committed in the first place.
--   2. Again after commit, run separately via execute_sql, so the assertions are
--      also made against COMMITTED state rather than only against the transaction's
--      own uncommitted view. An in-transaction check that passes and a committed
--      state that differs is exactly the gap this project keeps falling into.
--
-- Expect zero output other than the final NOTICE.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t              text;
  v              text;
  failures       text[] := '{}';
  -- Every table this migration touched.
  revoked_tables text[] := ARRAY[
    'agent_runs','campaigns','document_suggestions','enrichment_runs','faq_extractions',
    'faqs','industry_tag_mappings','intake_files','intake_responses','intake_website_pages',
    'integration_credentials','meetings','monitor_checks','monitor_events','notifications_log',
    'organisations','patterns','polling_cursors','prospect_research_results','prospects',
    'reply_drafts','reply_handling_actions','segments','signals','strategy_documents',
    'users','users_pending_review'];
BEGIN
  -- 5a. anon must hold NOTHING on any of them. This is the whole point.
  FOREACH t IN ARRAY revoked_tables LOOP
    FOREACH v IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege('anon', format('public.%I', t), v) THEN
        failures := failures || format('anon STILL HAS %s on %s', v, t);
      END IF;
    END LOOP;
  END LOOP;

  -- 5b. service_role must retain SELECT on all of them, or the app is down.
  FOREACH t IN ARRAY revoked_tables LOOP
    IF NOT has_table_privilege('service_role', format('public.%I', t), 'SELECT') THEN
      failures := failures || format('service_role LOST SELECT on %s', t);
    END IF;
  END LOOP;

  -- 5c. authenticated must retain SELECT exactly where a policy needs it.
  FOREACH t IN ARRAY ARRAY[
    'agent_runs','campaigns','document_suggestions','enrichment_runs','faq_extractions',
    'faqs','industry_tag_mappings','intake_files','intake_responses','intake_website_pages',
    'integration_credentials','meetings','organisations','patterns','polling_cursors',
    'prospect_research_results','prospects','reply_drafts','reply_handling_actions',
    'segments','signals','strategy_documents','users','users_pending_review'] LOOP
    IF NOT has_table_privilege('authenticated', format('public.%I', t), 'SELECT') THEN
      failures := failures || format('authenticated LOST SELECT on %s (dashboard will break)', t);
    END IF;
  END LOOP;

  -- 5d. authenticated must NOT have gained anything on the 4d set.
  FOREACH t IN ARRAY ARRAY['notifications_log','monitor_checks','monitor_events'] LOOP
    FOREACH v IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege('authenticated', format('public.%I', t), v) THEN
        failures := failures || format('authenticated UNEXPECTEDLY HAS %s on %s', v, t);
      END IF;
    END LOOP;
  END LOOP;

  -- 5e. authenticated must not hold write verbs where policies are SELECT-only.
  FOREACH t IN ARRAY ARRAY['agent_runs','polling_cursors','prospect_research_results',
                           'reply_handling_actions','users_pending_review'] LOOP
    FOREACH v IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege('authenticated', format('public.%I', t), v) THEN
        failures := failures || format('authenticated STILL HAS %s on read-only table %s', v, t);
      END IF;
    END LOOP;
  END LOOP;

  -- 5f. RLS must still be on everywhere. This migration must not have disturbed it.
  FOREACH t IN ARRAY revoked_tables LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = t) THEN
      failures := failures || format('RLS IS OFF on %s', t);
    END IF;
  END LOOP;

  IF array_length(failures, 1) > 0 THEN
    RAISE EXCEPTION 'PRIVILEGE VERIFICATION FAILED:%s', chr(10) || array_to_string(failures, chr(10));
  END IF;

  RAISE NOTICE 'OK: 27 tables. anon holds nothing; service_role intact; authenticated narrowed to policy verbs; RLS on.';
END $$;
