-- 20260428_instantly_polling.sql
-- Instantly events polling layer.
--
-- What this migration does:
--   1. Enables pg_cron and pg_net extensions (idempotent — safe if already enabled)
--   2. Adds source + external_event_id to signals for channel attribution and idempotency
--   3. Creates integration_credentials table (extensible per-org or global API key storage)
--   4. Creates polling_cursors table (per source+resource cursor state)
--   5. Schedules the 15-minute pg_cron polling job via pg_net HTTP POST
--
-- BEFORE RUNNING THIS MIGRATION:
--   Set two Postgres config parameters in the Supabase SQL editor:
--
--     ALTER DATABASE postgres SET "app.polling_endpoint_url"
--       = 'https://margenticos-platform.vercel.app/api/cron/instantly-poll';
--     ALTER DATABASE postgres SET "app.cron_secret" = '<your CRON_SECRET value>';
--     SELECT pg_reload_conf();
--
--   The CRON_SECRET value is in Vercel → Project → Settings → Environment Variables.
--   These parameters are intentionally NOT in this file — the migration is committed to Git.
--
-- AFTER RUNNING THIS MIGRATION:
--   Insert the Instantly API key in the Supabase SQL editor:
--
--     INSERT INTO integration_credentials (organisation_id, source, credential_type, value)
--     VALUES (NULL, 'instantly', 'api_key', '<your-instantly-api-key>');
--
--   organisation_id = NULL means global/shared credential (one Instantly account for all orgs).
--   See ADR-001: tool-agnostic registry pattern.
--   BACKLOG: encrypt value via Supabase Vault before first paying client onboards.
--
-- ATOMICITY:
--   This migration is wrapped in BEGIN / COMMIT. If any statement fails, the entire
--   migration rolls back — no partial state. All DDL in this migration (CREATE TABLE,
--   ALTER TABLE, CREATE INDEX, CREATE EXTENSION) is transactional in Postgres 17.
--   cron.schedule() writes to cron.job (a regular table) and is also transactional.
--
--   If you need to run individual statements outside a transaction (e.g. to debug a
--   specific failure), remove the BEGIN/COMMIT wrapper and run each block separately.
--   Then manually ROLLBACK any partial changes before retrying.

BEGIN;

-- ── 1. Extensions ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 2. signals: channel attribution and idempotency columns ──────────────────
--
-- source:             which tool produced this signal ('instantly', 'ghl', 'linkedin', etc.)
-- external_event_id:  the tool's own stable ID for this event (Instantly email UUID,
--                     lead UUID, etc.) — used with source to prevent duplicate rows.
--
-- Partial unique index: only enforced when both columns are non-null.
-- Pre-existing signals (written before polling existed) are unaffected.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS external_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_idempotency
  ON signals (organisation_id, source, external_event_id)
  WHERE source IS NOT NULL AND external_event_id IS NOT NULL;

-- ── 3. integration_credentials ───────────────────────────────────────────────
--
-- Stores API keys and other credentials for external tools.
-- Designed for two models:
--   Model A (current): one shared Instantly account → organisation_id = NULL
--   Model B (future):  per-client accounts → organisation_id = <client's org UUID>
--
-- The lookup pattern: check per-org row first, fall back to NULL (global) row.
-- This means Model B can be added by inserting per-org rows — no code changes needed
-- in the polling layer's key resolution logic.
--
-- NULLS NOT DISTINCT (Postgres 15+): treats two NULL organisation_id values as
-- equal in the unique constraint, so (NULL, 'instantly', 'api_key') is unique.
-- This project runs Postgres 17.6 — confirmed compatible.
--
-- RLS: no authenticated-user policies. Service role only.
-- API keys must never be readable in the browser, even by authenticated operators.

CREATE TABLE IF NOT EXISTS integration_credentials (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid        REFERENCES organisations(id) ON DELETE CASCADE,
  source           text        NOT NULL,
  credential_type  text        NOT NULL,
  value            text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_credentials_unique
  ON integration_credentials (organisation_id, source, credential_type)
  NULLS NOT DISTINCT;

ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
-- No INSERT / UPDATE / DELETE / SELECT policies for authenticated users.
-- All access is via service role only (bypasses RLS by design).

-- ── 4. polling_cursors ────────────────────────────────────────────────────────
--
-- Tracks polling state per (organisation_id, source, resource).
--
-- organisation_id = NULL: global cursor for a shared tool account (Model A).
-- source:   'instantly', 'ghl', 'linkedin', etc.
-- resource: 'replies', 'leads_bounced', 'leads_unsubscribed', etc.
--
-- last_cursor:    opaque string cursor for cursor-based pagination.
--                 For Instantly replies: the last Instantly email UUID processed.
--                 Updated after each successful reply poll.
--
-- last_polled_at: timestamp-based cursor for timestamp-filtered APIs.
--                 Not currently used for Instantly (no updated_after filter exists).
--                 Reserved for future sources that support timestamp filtering.
--
-- last_run_at:    when the poll function last ran (diagnostic — independent of success).
-- error_count:    consecutive failure counter. Reset to 0 on success.
-- last_error:     the most recent error message, for diagnostics.

CREATE TABLE IF NOT EXISTS polling_cursors (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid        REFERENCES organisations(id) ON DELETE CASCADE,
  source           text        NOT NULL,
  resource         text        NOT NULL,
  last_cursor      text,
  last_polled_at   timestamptz,
  last_run_at      timestamptz,
  error_count      integer     NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_polling_cursors_unique
  ON polling_cursors (organisation_id, source, resource)
  NULLS NOT DISTINCT;

ALTER TABLE polling_cursors ENABLE ROW LEVEL SECURITY;

-- Operators can read cursor state for diagnostics (last run time, error count, etc.)
CREATE POLICY "operators_read_polling_cursors"
  ON polling_cursors
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id    = auth.uid()
        AND users.role  = 'operator'
    )
  );
-- No INSERT / UPDATE / DELETE policies for authenticated users.
-- Cursor writes are service-role only (polling endpoint uses service role).

-- ── 5. pg_cron job ────────────────────────────────────────────────────────────
--
-- Calls the polling endpoint every 15 minutes via pg_net HTTP POST.
-- pg_net is asynchronous — the cron job queues the HTTP request and returns
-- immediately. The actual polling runs in the background.
--
-- current_setting('app.polling_endpoint_url', true): the 'true' makes the setting
-- optional (returns null rather than error if not set). If null, pg_net will fail
-- silently — check cron.job_run_details if polling isn't working.
--
-- timeout_milliseconds: 55000ms (55s) — below Vercel's serverless max but long
-- enough for the polling endpoint to complete multiple Instantly API pages.
--
-- To verify the job was created:
--   SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'instantly-poll';
--
-- To remove the job (e.g. if rolling back this migration):
--   SELECT cron.unschedule('instantly-poll');
--
-- To check recent run history:
--   SELECT * FROM cron.job_run_details WHERE jobid = (
--     SELECT jobid FROM cron.job WHERE jobname = 'instantly-poll'
--   ) ORDER BY start_time DESC LIMIT 20;

SELECT cron.schedule(
  'instantly-poll',
  '*/15 * * * *',
  $$
  SELECT
    net.http_post(
      url     := current_setting('app.polling_endpoint_url', true),
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
