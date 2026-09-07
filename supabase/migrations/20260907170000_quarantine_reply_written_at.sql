-- Status: APPLIED (verified live 2026-09-07). Proved on the real row the acceptance
-- probe recovered: reply_written_at backfilled to 2026-09-05 16:16:45 from the payload,
-- and MON-031 changed from "Oldest waiting 0.0 hours" to "Longest anyone has been
-- waiting: 51.0 hours since they wrote." Applied to the TEST project too, where the
-- live view test and its mutation proof run.
-- MON-031 was reporting how long WE had held a reply, not how long the person had waited.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MEASURED, on the row the acceptance probe recovered
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The probe on 2026-09-07 recovered a reply that arrived at the provider on
-- 2026-09-05 and had been lost ever since. Quarantined 18:45:01. MON-031 then said:
--
--     Oldest waiting 0.0 hours.
--
-- The person had been waiting two days.
--
-- The view aged from first_seen_at, which is when the POLLER first failed to attribute
-- the reply, not when the reply was written. For a reply quarantined the moment it
-- arrives those are the same instant, which is why no fixture caught it: every test
-- creates the row at the moment of the event.
--
-- It is wrong for anything recovered from a backlog, and wrong again if a cursor rewind
-- causes a re-observation, which the idempotency path deliberately supports.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS MATTERS MORE THAN A COSMETIC NUMBER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- MON-031's whole argument, written into its own plain_action, is UNASSIGNED IS NOT
-- ANSWERED: a real person wrote back and is still waiting. An operator reading
-- "0.0 hours" beside that sentence will reasonably deprioritise it. The monitor was
-- undercutting its own case.
--
-- Same family as the frozen detail line fixed on 2026-09-04: there the state and the
-- detail came from different rows; here the state is right and the number beside it
-- measures something other than what the sentence claims.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A COLUMN, NOT A JSON EXPRESSION IN THE VIEW
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The obvious fix is to read the timestamp out of raw_data inside the view. It is the
-- wrong one, for a reason the retention rule makes unavoidable: raw_data is NULLED at
-- 30 days. A view parsing the payload would silently revert to first_seen_at at exactly
-- the moment a row has been waiting longest, so the number would be wrong precisely
-- where it matters most.
--
-- Extracting once at write time into a real column survives redaction, needs no parsing
-- in the view, and is typed.

ALTER TABLE public.unattributed_replies
  ADD COLUMN IF NOT EXISTS reply_written_at timestamptz;

COMMENT ON COLUMN public.unattributed_replies.reply_written_at IS
  'When the prospect actually wrote, taken from the provider payload at quarantine time. '
  'NULL when the payload carried no usable timestamp. Survives the 30-day redaction, '
  'which is the whole reason it is a column and not an expression over raw_data.';

-- Backfill from the payload for rows written before this column existed. The cast is
-- guarded: a malformed value must yield NULL and fall back, never abort the migration.
UPDATE public.unattributed_replies
   SET reply_written_at = CASE
         WHEN raw_data->>'timestamp_email' ~ '^\d{4}-\d{2}-\d{2}T'
           THEN (raw_data->>'timestamp_email')::timestamptz
         WHEN raw_data->>'timestamp_created' ~ '^\d{4}-\d{2}-\d{2}T'
           THEN (raw_data->>'timestamp_created')::timestamptz
         ELSE NULL
       END
 WHERE reply_written_at IS NULL
   AND raw_data IS NOT NULL;

-- ── MON-031, ageing from when the person wrote ───────────────────────────────

CREATE OR REPLACE VIEW public.mon_031 AS
WITH quarantined AS (
  SELECT
    count(*) FILTER (WHERE resolved_at IS NULL)                                  AS unresolved,
    count(*) FILTER (WHERE resolved_at IS NULL AND body_redacted_at IS NOT NULL) AS redacted,
    -- COALESCE, not reply_written_at alone: a payload with no usable timestamp must still
    -- age from something rather than dropping out of the min() and leaving the line blank.
    min(COALESCE(reply_written_at, first_seen_at)) FILTER (WHERE resolved_at IS NULL) AS oldest,
    count(*) FILTER (WHERE resolved_at IS NULL AND reply_written_at IS NULL)     AS no_write_time,
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
        || '. Longest anyone has been waiting: '
        || COALESCE(round(EXTRACT(epoch FROM (now() - (SELECT oldest FROM quarantined))) / 3600.0, 1)::text, '?')
        || ' hours since they wrote.'
        || CASE WHEN (SELECT no_write_time FROM quarantined) > 0
                THEN ' ' || (SELECT no_write_time FROM quarantined)::text
                  || ' of these carried no send time, so their wait is measured from when we '
                  || 'first held them and is a floor, not the real figure.'
                ELSE '' END
        || CASE WHEN (SELECT redacted FROM quarantined) > 0
                THEN ' ' || (SELECT redacted FROM quarantined)::text
                  || ' are past 30 days and have had their contents redacted, '
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

UPDATE public.monitor_checks
   SET plain_impact = 'Before this existed, a reply for an unregistered campaign was dropped '
         || 'permanently and the same run reset the poller''s error count to zero on its way '
         || 'past, so nothing anywhere recorded it. Somebody answered an email we paid to '
         || 'source, research, write and send, and no one ever knew. The waiting time shown '
         || 'is measured from when the person wrote, not from when we noticed.'
 WHERE code = 'MON-031';
