-- Defence in depth on the paid-call ledger.
--
-- RLS is enabled on verification_calls with no policies, and that was VERIFIED to work
-- before this migration was written: with a live row present, a session running as anon
-- read 0 rows. The check used BEGIN ... ROLLBACK so the probe row was never committed, per
-- the standing rule in CLAUDE.md about diagnostics on side-effecting statements.
--
-- So why revoke anything? Because Supabase runs ALTER DEFAULT PRIVILEGES on the public
-- schema, and a table created there receives EXPLICIT, BY-NAME grants to anon and
-- authenticated at creation time. Read back immediately after creating the table:
--
--     has_table_privilege('anon', 'public.verification_calls', 'SELECT')  ->  true
--
-- RLS is what makes that harmless today. The grant is what it would cost tomorrow: if RLS
-- were ever disabled, or a later migration added a permissive policy, that grant is the only
-- thing between an unauthenticated caller and the spend ledger. Two independent controls
-- cost one line here.
--
-- CLAUDE.md's standing warning that REVOKE FROM PUBLIC is a silent no-op on Supabase is
-- written about FUNCTIONS. This is the table equivalent of the same trap, and it is closed
-- the same way: revoke the roles BY NAME, grant the legitimate caller back explicitly, and
-- read the privilege back for the roles that must NOT have it as well as the one that must.
-- Checking only service_role would have passed while the grant stayed open, which is the
-- entire failure mode the rule exists to prevent.
--
-- Status: APPLIED (verified live 2026-08-25)
--
-- Read-back immediately after apply, all seven as intended:
--
--   service_role SELECT / INSERT / UPDATE  ->  true,  true,  true
--   anon          SELECT / INSERT          ->  false, false
--   authenticated SELECT / INSERT          ->  false, false

REVOKE ALL ON TABLE public.verification_calls FROM anon, authenticated;

GRANT ALL ON TABLE public.verification_calls TO service_role;
