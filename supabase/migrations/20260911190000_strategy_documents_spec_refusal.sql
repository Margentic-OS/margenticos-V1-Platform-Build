-- Records, on each version of the ICP, why its search specification could not be built.
-- Status: APPLIED (verified live 2026-09-11, production hjpvnvjryxdjcfdsfhzy and test
-- tidqheqjzvwmrrrebzir). Read back: jsonb, nullable, comment present, RLS still on;
-- anon cannot SELECT it, authenticated and service_role match icp_filter_spec exactly.
--
-- WHY. Every path that promotes an ICP (approve, auto-approve, revise, revert) builds
-- icp_filter_spec in the background AFTER the new version is live and the request has
-- already reported success. When the build refused, icp_filter_spec stayed NULL and the only
-- record of why was a Sentry event. Measured 2026-09-08 on one live client: three versions
-- in a row went live with no specification, each reported to the operator as a success.
--
-- persistIcpFilterSpec now writes the refusal here, naming the cause, and the strategy page
-- shows it to the operator. It is cleared in the same write that stores a spec.
--
-- SHAPE. { "reason": text, "detail": text, "recorded_at": timestamptz as text }.
-- The reasons are defined in src/lib/sourcing/spec-refusal.ts. Deliberately NOT a CHECK
-- constraint on the reason: adding a reason should need a code change, not a migration, and
-- the reader treats an unknown reason as a refusal rather than a pass.
--
-- WHY A NEW COLUMN AND NOT A VALUE INSIDE icp_filter_spec. A NULL spec is the signal the
-- sourcing orchestrator already refuses on. Putting a refusal object in that column would
-- make it non-NULL, and sourcing would read a refusal as a spec.
--
-- PRIVILEGES. Additive and nullable. The column inherits strategy_documents' existing table
-- grants and RLS policies, which scope every row to its organisation. No grant changes here.
-- Existing rows read NULL, which the page shows as "not built" only when icp_filter_spec is
-- also NULL.

ALTER TABLE public.strategy_documents
  ADD COLUMN IF NOT EXISTS icp_filter_spec_refusal jsonb;

COMMENT ON COLUMN public.strategy_documents.icp_filter_spec_refusal IS
  'Why this version''s icp_filter_spec could not be built: {reason, detail, recorded_at}. '
  'Written by persistIcpFilterSpec, cleared when a spec is stored. NULL = no refusal recorded.';
