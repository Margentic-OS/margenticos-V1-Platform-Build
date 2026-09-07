-- Quarantine a reply we cannot attribute, instead of discarding it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS SMALL
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The reply poll is WORKSPACE-WIDE. It sends email_type, sort_order, limit and a
-- cursor, and no campaign_id. One cursor row, organisation_id IS NULL.
--
-- So the poller already sees every reply in the workspace, unattributable ones
-- included. It discarded them because signals.organisation_id is NOT NULL. The reply
-- was never invisible: it was observed and thrown away. Catching it at the point of
-- discard costs one insert and no extra provider call.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A SEPARATE TABLE AND NOT A NULLABLE signals.organisation_id
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One fact decides it. processReplies selects unprocessed reply signals with NO
-- organisation filter at all. A nullable organisation_id would not park the reply, it
-- would feed it into the classifier with no org context, no TOV and no Calendly URL on
-- the very next run. Making that safe means remembering to add a filter there, and
-- forgetting is a live bug rather than a no-op.
--
-- The mirror problem is as bad: every other reader DOES filter by organisation, so a
-- null row would be silently excluded from all of them. A quarantine that hides itself
-- from every existing query is the shape this work exists to remove.
--
-- signals also carries exactly one RLS policy, operators_full_access_signals on
-- is_operator(). Isolation there rests entirely on that column being real.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RETENTION. DECIDED BEFORE THE TABLE WAS CREATED, NOT AFTER.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This table holds a prospect's reply body with NO CLIENT ATTACHED. Nothing else in
-- this system holds unattributed personal data: everything else sits inside the
-- organisation-scoping model, and this deliberately cannot.
--
--   At 30 days unresolved  redact raw_data and original_outbound_body, stamp
--                          body_redacted_at. KEEP the row and the campaign id.
--   The row stays unresolved, so MON-031 STAYS PROBLEM. Redaction removes the
--                          personal data, never the alarm.
--   At 180 days            delete outright, resolved or not.
--   On resolution          the row is kept as an audit trail, with resolved_signal_id.
--
-- Why not simply delete at 30 days: a monitor that goes green because rows aged out is
-- a monitor that heals by forgetting. MON-028's own advice text already bans the
-- equivalent move for reply drafts. Redact-but-keep holds both properties at once.
--
-- A redacted row can no longer be replayed, and MON-031 says so rather than hiding it.
-- After 30 days the provider may well not hold the reply either, so that is a real
-- loss being stated, not a capability being withheld.

-- ── The table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.unattributed_replies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Capability-style, not a vendor name in application logic. The handler owns the
  -- vendor; this column records which one produced the row.
  provider                text NOT NULL DEFAULT 'instantly',

  -- What the monitor names and what registering resolves. Nullable because a payload
  -- can arrive with no campaign at all, and that is still worth keeping.
  provider_campaign_id    text,

  -- The idempotency key. Re-observation after a cursor rewind is a no-op, which is what
  -- makes it safe for the poller to write this on every pass without checking first.
  provider_email_id       text NOT NULL,

  -- Needed to thread a reply later, if one is ever sent.
  eaccount                text,

  -- The exact object writeSignal consumes, so replay needs no re-fetch from the
  -- provider. That matters: on 2026-08-28 a probe campaign was torn down within the
  -- hour and its evidence became unrecoverable. A stored payload survives that.
  raw_data                jsonb,
  original_outbound_body  text,

  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),

  -- Retention. Set when the body is redacted; the row itself lives on.
  body_redacted_at        timestamptz,

  -- Resolution. Both set together by replay, never by hand.
  resolved_at             timestamptz,
  resolved_signal_id      uuid REFERENCES public.signals(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS unattributed_replies_provider_email_id_key
  ON public.unattributed_replies (provider, provider_email_id);

-- Replay looks up by campaign, and the monitor counts unresolved rows. Both are
-- served by this.
CREATE INDEX IF NOT EXISTS unattributed_replies_unresolved_campaign_idx
  ON public.unattributed_replies (provider_campaign_id)
  WHERE resolved_at IS NULL;

-- Retention sweeps by age over unresolved rows.
CREATE INDEX IF NOT EXISTS unattributed_replies_unresolved_age_idx
  ON public.unattributed_replies (first_seen_at)
  WHERE resolved_at IS NULL;

-- ── Privileges. RLS is one layer, the grant underneath is the other. ─────────
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants tables to anon and authenticated BY NAME
-- at creation, so REVOKE FROM PUBLIC alone is a silent no-op. Both roles are named.
-- This table holds unattributed personal data and is service-role only.

ALTER TABLE public.unattributed_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.unattributed_replies FROM PUBLIC;
REVOKE ALL ON TABLE public.unattributed_replies FROM anon, authenticated;
GRANT ALL ON TABLE public.unattributed_replies TO service_role;

-- ── MON-031 ──────────────────────────────────────────────────────────────────
--
-- NUMBERED 031, NOT 030. This monitor was written as MON-030 and renumbered during the
-- merge: another branch landed its own MON-030 (emails that did not send) on main the
-- same day. Two sessions picked the next free number from the same starting point and
-- both were right at the time they looked.
--
-- Filed as a lesson: the next free monitor number is not a fact you can read once and
-- keep. Read it again at merge.
--
-- BORN DARK, and treated as such. An empty table reads OK, and that OK is
-- indistinguishable from the quarantine write never running. This view cannot tell the
-- difference on its own, so it does not pretend to: the acceptance test is a deliberate
-- probe with its expected before-and-after written down in advance, exactly as the
-- suppression carry was proved on 2026-09-04.
--
-- Poller liveness is MON-002 and MON-027's job, not this view's. Stated here so the
-- next reader does not mistake a green MON-031 for proof the sweep ran.

CREATE OR REPLACE VIEW public.mon_031 AS
WITH quarantined AS (
  SELECT
    count(*) FILTER (WHERE resolved_at IS NULL)                                AS unresolved,
    count(*) FILTER (WHERE resolved_at IS NULL AND body_redacted_at IS NOT NULL) AS redacted,
    min(first_seen_at) FILTER (WHERE resolved_at IS NULL)                      AS oldest,
    (array_agg(DISTINCT provider_campaign_id) FILTER (WHERE resolved_at IS NULL))[1:3] AS campaigns
  FROM public.unattributed_replies
)
SELECT
  'MON-031'::text AS check_code,
  CASE
    WHEN (SELECT unresolved FROM quarantined) > 0 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT unresolved FROM quarantined) > 0
      THEN (SELECT unresolved FROM quarantined)::text
        || ' repl(y/ies) arrived that we could not attribute to any client. Nothing has '
        || 'been sent back to the people who wrote them. Provider campaign(s): '
        || COALESCE(array_to_string(
             (SELECT campaigns FROM quarantined), ', '), '(none recorded)')
        || '. Oldest waiting '
        || COALESCE(round(EXTRACT(epoch FROM (now() - (SELECT oldest FROM quarantined))) / 3600.0, 1)::text, '?')
        || ' hours.'
        || CASE WHEN (SELECT redacted FROM quarantined) > 0
                THEN ' ' || (SELECT redacted FROM quarantined)::text
                  || ' of these are past 30 days and have had their contents redacted, '
                  || 'so they can no longer be replayed.'
                ELSE '' END
    ELSE 'No unattributed replies are waiting. This is not proof the quarantine write '
      || 'ran: an empty table and a broken sweep read identically here. MON-002 and '
      || 'MON-027 are what report whether the poller is running at all.'
  END AS detail,
  (SELECT oldest FROM quarantined) AS last_run;

REVOKE ALL ON public.mon_031 FROM PUBLIC;
REVOKE ALL ON public.mon_031 FROM anon, authenticated;
GRANT SELECT ON public.mon_031 TO service_role;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-031',
  'No reply is stuck with no client to attach it to',
  'Counts rows in unattributed_replies with resolved_at IS NULL. These are replies the '
    || 'sending tool delivered for a campaign that is not registered in our campaigns '
    || 'table, so no organisation could be resolved and no signal could be written. The '
    || 'detail line names the provider campaign ids. Rows past 30 days have had their '
    || 'contents redacted and can no longer be replayed; they still count.',
  'data_integrity',
  1,
  false,
  NULL,
  'Every reply that arrives can be matched to a client. This check watches the ones that '
    || 'could not be, which are held rather than thrown away.',
  'Before this existed, a reply for an unregistered campaign was dropped permanently and '
    || 'the same run reset the poller''s error count to zero on its way past, so nothing '
    || 'anywhere recorded it. Somebody answered an email we paid to source, research, '
    || 'write and send, and no one ever knew.',
  'UNASSIGNED IS NOT ANSWERED. A quarantined reply means a real person wrote back and has '
    || 'had no response, and they are still waiting while this is red. The detail line '
    || 'names the sending tool''s campaign id: register that campaign against the right '
    || 'client and the reply is replayed automatically and joins the normal queue. '
    || 'Registering it is what answers the prospect. This alarm clearing is not the same '
    || 'thing, and clearing without registering means somebody is still waiting. Never '
    || 'clear this by deleting rows. If a row is past 30 days its contents are gone and '
    || 'it cannot be replayed: open the sending tool inbox and answer it by hand.'
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
