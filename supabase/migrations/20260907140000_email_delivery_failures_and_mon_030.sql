-- email_delivery_failures, and MON-030 which reads it.
--
-- Status: PENDING (apply via Supabase MCP apply_migration, then mark APPLIED)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- On 2026-09-05 a tov-generation run failed for MargenticOS. The route caught it and
-- tried to email the operator. One millisecond later:
--
--   sendTransactionalEmail: content validation failed
--   subject: "Tone of voice agent failed: MargenticOS"
--   error:   Email contains em dash (—) — use colon or comma instead
--
-- The dash was in the template's own branding line. The alert never went out, and the
-- screen still said "New suggestion is being prepared, check back shortly".
--
-- A log line and a Sentry event both fired at that moment. Neither was noticed for two
-- days. That is the point of this table: both existing channels are places somebody has
-- to go and look, and nothing reads them on a schedule. MON-030 does.
--
-- This is the third time this lesson has been paid for. The route's own comment records
-- the 2026-08-28 incident, where two messaging regenerations failed and produced "no
-- signal anywhere except a row in agent_runs". The fix written then has never delivered
-- an email, for the reason above.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A TABLE AND NOT notifications_log
--
-- notifications_log is a dedup ledger of SUCCESSES, keyed (organisation_id,
-- notification_type, subject_id) with organisation_id NOT NULL. A failure row in it
-- would mean "already sent" and permanently suppress the retry, and most failing sends
-- have no organisation to key on. Recording a failure there would make the next
-- notification disappear too.

CREATE TABLE IF NOT EXISTS public.email_delivery_failures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient      text NOT NULL,
  subject        text NOT NULL,
  -- 'content_validation' the message never reached Resend
  -- 'provider_send'      Resend rejected it or was unreachable
  stage          text NOT NULL CHECK (stage IN ('content_validation', 'provider_send')),
  audience       text NOT NULL CHECK (audience IN ('operator', 'customer')),
  error_message  text NOT NULL,
  -- Set by a human when the cause is dealt with. NULL means still outstanding, which is
  -- what MON-030 counts. An acknowledgement column rather than a delete, because the
  -- history of what failed is the only record that any of this ever happened.
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_delivery_failures_outstanding
  ON public.email_delivery_failures (created_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE public.email_delivery_failures ENABLE ROW LEVEL SECURITY;

-- Service-role only, BOTH LAYERS and by name. REVOKE FROM PUBLIC alone is a no-op here:
-- Supabase's ALTER DEFAULT PRIVILEGES grants anon and authenticated explicitly at creation,
-- so the grant this removes was never the one that existed.
REVOKE ALL ON TABLE public.email_delivery_failures FROM PUBLIC;
REVOKE ALL ON TABLE public.email_delivery_failures FROM anon, authenticated;
GRANT ALL ON TABLE public.email_delivery_failures TO service_role;

-- ── MON-030 ───────────────────────────────────────────────────────────────────
--
-- PROBLEM on any unresolved failure. There is no "acceptable number" of emails that did
-- not send, so there is no threshold row here and no window: one is a problem, and it
-- stays a problem until a person marks it resolved.
--
-- Operator failures are named first in the detail line, because a client email that did
-- not arrive is a customer-service problem and an operator alert that did not arrive is
-- the platform losing its ability to tell anyone anything.

CREATE OR REPLACE VIEW public.mon_030 AS
WITH outstanding AS (
  SELECT
    count(*)                                             AS n,
    count(*) FILTER (WHERE audience = 'operator')        AS n_operator,
    count(*) FILTER (WHERE stage = 'content_validation') AS n_validation,
    max(created_at)                                      AS newest,
    min(created_at)                                      AS oldest,
    (array_agg(subject ORDER BY created_at DESC))[1]     AS newest_subject,
    (array_agg(error_message ORDER BY created_at DESC))[1] AS newest_error
  FROM public.email_delivery_failures
  WHERE resolved_at IS NULL
)
SELECT
  'MON-030'::text AS check_code,
  CASE WHEN (SELECT n FROM outstanding) > 0 THEN 'PROBLEM' ELSE 'OK' END AS state,
  CASE
    WHEN (SELECT n FROM outstanding) > 0
      THEN (SELECT n FROM outstanding)::text || ' email(s) did not send and are unresolved, '
        || (SELECT n_operator FROM outstanding)::text || ' of them operator alerts. '
        || (SELECT n_validation FROM outstanding)::text || ' rejected before reaching the provider. '
        || 'Most recent: "' || COALESCE((SELECT newest_subject FROM outstanding), '?') || '" -> '
        || COALESCE((SELECT newest_error FROM outstanding), '?')
    ELSE 'No unresolved email delivery failures.'
  END AS detail,
  (SELECT newest FROM outstanding) AS last_run;

REVOKE ALL ON public.mon_030 FROM PUBLIC;
REVOKE ALL ON public.mon_030 FROM anon, authenticated;
GRANT SELECT ON public.mon_030 TO service_role;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-030',
  'Every email we tried to send actually went out',
  'Counts rows in email_delivery_failures with resolved_at IS NULL. A row is written by '
    || 'sendTransactionalEmail whenever a message is rejected by the content validator or '
    || 'by Resend. PROBLEM on any unresolved row: there is no acceptable number of emails '
    || 'that did not send, so there is no threshold and no window.',
  'data_integrity',
  1,
  false,
  NULL,

  'When the system tries to email somebody and the message does not go out, a record of it '
    || 'lands here. This check watches for records nobody has dealt with.',

  'An alert that does not arrive is worse than no alert, because the silence reads as good '
    || 'news. On 2026-09-05 a document agent failed, the alert to Doug was rejected one '
    || 'millisecond later over a dash in the template, and the dashboard went on saying the '
    || 'new version was being prepared. It was found two days later by reading the database. '
    || 'The same rejection had been happening to every operator notification this system '
    || 'has ever sent.',

  'Read the detail line for the subject and the reason. If it says content validation, the '
    || 'template was rejected before it reached the provider: fix the template, or if it is '
    || 'an internal alert check it is labelled audience: operator. If it says provider send, '
    || 'check Resend status and the API key. Mark the row resolved_at once the cause is '
    || 'fixed. Never clear these rows to make the board green.'
)
ON CONFLICT (code) DO UPDATE SET
  title                     = EXCLUDED.title,
  description               = EXCLUDED.description,
  category                  = EXCLUDED.category,
  tier                      = EXCLUDED.tier,
  is_scheduled              = EXCLUDED.is_scheduled,
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  plain_meaning             = EXCLUDED.plain_meaning,
  plain_impact              = EXCLUDED.plain_impact,
  plain_action              = EXCLUDED.plain_action;
