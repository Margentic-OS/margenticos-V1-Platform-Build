-- Status: APPLIED (verified live 2026-09-10)
-- MON-026: stop narrating a failed read as a measured zero.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE DEFECT
--
-- The view holds TWO CASE expressions over the same conditions, one producing state and
-- one producing detail, and they had drifted. The state CASE tests `incomplete` before it
-- tests `uploaded_count = 0`. The detail CASE did not test `incomplete` at all.
--
-- So when the reconcile sweep could not read prospects (PostgREST returned Gateway
-- Timeout, twice on 2026-09-09/10), the snapshot stored incomplete = true and
-- uploaded_count = 0, and:
--
--   state  -> hit the `incomplete` branch     -> PROBLEM        (correct)
--   detail -> fell through to `uploaded = 0`  -> "no prospect has been uploaded"
--
-- 97 prospects are uploaded. The sentence was false, and false in the REASSURING
-- direction: it reads as a campaign that has not started rather than as a database that
-- timed out. The state was never wrong, so this was never a false pass. It was a true
-- alarm with a misleading reason attached, which is worse than no reason, because a reader
-- stops looking.
--
-- Same family as the parallel arrays in monitor-sweep and the `relkind = 'r'` audit query:
-- two lists over the same thing, kept in step by hand, and nothing to notice when they part.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE INVARIANT, which the test in
-- src/app/api/cron/monitor-sweep/__tests__/mon-026-detail-mirrors-state.test.ts enforces
--
-- Every condition the STATE case evaluates BEFORE `uploaded_count = 0` must also be
-- evaluated by the DETAIL case before `uploaded_count = 0`.
--
-- The reason is precise: the `uploaded_count = 0` branch of DETAIL asserts a FACT ABOUT
-- THE WORLD ("no prospect has been uploaded"). It must never be reached when an earlier
-- condition has already established that the reading cannot be trusted. carry_failed_count
-- and uncarried_count are given explicit branches too, so the precedence is stated rather
-- than inherited from the ELSE.
--
-- Everything else about the view is unchanged: same states, same thresholds, same strings.

CREATE OR REPLACE VIEW public.mon_026 AS
WITH snap AS (
  SELECT id, uploaded_count, blocked_count, checked_count, unreconciled_count,
         unreachable_count, settling_count, invariant_breach_count, incomplete,
         unreconciled_prospect_ids, detail, computed_at, uncarried_count, carry_failed_count
    FROM suppression_reconciliation_snapshot
   WHERE id = 1
)
SELECT
  'MON-026'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)                                             THEN 'UNKNOWN'::text
    WHEN (SELECT snap.computed_at FROM snap) < (now() - '01:30:00'::interval)        THEN 'PROBLEM'::text
    WHEN (SELECT snap.incomplete FROM snap)                                          THEN 'PROBLEM'::text
    WHEN (SELECT snap.carry_failed_count FROM snap) > 0                              THEN 'PROBLEM'::text
    WHEN (SELECT snap.uncarried_count FROM snap) > 0                                 THEN 'PROBLEM'::text
    WHEN (SELECT snap.uploaded_count FROM snap) = 0                                  THEN 'UNKNOWN'::text
    WHEN (SELECT snap.unreconciled_count FROM snap) > 0                              THEN 'PROBLEM'::text
    WHEN (SELECT snap.invariant_breach_count FROM snap) > 0                          THEN 'PROBLEM'::text
    WHEN (SELECT snap.unreachable_count FROM snap) > 0                               THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No suppression reconciliation has run yet. Expected until the first suppression-reconcile firing after deploy; if it persists, the sweep is not running and nothing is comparing our suppression list against the provider.'::text
    WHEN (SELECT snap.computed_at FROM snap) < (now() - '01:30:00'::interval)
      THEN 'The suppression reconciliation is '::text
           || round(EXTRACT(epoch FROM now() - (SELECT snap.computed_at FROM snap)) / 60::numeric)::text
           || ' minutes old, past the 90-minute limit. It last said: "'::text
           || (SELECT snap.detail FROM snap)
           || '" That answer describes a window that has moved on, so it is not being reported as current. suppression-reconcile runs every 30 minutes: check it is still running.'::text
    -- ── These three MIRROR the state CASE and must stay above `uploaded_count = 0`. ──
    -- Each means the stored counts are not a measurement, so the stored sentence (which
    -- already names the real cause, e.g. "could not read uploaded prospects: Gateway
    -- Timeout") is the honest thing to show.
    WHEN (SELECT snap.incomplete FROM snap)             THEN (SELECT snap.detail FROM snap)
    WHEN (SELECT snap.carry_failed_count FROM snap) > 0 THEN (SELECT snap.detail FROM snap)
    WHEN (SELECT snap.uncarried_count FROM snap) > 0    THEN (SELECT snap.detail FROM snap)
    -- Only now is a zero a measured zero.
    WHEN (SELECT snap.uploaded_count FROM snap) = 0
      THEN 'Nothing to evaluate against the provider: no prospect has been uploaded, so there is nothing it could still be sending to. Every active suppression has reached the provider, which was checked separately. This is not a pass.'::text
    ELSE (SELECT snap.detail FROM snap)
  END AS detail,
  (SELECT snap.computed_at FROM snap) AS last_run;
