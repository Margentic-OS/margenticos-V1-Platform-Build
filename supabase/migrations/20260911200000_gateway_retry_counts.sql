-- A count, per day and method, of reads the client library retried after a 504.
-- Status: PENDING
--
-- WHY. Since 2026-09-09 Supabase's API gateway has cut about 1% of REST requests at five
-- seconds with a 504. The client library now retries a cut READ once
-- (patches/@supabase+postgrest-js+2.103.2.patch), and most of those retries succeed, so
-- the cuts stop reaching our code as errors. That is the point of the retry, and it is also
-- a loss: the fault was still getting worse when the retry shipped, and a fault that shows
-- up nowhere cannot be watched. This table keeps it visible as one number per day.
--
-- DELIBERATELY NOT AN ALERT. Nothing reads this to notify anyone. It is a trend to look at:
--
--   SELECT day, method, retries FROM public.gateway_retry_counts ORDER BY day DESC, method;
--
-- LIMITS, so the number is not over-read. It is a FLOOR:
--   - server-side Node.js only. Retries in the browser and in middleware are not counted.
--   - each count is a fire-and-forget write. If that write fails, or the function ends
--     before it lands, the retry goes uncounted. It can undercount; it cannot overcount.
--   - it counts retries, which is cuts on reads. Cut WRITES are never retried and are not
--     in here; they still surface as errors.
--
-- PRIVILEGES. Service-role only. RLS on with no policies, anon and authenticated revoked by
-- name, EXECUTE on the function granted to service_role alone. Read back in both directions
-- when applied, per CLAUDE.md.

CREATE TABLE IF NOT EXISTS public.gateway_retry_counts (
  day        date        NOT NULL,
  method     text        NOT NULL CHECK (method IN ('GET', 'HEAD', 'OPTIONS')),
  retries    integer     NOT NULL DEFAULT 0 CHECK (retries >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, method)
);

ALTER TABLE public.gateway_retry_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gateway_retry_counts FROM anon, authenticated;
GRANT ALL ON TABLE public.gateway_retry_counts TO service_role;

-- One atomic increment per call. The day is UTC, so a day's row matches the log timestamps.
CREATE OR REPLACE FUNCTION public.record_gateway_retry(p_method text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.gateway_retry_counts AS g (day, method, retries, updated_at)
  VALUES ((now() AT TIME ZONE 'UTC')::date, upper(p_method), 1, now())
  ON CONFLICT (day, method)
  DO UPDATE SET retries = g.retries + 1, updated_at = now();
$$;

REVOKE ALL ON FUNCTION public.record_gateway_retry(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_gateway_retry(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_gateway_retry(text) TO service_role;

COMMENT ON TABLE public.gateway_retry_counts IS
  'Reads the client library retried after a 504, per UTC day and HTTP method. A floor, not '
  'an exact count. Written by record_gateway_retry(). Not an alert.';
