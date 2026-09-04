-- MON-028: a reply draft is not sitting unactioned.
--
-- Status: PENDING (not yet applied)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- Nothing watched a reply draft waiting for an operator. One sat at manual_required from
-- 2026-09-03 and was still there two days later, and no instrument anywhere said so.
--
-- MON-014 and MON-015 both look adjacent and neither covers it:
--   MON-014 counts SIGNALS still unprocessed after 48h. The signal behind an ageing draft
--           is processed — processing it is what CREATED the draft. Green throughout.
--   MON-015 counts reply_handling_actions marked permanently_failed. An ageing draft has
--           not failed. Its action row says succeeded, because handing the reply to an
--           operator IS the successful outcome of that path. Green throughout.
--
-- Both watch a FAILURE. A draft nobody has looked at is not a failure, it is an absence,
-- and absence is the thing this platform keeps failing to notice.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE THRESHOLD LIVES IN A ROW, NOT IN THIS FILE
--
-- A number compiled into a view suits whoever it was written for and silently misfits
-- everyone else, and changing it needs a migration. reply_draft_ageing_config holds it:
--
--   organisation_id NULL  the platform default, exactly one row
--   organisation_id set   an override for that client, at most one row each
--
-- The view resolves per draft with COALESCE(override, default). A client who answers
-- replies within the hour and one who batches them weekly are both served without either
-- of them being the hardcoded case.
--
-- IF THE DEFAULT ROW IS MISSING THE CHECK REPORTS UNKNOWN, NOT OK. Without it every
-- comparison is against NULL, every comparison is therefore NULL, no draft is ever old
-- enough, and the monitor is green precisely because it is broken. That is the vacuity
-- this codebase has shipped twice.

CREATE TABLE IF NOT EXISTS public.reply_draft_ageing_config (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
  threshold_hours   integer NOT NULL CHECK (threshold_hours > 0),
  note              text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One default row, and at most one override per organisation. Two partial unique indexes
-- rather than one nullable-column constraint: in Postgres, NULLs do not conflict with each
-- other under a plain UNIQUE, so a plain constraint would happily allow ten default rows
-- and the view would then pick one arbitrarily.
CREATE UNIQUE INDEX IF NOT EXISTS reply_draft_ageing_config_default_singleton
  ON public.reply_draft_ageing_config ((true)) WHERE organisation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reply_draft_ageing_config_one_per_org
  ON public.reply_draft_ageing_config (organisation_id) WHERE organisation_id IS NOT NULL;

ALTER TABLE public.reply_draft_ageing_config ENABLE ROW LEVEL SECURITY;

-- Service-role only, BOTH LAYERS and by name. REVOKE FROM PUBLIC alone is a no-op here:
-- Supabase's ALTER DEFAULT PRIVILEGES grants anon and authenticated explicitly at creation.
REVOKE ALL ON TABLE public.reply_draft_ageing_config FROM PUBLIC;
REVOKE ALL ON TABLE public.reply_draft_ageing_config FROM anon, authenticated;
GRANT ALL ON TABLE public.reply_draft_ageing_config TO service_role;

-- The platform default. 24 hours is a starting point, not a finding: it is long enough that
-- a draft raised overnight is not red by morning, and short enough that the two-day case
-- that prompted this check would have gone red with a full day to spare. Change the ROW when
-- real handling times are known. Do not change this file.
INSERT INTO public.reply_draft_ageing_config (organisation_id, threshold_hours, note)
VALUES (NULL, 24, 'Platform default. Starting point, not a measured figure.')
ON CONFLICT DO NOTHING;

-- ── THE VIEW ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.mon_028 AS
WITH default_threshold AS (
  SELECT threshold_hours
    FROM public.reply_draft_ageing_config
   WHERE organisation_id IS NULL
),
ageing AS (
  SELECT
    d.id,
    d.status,
    d.created_at,
    COALESCE(ovr.threshold_hours, (SELECT threshold_hours FROM default_threshold)) AS threshold_hours,
    round(EXTRACT(epoch FROM (now() - d.created_at)) / 3600.0, 1) AS age_hours
  FROM public.reply_drafts d
  JOIN public.organisations o ON o.id = d.organisation_id
  LEFT JOIN public.reply_draft_ageing_config ovr ON ovr.organisation_id = d.organisation_id
  WHERE o.archived_at IS NULL
    -- The statuses that are waiting on a person. 'approved' is excluded deliberately: it is
    -- waiting on the sender, not the operator, and send_failed IS included because a failed
    -- send needs someone to look at it just as much as an undrafted reply does.
    AND d.status IN ('pending', 'manual_required', 'draft_failed', 'send_failed')
),
overdue AS (
  SELECT count(*) AS n,
         max(age_hours) AS oldest_hours,
         min(status) AS a_status
    FROM ageing
   WHERE threshold_hours IS NOT NULL
     AND age_hours > threshold_hours
)
SELECT
  'MON-028'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM default_threshold) THEN 'UNKNOWN'
    WHEN (SELECT n FROM overdue) > 0 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM default_threshold)
      THEN 'No default row in reply_draft_ageing_config, so no draft can be compared against '
        || 'anything and every draft would pass. This is not a pass: restore the default row.'
    WHEN (SELECT n FROM overdue) > 0
      THEN (SELECT n FROM overdue)::text || ' reply draft(s) waiting on an operator past their '
        || 'threshold. Oldest: ' || (SELECT oldest_hours FROM overdue)::text || ' hours, status '
        || COALESCE((SELECT a_status FROM overdue), '?')
        || '. A prospect replied and nobody has answered.'
    ELSE 'No reply draft is overdue. '
      || (SELECT count(*) FROM ageing)::text || ' draft(s) currently waiting, threshold '
      || (SELECT threshold_hours FROM default_threshold)::text || 'h by default.'
  END AS detail,
  (SELECT min(created_at) FROM ageing) AS last_run;

REVOKE ALL ON public.mon_028 FROM PUBLIC;
REVOKE ALL ON public.mon_028 FROM anon, authenticated;
GRANT SELECT ON public.mon_028 TO service_role;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-028',
  'No reply is sitting waiting for an answer',
  'Reports any reply draft in a status that is waiting on an operator (pending, '
    || 'manual_required, draft_failed, send_failed) that is older than its threshold. The '
    || 'threshold comes from reply_draft_ageing_config: one default row plus optional '
    || 'per-client overrides. Returns UNKNOWN, not OK, if the default row is missing, '
    || 'because without it nothing can be overdue.',
  'data_integrity',
  1,
  false,
  NULL,

  'Somebody replied to one of our emails and is waiting for an answer. This check watches '
    || 'how long they have been waiting.',

  'A reply that nobody answers is the most expensive thing this system can produce: the '
    || 'money to source, research, write and send has already been spent, and the one moment '
    || 'that could turn it into a meeting is being let go. One draft sat untouched for two '
    || 'days and nothing anywhere reported it. The two nearest checks both stayed green, '
    || 'because both watch for a failure and a draft waiting is not a failure, it is silence.',

  'Open the triage queue and action the drafts named. If the number is large, or the same '
    || 'drafts keep ageing, the threshold in reply_draft_ageing_config may not match how this '
    || 'client actually works: change the ROW, per organisation if needed. Never make this go '
    || 'green by raising the default to cover a backlog, and never by deleting drafts.'
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
