-- MON-034 — a research source that stopped coming back.
--
-- Status: APPLIED (verified live 2026-09-23) to BOTH projects:
--   hjpvnvjryxdjcfdsfhzy  production
--   tidqheqjzvwmrrrebzir  test
-- Read back in both directions: service_role SELECT t, anon/authenticated SELECT f, and
-- anon/authenticated INSERT/UPDATE/DELETE all f.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS READS RESEARCH ROWS RATHER THAN A NEW COLUMN
--
-- The obvious build is a counter written by the batch. It would be wrong here, for the
-- reason the 2026-09-21 run is instructive: the run that needed watching is exactly the
-- run that would have failed to write its own counter, because the thing that broke was
-- upstream of everything it wrote. A monitor fed by the subject it monitors is dark in
-- precisely the case it exists for.
--
-- prospect_research_results.sources_successful is already written on every row by
-- buildSourceTracking, has been since the table existed, and is written by the SUCCEEDING
-- path rather than the failing one. So this view needs no new column, no new write, and
-- no backfill, and it can see history: run it today and it reports the 2026-09-21 run.
--
-- ─── What it does NOT see, stated so nobody over-trusts it ───────────────────
--
-- From 2026-09-23 a prospect whose source failed is HELD and writes no row at all, so a
-- total outage shows up here as rows going MISSING, not as rows with a source absent.
-- That is why the check reads a RATE over prospects that were researched, and why a run
-- aborting on a fatal 402 is reported by the run itself throwing rather than by this view.
-- This view catches the slow version: a source degrading across days while runs continue.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.mon_034 AS
WITH recent AS (
  -- Fetching runs only. A reuse run makes no calls, so counting it would dilute the rate
  -- with prospects nobody tried to fetch, and dilution moves the number the wrong way:
  -- it makes a dead source look healthier the more reuse runs happen.
  SELECT
    r.id,
    r.sources_successful
  FROM public.prospect_research_results r
  WHERE r.created_at > now() - interval '7 days'
    AND COALESCE(array_length(r.sources_attempted, 1), 0) > 0
),
counts AS (
  SELECT
    count(*)                                                                    AS rows_total,
    count(*) FILTER (WHERE 'linkedin'   = ANY(sources_successful))              AS linkedin_ok,
    count(*) FILTER (WHERE 'website'    = ANY(sources_successful))              AS website_ok,
    count(*) FILTER (WHERE 'apollo'     = ANY(sources_successful))              AS apollo_ok,
    count(*) FILTER (WHERE 'web_search' = ANY(sources_successful))              AS web_search_ok
  FROM recent
)
SELECT
  'MON-034'::text AS check_code,
  CASE
    -- UNKNOWN, NOT OK, ON AN EMPTY SET. Every rate below passes vacuously over zero rows,
    -- and a check born dark reporting OK is the failure this whole file exists to avoid.
    -- Deliberately not mapped to OK: no research in seven days is itself worth a look.
    WHEN (SELECT rows_total FROM counts) = 0 THEN 'UNKNOWN'
    -- A source below half is not a bad afternoon. On 2026-09-21 LinkedIn was at 31%.
    WHEN (SELECT linkedin_ok::numeric   / rows_total FROM counts) < 0.50 THEN 'PROBLEM'
    WHEN (SELECT apollo_ok::numeric     / rows_total FROM counts) < 0.50 THEN 'PROBLEM'
    WHEN (SELECT web_search_ok::numeric / rows_total FROM counts) < 0.50 THEN 'PROBLEM'
    -- RAISED TO 0.50 ON 2026-09-23, in the commit that fixed the fetcher, exactly as the
    -- earlier version of this comment said it should be. It was 0.10 for one day, while
    -- the fetcher was known broken and a common threshold would have pinned this check
    -- permanently red. The defect was a missing URL scheme: fetch('example.com') throws
    -- rather than requesting, so the direct path made zero network calls and everything
    -- fell through to unauthenticated Jina. Re-probed: 63 of 67 of those sites answer.
    WHEN (SELECT website_ok::numeric    / rows_total FROM counts) < 0.50 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT rows_total FROM counts) = 0
      THEN 'No fetching research run in the last 7 days, so no source rate can be computed. '
        || 'This is UNKNOWN rather than OK: the check has nothing to look at.'
    -- ─── THE DETAIL NAMES THE SOURCE THAT TRIPPED, AND ROUNDS TO ONE DECIMAL ───
    --
    -- FOUND ON THE FIRST LIVE READ, 2026-09-23. The first version rounded to whole
    -- percent and listed the four rates without saying which one failed. Its first real
    -- output was PROBLEM with "website 50%", and 50% is not below a floor of 50%. The
    -- check was right: the true rate was 0.4982. The DETAIL had rounded the evidence for
    -- its own verdict out of existence, so an operator reading it would have seen a red
    -- monitor with four healthy-looking numbers and no way to tell what it meant.
    --
    -- One decimal, and the failing sources named first. A monitor whose detail does not
    -- explain its own state sends the reader to the SQL, which is where this file's
    -- whole family of past defects has lived.
    ELSE 'BELOW FLOOR: ' || COALESCE(NULLIF(array_to_string(ARRAY(
        SELECT s FROM (
          SELECT 'linkedin'   AS s, (SELECT linkedin_ok::numeric   / rows_total FROM counts) AS v
          UNION ALL SELECT 'apollo',     (SELECT apollo_ok::numeric     / rows_total FROM counts)
          UNION ALL SELECT 'web_search', (SELECT web_search_ok::numeric / rows_total FROM counts)
          UNION ALL SELECT 'website',    (SELECT website_ok::numeric    / rows_total FROM counts)
        ) q WHERE q.v < 0.50 ORDER BY q.v
      ), ', '), ''), 'none') || '. '
      || 'Over ' || (SELECT rows_total FROM counts)::text
      || ' prospects researched in 7 days, each source came back for: linkedin '
      || round(100.0 * (SELECT linkedin_ok::numeric   / rows_total FROM counts), 1)::text || '%, apollo '
      || round(100.0 * (SELECT apollo_ok::numeric     / rows_total FROM counts), 1)::text || '%, web_search '
      || round(100.0 * (SELECT web_search_ok::numeric / rows_total FROM counts), 1)::text || '%, website '
      || round(100.0 * (SELECT website_ok::numeric    / rows_total FROM counts), 1)::text
      || '%. A source under its floor means research is running on what survived, and the '
      || 'copy it produces is built from whichever sources still answered.'
  END AS detail;

-- Service role only. RLS is one layer and the GRANT is the other; a view runs as its owner
-- unless created with security_invoker, so the grant is the whole of the protection here.
REVOKE ALL ON public.mon_034 FROM PUBLIC;
REVOKE ALL ON public.mon_034 FROM anon, authenticated;
GRANT SELECT ON public.mon_034 TO service_role;
