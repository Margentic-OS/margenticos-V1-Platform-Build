-- Status: NOT YET APPLIED
-- Record that a client's dashboard failed, and put it on the board.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS TABLE EXISTS AT ALL
-- ─────────────────────────────────────────────────────────────────────────────
--
-- On 2026-09-07 a real client's dashboard rendered blank, recovered on its own, and
-- NOTHING IN THIS SYSTEM RECORDED THAT IT HAPPENED. Three layers all missed it, each for
-- its own reason, and the reasons are worth keeping because they are structural:
--
--   Vercel   a render that dies mid-stream has already sent HTTP 200, so it is logged as
--            a success. Individual runtime log lines are retained for one hour on the
--            current plan, so by the time it was reported there was nothing left to read.
--            Measured: 411 requests to /dashboard over three days, every one a 200.
--   Sentry   wired correctly, DSN present in Production, captureException in both error
--            boundaries. It fires only if a boundary actually rendered or the server
--            threw. A read that quietly returned null does neither.
--   Monitors ALL 31 of MON-001..MON-031 are SQL views over database state. Not one makes
--            an HTTP call; the comment on MON-029 says so in as many words. A failed
--            render writes no row, so no monitor could ever have seen it.
--
-- That last one is the general finding and it is bigger than this table: every check we
-- have watches the database, and nothing watches the product. This migration does not fix
-- that. It makes ONE product failure write a row, because a row is the one thing the
-- existing monitors can already read.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A WINDOW AND NOT A RESOLVED FLAG
-- ─────────────────────────────────────────────────────────────────────────────
--
-- MON-031 deliberately stays red until somebody resolves a row, because a quarantined
-- reply is a person waiting for an answer and time does not answer them. This is the
-- opposite kind of fact. A dashboard read that failed at 09:00 and has worked ever since
-- is a past event, not an open task, and there is nobody to go back to. So mon_032 reads
-- a 60 minute window and clears on its own when the failures stop.
--
-- Rows are kept for 30 days regardless, so the trend outlives the alarm. An operator
-- asking "has this been happening quietly for weeks" needs the history even though the
-- alarm is green.

-- ── The table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dashboard_failures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  -- 'read'   one query on a dashboard page failed, was refused, or timed out. The page
  --          still rendered; a card is degraded.
  -- 'render' the page itself failed and an error boundary took over. The client saw a
  --          recovery card instead of their dashboard.
  kind            text NOT NULL CHECK (kind IN ('read', 'render')),
  -- Which code noticed. A stable identifier, never a message, so it can be grouped.
  source          text NOT NULL,
  route           text NOT NULL,
  organisation_id uuid REFERENCES public.organisations(id) ON DELETE SET NULL,
  detail          text,
  -- Next.js error digest, when a render failure carries one. It is the only handle that
  -- ties this row to the corresponding Sentry event.
  digest          text
);

-- The only access pattern is "what happened recently", from mon_032 and from an operator
-- looking at a trend. Both are time-ordered.
CREATE INDEX IF NOT EXISTS dashboard_failures_occurred_at_idx
  ON public.dashboard_failures (occurred_at DESC);

COMMENT ON TABLE public.dashboard_failures IS
  'One row per dashboard read failure or render failure. Written by recordDashboardFailure. Read by mon_032. Exists because a failed page render writes nothing anywhere else: Vercel logs it as a 200, Sentry only sees it if a boundary rendered, and every other monitor watches the database rather than the product.';

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Supabase runs ALTER DEFAULT PRIVILEGES on the public schema granting anon and
-- authenticated BY NAME at creation, so REVOKE FROM PUBLIC alone is a silent no-op.
-- Both roles are named. RLS is enabled as well: the grant is the second layer, and
-- neither is trusted to be the only one.

ALTER TABLE public.dashboard_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dashboard_failures FROM PUBLIC;
REVOKE ALL ON TABLE public.dashboard_failures FROM anon, authenticated;
GRANT ALL ON TABLE public.dashboard_failures TO service_role;

-- ── MON-032 ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.mon_032 AS
WITH recent AS (
  SELECT
    count(*)                                            AS total,
    count(*) FILTER (WHERE kind = 'render')             AS renders,
    count(*) FILTER (WHERE kind = 'read')               AS reads,
    count(DISTINCT organisation_id)                     AS orgs,
    max(occurred_at)                                    AS latest,
    (array_agg(DISTINCT source))[1:3]                   AS sources
  FROM public.dashboard_failures
  WHERE occurred_at > now() - interval '60 minutes'
)
SELECT
  'MON-032'::text AS check_code,
  CASE
    WHEN (SELECT renders FROM recent) > 0 THEN 'PROBLEM'
    WHEN (SELECT reads   FROM recent) > 0 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT total FROM recent) > 0
      THEN (SELECT total FROM recent)::text
        || ' dashboard failure(s) in the last hour, affecting '
        || (SELECT orgs FROM recent)::text || ' organisation(s). '
        || (SELECT renders FROM recent)::text
        || ' were whole-page render failures, where the client saw a recovery card '
        || 'instead of their dashboard. '
        || (SELECT reads FROM recent)::text
        || ' were single reads that failed, were refused, or timed out, where the page '
        || 'rendered with a degraded card. Source(s): '
        || COALESCE(array_to_string((SELECT sources FROM recent), ', '), '(none)')
        || '.'
    ELSE 'No dashboard read or render failure in the last hour. THIS IS NOT PROOF THE '
      || 'DASHBOARD IS HEALTHY. It proves only that the recorder wrote nothing: an hour '
      || 'with no client logged in reads exactly the same as an hour with no failures, '
      || 'and this check cannot tell them apart because nothing here observes a page. It '
      || 'watches one product failure that learned how to write a row. Every other check '
      || 'on this board watches the database.'
  END AS detail,
  (SELECT latest FROM recent) AS last_run;

REVOKE ALL ON public.mon_032 FROM PUBLIC;
REVOKE ALL ON public.mon_032 FROM anon, authenticated;
GRANT SELECT ON public.mon_032 TO service_role;

-- ── Registration ─────────────────────────────────────────────────────────────

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-032',
  'No client dashboard failed to load',
  'Counts rows written to dashboard_failures in the last 60 minutes. kind = render means '
    || 'a page threw and an error boundary rendered in place of the dashboard. kind = '
    || 'read means one query failed, was refused, or hit its timeout, and the page '
    || 'rendered with that card degraded. The window clears on its own once failures '
    || 'stop; the rows are kept for 30 days so a slow drip is still visible after the '
    || 'alarm has gone green.',
  'data_integrity',
  1,
  false,
  NULL,
  'A client opening their dashboard sees their dashboard. This check watches the times '
    || 'they did not.',
  'On 2026-09-07 a real client''s dashboard rendered blank, recovered on its own, and '
    || 'nothing recorded that it happened. A render that dies mid-stream has already sent '
    || 'HTTP 200 so the platform logs it as a success, the runtime log lines expire after '
    || 'an hour, and every other monitor on this board reads the database rather than the '
    || 'product. An intermittent blank home screen gets blamed on the client''s '
    || 'connection, and they lose trust before they ever report it.',
  'A render failure is the urgent one: somebody was shown a recovery card instead of '
    || 'their dashboard. The digest column ties the row to the matching Sentry event, '
    || 'which carries the stack. A read failure is less urgent but more insidious, '
    || 'because the page still rendered and the client cannot tell that a number is '
    || 'missing rather than zero. GREEN HERE PROVES LESS THAN IT LOOKS: an hour with no '
    || 'client logged in reads identically to an hour with no failures.'
)
ON CONFLICT (code) DO UPDATE SET
  title        = EXCLUDED.title,
  description  = EXCLUDED.description,
  category     = EXCLUDED.category,
  tier         = EXCLUDED.tier,
  plain_meaning = EXCLUDED.plain_meaning,
  plain_impact  = EXCLUDED.plain_impact,
  plain_action  = EXCLUDED.plain_action;
