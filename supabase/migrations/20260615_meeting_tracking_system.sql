-- Status: CORRECTED 2026-09-15. Not re-applied; the database already has every column
--   below and the ADD CONSTRAINT statements here are not idempotent.
--
-- WHAT WAS WRONG. This file used `ADD COLUMN ... TEXT NULLABLE` eight times. NULLABLE is
-- not a PostgreSQL keyword in that position and Postgres rejects the statement outright:
--
--   ALTER TABLE t ADD COLUMN c TEXT NULLABLE;  ->  syntax error at or near "NULLABLE"
--   ALTER TABLE t ADD COLUMN c TEXT;           ->  accepted
--
-- So this file could never have run, yet supabase_migrations.schema_migrations records it
-- as applied (version 20260615212645) and every column it describes exists live. What ran
-- was not this text. The repo kept a version that cannot execute, and nothing compared the
-- two until the migration set was replayed on a disposable PostgreSQL on 2026-09-15.
--
-- THE FIX IS THE DELETION OF ONE WORD, EIGHT TIMES. A column is nullable by omission, and
-- all eight were verified nullable in the live database before the word was removed. The
-- CHECK constraints are deliberately UNCHANGED: `source` and `held_confirmed_by` are wider
-- live than they are here, because LATER migrations widened them. This file describes its
-- own step in the sequence, not today's schema, and editing it to match today would make a
-- replay apply a later migration's work early.
--
-- Meeting tracking system: additive schema for Calendly webhooks, client confirmation, auto-held resolution, and billing
-- Adds columns to meetings and organisations tables. No destructive operations.
-- Migrations are idempotent (IF NOT EXISTS on all additions).

-- ── 1. Organisations table additions ──────────────────────────────────────

-- Webhook signing secret for Calendly (encrypted at rest by Supabase).
-- Per-org secret allows future multi-workspace Calendly accounts without rebuild.
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS calendly_webhook_secret TEXT;

-- Auto-held window in hours, measured from scheduled_start_at (not booked_at).
-- A meeting auto-confirms held when: scheduled_start_at + auto_held_window_hours < now()
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS auto_held_window_hours INTEGER NOT NULL DEFAULT 72
  CHECK (auto_held_window_hours > 0 AND auto_held_window_hours <= 720);

-- Billing basis: when to record a meeting as billable.
-- 'held' (default): bill only when meeting status becomes held (confirmed or auto)
-- 'booked' (future): bill when meeting is first created
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS billing_basis TEXT NOT NULL DEFAULT 'held'
  CHECK (billing_basis IN ('held', 'booked'));

-- Reminder handling configuration (seam for future prospect-facing reminders via Calendly Workflows).
-- Unused in phase one — captures the seam for later.
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS reminder_handling TEXT;

-- ── 2. Meetings table additions ──────────────────────────────────────────

-- Source of the meeting booking: which system created it.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('calendly', 'manual'));

-- Calendly event UUID extracted from event.uri during webhook processing.
-- UNIQUE constraint ensures one Calendly event = one meeting record (no duplicates on webhook retries).
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS calendly_event_uuid TEXT UNIQUE;

-- Calendly invitee UUID extracted from invitee.uri during webhook processing.
-- Paired with calendly_event_uuid to uniquely identify a booking.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS calendly_invitee_uuid TEXT UNIQUE;

-- Scheduled meeting time (the actual meeting start). Authoritative timestamp for auto-held resolution.
-- For Calendly: populated from event.start_time in the webhook.
-- For manual entry: operator-specified time.
-- Used in auto-held calculation: scheduled_start_at + auto_held_window_hours < now() = eligible for auto-held
-- NOT NULLABLE, NO DEFAULT — must be explicitly set at creation. Prevents accidental immediate auto-hold.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMP WITH TIME ZONE;

-- Meeting status: what happened to the meeting.
-- Replaces the role of the old 'status' column (which may coexist for backward compatibility).
-- booked: created, not yet held/no-show
-- held: confirmed held (either client-confirmed, operator-confirmed, or auto-held)
-- no_show: client or operator confirmed no-show
-- canceled: canceled by invitee or host (Calendly webhook)
-- rescheduled: rescheduled (Calendly webhook)
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS meeting_status TEXT NOT NULL DEFAULT 'booked'
  CHECK (meeting_status IN ('booked', 'held', 'no_show', 'canceled', 'rescheduled'));

-- Lock flag: is the held/no-show decision final?
-- true = decision cannot be changed (window closed or manually locked by operator)
-- false = decision is still open for confirmation or override
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS held_decision_locked BOOLEAN NOT NULL DEFAULT false;

-- Who confirmed the held/no-show decision? Populated when meeting_status changes to held/no_show.
-- 'client': confirmed via email link or logged-in dashboard
-- 'operator': confirmed by Doug manually
-- 'auto': auto-held after window closure
-- NULL: decision not yet confirmed (still in booked status or awaiting confirmation)
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS held_confirmed_by TEXT
  CHECK (held_confirmed_by IS NULL OR held_confirmed_by IN ('client', 'operator', 'auto'));

-- Invitee phone number (optional, from Calendly custom_questions_answers or manually entered).
-- Captured as a seam for future prospect-facing SMS reminders and confirmations.
-- Unused in phase one.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS invitee_phone TEXT;

-- Is this meeting billable (owed under the qualified-meeting-fee model)?
-- Set to true when meeting_status = 'held' (confirmed or auto-held).
-- Set to false for canceled, rescheduled, no-show meetings.
-- Separate from billed_at — this field answers "is it owed?", not "was it invoiced?"
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS is_billable BOOLEAN NOT NULL DEFAULT false;

-- Timestamp when this meeting was actually invoiced (manual entry by Doug or accounting system).
-- NULL until Doug explicitly records the invoice.
-- Separate from is_billable: is_billable=true + billed_at=NULL means "owed but not yet invoiced"
-- DO NOT auto-populate on held or auto-held — remains NULL until manual invoicing action.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS billed_at TIMESTAMP WITH TIME ZONE;

-- ── 3. Indexes for auto-held resolution and confirmation queries ──────────

-- Fast lookup for auto-held resolution:
-- Find meetings past their scheduled_start_at + window, not locked, not canceled/rescheduled
CREATE INDEX IF NOT EXISTS idx_meetings_autoheld_eligible
  ON meetings(organisation_id, scheduled_start_at, held_decision_locked, meeting_status)
  WHERE meeting_status IN ('booked') AND held_decision_locked = false;

-- Fast lookup for client confirmation queries:
-- Find meetings awaiting confirmation (booked, within window, not locked)
CREATE INDEX IF NOT EXISTS idx_meetings_awaiting_confirmation
  ON meetings(organisation_id, meeting_status, held_decision_locked)
  WHERE meeting_status = 'booked' AND held_decision_locked = false;

-- Fast lookup by Calendly UUIDs:
-- Used during webhook processing to find existing meeting for Invitee Canceled events
CREATE INDEX IF NOT EXISTS idx_meetings_calendly_uuids
  ON meetings(calendly_event_uuid, calendly_invitee_uuid)
  WHERE calendly_event_uuid IS NOT NULL;

-- ── 4. Notes ────────────────────────────────────────────────────────────

-- scheduled_start_at NOT NULL constraint is omitted to avoid blocking existing rows with NULL meeting_date.
-- Phase B code enforces required scheduled_start_at at INSERT time via application validation.
-- Future migration can add NOT NULL constraint after all existing rows are backfilled.

-- meeting_status defaults to 'booked' for new meetings (Calendly Invitee Created or manual entry).
-- Legacy rows with NULL meeting_status will coexist with new rows until explicitly migrated.
-- Phase B code handles both old and new status columns during transition.
