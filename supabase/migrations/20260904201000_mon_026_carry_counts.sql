-- Migration: MON-026 also watches whether suppressions REACHED the provider
-- Date: 2026-09-04
--
-- Status: APPLIED (verified live 2026-09-04)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT MON-026 COULD NOT SEE
--
-- The reconciliation sweep starts from prospects with outbound_upload_status = 'uploaded'
-- and asks the provider about each one the send gate blocks. That is the right question
-- and it is not the whole question.
--
-- An address on the GLOBAL suppression list with no uploaded prospect row of ours is
-- invisible to it. There is nothing to iterate, so the sweep reports zero unreconciled and
-- is structurally unable to check the address at all. Zero, from a set that was never
-- looked at, is the exact reading CLAUDE.md records being misled by three times.
--
-- Two new counts are read from suppressed_emails DIRECTLY, so they do not inherit that
-- blind spot:
--
--   uncarried_count      active suppressions never carried to the provider, past a grace
--                        window. This is the state the only bounce this system has ever
--                        seen has been in since 2026-08-28.
--   carry_failed_count   active suppressions whose last carry attempt failed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE CARRY CHECKS COME BEFORE THE VACUITY CHECK
--
-- The view returns UNKNOWN when uploaded_count = 0, because a sweep with no prospects to
-- examine has proved nothing. That guard is right and stays.
--
-- But the carry counts are meaningful even then: an address can be suppressed, uncarried
-- and still being mailed with no uploaded prospect row on our side at all. So the carry
-- conditions are evaluated FIRST. Leaving them below the vacuity guard would hide the one
-- class of failure these columns were added to reveal.
--
-- 'incomplete' moves above the vacuity guard for the same reason: a run that could not
-- finish is a stronger statement than a run that found nothing to do, and it must not be
-- softened to UNKNOWN by an empty prospect set.

ALTER TABLE public.suppression_reconciliation_snapshot
  -- NOT NULL DEFAULT 0 so the existing single row stays valid. A default of 0 is safe here
  -- ONLY because the run that fills them also sets incomplete when it cannot read them:
  -- see readCarryState in src/lib/suppression/reconcile.ts, which returns null on a query
  -- failure rather than zeros, and the view treats incomplete as PROBLEM.
  ADD COLUMN IF NOT EXISTS uncarried_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carry_failed_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.suppression_reconciliation_snapshot.uncarried_count IS
  'Active suppressions never carried to the sending provider, past the grace window. Read '
  'from suppressed_emails directly, so it covers addresses with no uploaded prospect row, '
  'which the prospect-based pass cannot see at all.';

COMMENT ON COLUMN public.suppression_reconciliation_snapshot.carry_failed_count IS
  'Active suppressions whose last carry attempt to the provider failed. Retried by the '
  'carry sweep after its backoff; red here until it succeeds.';

CREATE OR REPLACE VIEW public.mon_026 AS
WITH snap AS (
  SELECT * FROM public.suppression_reconciliation_snapshot WHERE id = 1
)
SELECT
  'MON-026'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)                                    THEN 'UNKNOWN'::text
    -- FRESHNESS FIRST. The sweep runs every 30 minutes; 90 allows two missed runs before
    -- alarming, and a stale verdict is never trusted whatever it says.
    WHEN (SELECT computed_at FROM snap) < now() - interval '90 minutes'     THEN 'PROBLEM'::text
    -- A run that could not finish cannot be softened by anything below it.
    WHEN (SELECT incomplete FROM snap)                                      THEN 'PROBLEM'::text
    -- THE CARRY COUNTS, ABOVE THE VACUITY GUARD. See the header: these are exactly the
    -- addresses the prospect-based pass is structurally unable to reach.
    WHEN (SELECT carry_failed_count FROM snap) > 0                          THEN 'PROBLEM'::text
    WHEN (SELECT uncarried_count FROM snap) > 0                             THEN 'PROBLEM'::text
    -- Vacuous truth is not a pass.
    WHEN (SELECT uploaded_count FROM snap) = 0                              THEN 'UNKNOWN'::text
    WHEN (SELECT unreconciled_count FROM snap) > 0                          THEN 'PROBLEM'::text
    WHEN (SELECT invariant_breach_count FROM snap) > 0                      THEN 'PROBLEM'::text
    WHEN (SELECT unreachable_count FROM snap) > 0                           THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No suppression reconciliation has run yet. Expected until the first '
        || 'suppression-reconcile firing after deploy; if it persists, the sweep is not '
        || 'running and nothing is comparing our suppression list against the provider.'
    WHEN (SELECT computed_at FROM snap) < now() - interval '90 minutes'
      THEN 'The suppression reconciliation is '
        || round(EXTRACT(epoch FROM now() - (SELECT computed_at FROM snap)) / 60)::text
        || ' minutes old, past the 90-minute limit. It last said: "'
        || (SELECT detail FROM snap)
        || '" That answer describes a window that has moved on, so it is not being reported '
        || 'as current. suppression-reconcile runs every 30 minutes: check it is still running.'
    -- The vacuity message must no longer claim there is nothing to evaluate when the carry
    -- counts DID evaluate something. It is only reached when both are zero.
    WHEN (SELECT uploaded_count FROM snap) = 0
      THEN 'Nothing to evaluate against the provider: no prospect has been uploaded, so '
        || 'there is nothing it could still be sending to. Every active suppression has '
        || 'reached the provider, which was checked separately. This is not a pass.'
    ELSE (SELECT detail FROM snap)
  END AS detail,
  (SELECT computed_at FROM snap) AS last_run;

-- Re-stated rather than assumed. CREATE OR REPLACE VIEW preserves privileges, but the
-- standing rule is to read them back rather than trust that, and a view with
-- security_invoker unset that anon can read is an outright read of its base tables.
REVOKE ALL ON public.mon_026 FROM PUBLIC;
REVOKE ALL ON public.mon_026 FROM anon, authenticated;
GRANT SELECT ON public.mon_026 TO service_role;

-- Verification, in BOTH directions. Expected: t, f, f.
SELECT
  has_table_privilege('service_role',  'public.mon_026', 'SELECT') AS service_select,
  has_table_privilege('anon',          'public.mon_026', 'SELECT') AS anon_select,
  has_table_privilege('authenticated', 'public.mon_026', 'SELECT') AS authenticated_select;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--
-- Restore the previous view body from 20260904110000_mon_026_suppression_reconciliation.sql
-- and drop the two columns:
--
--   ALTER TABLE public.suppression_reconciliation_snapshot
--     DROP COLUMN IF EXISTS uncarried_count,
--     DROP COLUMN IF EXISTS carry_failed_count;
--
-- The monitor returns to watching only what the prospect-based pass can see.
