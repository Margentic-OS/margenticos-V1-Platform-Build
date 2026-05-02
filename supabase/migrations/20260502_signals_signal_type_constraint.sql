-- 20260502_signals_signal_type_constraint.sql
-- Replaces the signals.signal_type CHECK constraint with values that match
-- what the application actually writes and anticipated future signal sources.
--
-- Background:
--   The original constraint was written for the Phase 1 PRD signal taxonomy
--   (email_open, email_reply, email_bounce, etc.). The Group 3 polling
--   implementation chose different, more descriptive names following the
--   "noun + past-tense verb" convention (reply_received, email_bounced,
--   lead_unsubscribed). The constraint was never updated. Because the
--   campaigns table was also empty, no inserts were ever attempted and the
--   mismatch was latent. Caught by Group 4 testing (2026-05-02).
--
-- Naming convention: noun + past-tense verb.
--   Exception: meeting_no_show — "no-show" is established industry terminology;
--   readability takes precedence over strict convention here.
--
-- Classifier intents (opt_out, out_of_office, etc.) are NOT signal_types.
-- They are stored in reply_handling_actions.classified_intent, not signals.
--
-- Pre-check (run before applying — verify 0 rows returned):
--   SELECT count(*) FROM signals;
-- Expected result: 0. If any rows exist, verify their signal_type values fit
-- the new constraint before applying.
-- Pre-check result at time of migration: 0 rows (confirmed 2026-05-02).
--
-- ATOMICITY: Wrapped in BEGIN / COMMIT. All DDL is transactional in Postgres 17.

BEGIN;

ALTER TABLE signals DROP CONSTRAINT signals_signal_type_check;

ALTER TABLE signals ADD CONSTRAINT signals_signal_type_check
  CHECK (signal_type IN (
    -- Active types (currently written by polling code in instantly.ts)
    'reply_received',
    'email_bounced',
    'lead_unsubscribed',

    -- Anticipated email signals (not yet implemented — included for forward
    -- compatibility so no schema migration is needed when these come online)
    'email_opened',
    'email_clicked',
    'email_marked_spam',

    -- Anticipated LinkedIn signals (ADR-006 future scope)
    'linkedin_post_liked',
    'linkedin_post_commented',
    'linkedin_dm_received',

    -- Anticipated meeting signals (GoHighLevel future scope)
    'meeting_booked',
    'meeting_qualified',
    'meeting_unqualified',
    'meeting_no_show'
  ));

-- Original PRD taxonomy (email_open, email_reply, email_bounce, email_spam,
-- linkedin_post_like, linkedin_post_comment, linkedin_dm_reply, opt_out,
-- positive_reply, information_request) removed. Those names were aspirational
-- and never implemented in any polling or processing code.

COMMIT;
