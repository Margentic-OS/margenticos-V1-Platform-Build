-- Pin search_path on the five functions the advisor flagged as mutable.
--
-- Status: APPLIED (verified live 2026-08-27)
--
-- READ-BACK AFTER APPLY, all five pg_proc.proconfig = {"search_path=public, pg_temp"}:
--   append_faq_variant, job_queue_backoff, set_updated_at,
--   validate_faqs_org_exists, validate_faq_extractions_org_consistency
--
-- BEHAVIOUR RE-TESTED, not just the setting read back:
--   set_updated_at   -> fired on an UPDATE to organisations, updated_at advanced
--   job_queue_backoff(3) -> 00:04:31.123665 (inside the 30s..900s jittered band)
-- Both in a transaction forced to abort; nothing committed.
--
-- Advisor re-pulled after apply: all five function_search_path_mutable WARNs cleared.
--
-- Advisor WARN 0011_function_search_path_mutable, production, 2026-08-27.
--
-- A function with no search_path setting resolves unqualified names using whatever
-- search_path the CALLER happens to have set. Read back before writing this file
-- (pg_proc.proconfig was NULL on all five):
--
--   append_faq_variant(uuid, text)              SECURITY DEFINER  service_role only
--   job_queue_backoff(integer)                  security invoker  service_role only
--   set_updated_at()                            security invoker  trigger, anon+auth EXECUTE
--   validate_faqs_org_exists()                  security invoker  trigger, anon+auth EXECUTE
--   validate_faq_extractions_org_consistency()  security invoker  trigger, anon+auth EXECUTE
--
-- append_faq_variant is the one that actually matters: SECURITY DEFINER means it runs as
-- postgres, so a caller who could steer name resolution could get an UPDATE executed
-- against an object of their choosing with owner privileges. Its EXECUTE is already
-- limited to service_role, which is why this is a WARN and not an incident.
--
-- The other four are SECURITY INVOKER and carry no privilege escalation, but the three
-- trigger functions run inside transactions started by anon and authenticated, so their
-- name resolution should not be caller-steerable either. job_queue_backoff touches only
-- pg_catalog builtins and is included for completeness rather than risk.
--
-- WHY `public, pg_temp` AND NOT JUST `public`
--
-- If pg_temp is not named in search_path, Postgres searches the temporary schema FIRST
-- for relation names. Setting only `public` therefore leaves the shadowing route open on
-- the SECURITY DEFINER function. Naming pg_temp explicitly and LAST is the documented
-- mitigation, and it changes nothing about how public objects resolve.
--
-- Every unqualified name in these five bodies (faqs, signals, reply_drafts,
-- organisations, faq_extractions) lives in public, so resolution is unchanged. This is a
-- pin, not a rewrite: no function body is touched, so no behaviour moves.
--
-- NOTE: get_my_organisation_id() and is_operator() already carry `SET search_path TO
-- 'public'` and are not flagged. They predate this convention and name only `public`.
-- Aligning them to `public, pg_temp` is a separate, lower-priority change and is in
-- BACKLOG rather than bundled here, because both are load-bearing for 27 RLS policies
-- across 17 tables and should move on their own evidence.

ALTER FUNCTION public.set_updated_at()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.append_faq_variant(p_faq_id uuid, p_new_variant text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.validate_faqs_org_exists()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.validate_faq_extractions_org_consistency()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.job_queue_backoff(p_attempts integer)
  SET search_path = public, pg_temp;
