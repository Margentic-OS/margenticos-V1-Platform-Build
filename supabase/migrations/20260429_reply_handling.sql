-- 20260429_reply_handling.sql
-- Reply handling agent foundation.
--
-- What this migration does:
--   1. Adds calendly_url column to organisations (one URL per org, phase 1)
--   2. Creates reply_handling_actions table — audit log for every classified reply
--   3. Schedules a pg_cron job to call process-replies every 5 minutes
--
-- BEFORE RUNNING THIS MIGRATION:
--   Set the process-replies endpoint URL in the Supabase SQL editor:
--
--     ALTER DATABASE postgres SET "app.process_replies_endpoint_url"
--       = 'https://margenticos-platform.vercel.app/api/cron/process-replies';
--     SELECT pg_reload_conf();
--
--   The CRON_SECRET is already set from the polling migration — no change needed.
--   app.process_replies_endpoint_url is intentionally NOT in this file
--   because this migration is committed to Git.
--
-- AFTER RUNNING THIS MIGRATION:
--   Update the organisations row for MargenticOS with the Calendly URL:
--
--     UPDATE organisations SET calendly_url = '<your-calendly-link>'
--     WHERE slug = 'margenticos';
--
--   Verify the cron job was created:
--     SELECT jobname, schedule FROM cron.job WHERE jobname = 'process-replies';
--
-- action_taken valid values (text, not enum — avoids migration for future additions):
--   suppress           — opt-out: Instantly lt_interest_status=-1 + DB suppression
--   ooo_log            — OOO detected: Instantly handles pause/resume, logged for visibility
--   send_reply         — direct booking: Calendly reply sent via email thread
--   log_only           — Tier 2/3: no action taken, logged for future phase processing
--   classifier_failed  — Haiku error or bad output: signal left unprocessed for retry
--   permanently_failed — 3 retries exhausted: signal marked processed, no further attempts
--
-- ATOMICITY:
--   Wrapped in BEGIN / COMMIT. All DDL is transactional in Postgres 17.
--   cron.schedule() writes to cron.job (a regular table) — also transactional.

BEGIN;

-- ── 1. calendly_url on organisations ─────────────────────────────────────────
--
-- Single Calendly URL per client organisation.
-- Used in the Tier 1 direct-booking reply template.
-- Per-client Calendly Routing Forms (with screening questions) are a pre-c1 item.

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS calendly_url text;

-- ── 2. reply_handling_actions ─────────────────────────────────────────────────
--
-- Append-only audit log. One row per classification attempt per signal.
-- Multiple rows for the same signal_id when retries occur (tracked by attempt_number).
--
-- This table is operator-only. Clients never query it.
-- All writes are via service role (cron endpoint). No authenticated INSERT policy.
--
-- faq_entry_id:        always null in phase 1 — field exists for phase 2 FAQ extraction.
-- scheduled_resume_at: OOO parsed return date for display only — Instantly manages the
--                      actual pause/resume natively (OOO Resume feature, all paid plans).
-- action_payload:      jsonb bag for action-specific data:
--                        opt_out:        { instantly_lead_id, lead_email }
--                        ooo_log:        { instantly_handled: true, parsed_return_date }
--                        send_reply:     { reply_body, calendar_link }
--                        log_only:       { tier }
--                        classifier_*:   { error_message }

CREATE TABLE IF NOT EXISTS reply_handling_actions (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id           uuid        NOT NULL REFERENCES organisations(id),
  signal_id                 uuid        NOT NULL REFERENCES signals(id),
  prospect_id               uuid        REFERENCES prospects(id),
  campaign_id               uuid        REFERENCES campaigns(id),

  -- Classification
  classified_intent         text,
  classification_confidence decimal(4,3),
  classification_reasoning  text,
  faq_entry_id              uuid,         -- FK constraint to faq_entries.id will be added in phase 2 migration when that table is created
  tier_assigned             integer,

  -- Action
  action_taken              text        NOT NULL,
  action_payload            jsonb,
  scheduled_resume_at       timestamptz,

  -- Outcome
  action_succeeded          boolean,
  action_error              text,
  instantly_response        jsonb,

  -- Retry tracking
  attempt_number            integer     NOT NULL DEFAULT 1,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reply_handling_actions ENABLE ROW LEVEL SECURITY;

-- Operators can read all rows across all organisations (for the signals log dashboard).
CREATE POLICY "operators_read_reply_handling_actions"
  ON reply_handling_actions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id   = auth.uid()
        AND users.role = 'operator'
    )
  );

-- No INSERT / UPDATE / DELETE for authenticated users.
-- All writes are service-role only (cron endpoint).

-- Primary dashboard query: all actions for an org, newest first.
CREATE INDEX IF NOT EXISTS idx_reply_handling_actions_org_created
  ON reply_handling_actions (organisation_id, created_at DESC);

-- Idempotency / retry check: fast lookup of all attempts for a given signal.
CREATE INDEX IF NOT EXISTS idx_reply_handling_actions_signal
  ON reply_handling_actions (signal_id);

-- ── 3. pg_cron job ────────────────────────────────────────────────────────────
--
-- Calls process-replies every 5 minutes — faster than the 15-minute polling
-- job so reply classification happens quickly after a signal is written.
--
-- timeout_milliseconds: 55000ms — matches the polling job. At 20 signals per run
-- with ~2s Haiku + ~1s Instantly API per signal, worst-case is ~60s. The 55s
-- timeout will abort a very slow run before the next cron fires, preventing pile-up.
--
-- To verify: SELECT jobname, schedule FROM cron.job WHERE jobname = 'process-replies';
-- To remove: SELECT cron.unschedule('process-replies');

SELECT cron.schedule(
  'process-replies',
  '*/5 * * * *',
  $$
  SELECT
    net.http_post(
      url     := current_setting('app.process_replies_endpoint_url', true),
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

COMMIT;
