-- Migration: suppressed_emails gains carry state
-- Date: 2026-09-04
--
-- Status: APPLIED (verified live 2026-09-04)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
--
-- A suppression that never reaches the sending provider stops nothing. Until now the
-- only thing that carried a global-list suppression out to the provider was the bounce
-- poller, inline, in the same loop iteration that detected the bounce. That call is
-- driven by the poller RE-READING the bounced lead on its full scan.
--
-- So the carry depended on a condition outside our control: the provider still showing
-- us that lead, in a campaign we still have registered, for an organisation we have not
-- archived. When any of those stops being true, the address sits on the global list and
-- NOTHING will ever carry it.
--
-- That is not hypothetical. Measured 2026-09-04, this is the state of the only bounce
-- this system has ever seen: on the list since 2026-08-28, never carried, and no code
-- path can pick it up, because its campaign was unregistered and its organisation
-- archived within the hour of the bounce.
--
-- These columns turn the suppression ROW into the ledger. A row that has not been
-- carried is visible, retryable, and monitorable, whatever the provider currently shows.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THREE COLUMNS AND NOT A SEPARATE TABLE
--
-- One address has one carry outcome, and the address is already the key of this table.
-- A join table would add a second place for "is this address dealt with" to be recorded,
-- which is the two-sources-of-truth shape CLAUDE.md records four times.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY carry_attempted_at IS SET ON FAILURE TOO
--
-- It is the LAST ATTEMPT stamp, not a success stamp. Success is carry_status. Naming it
-- carried_at and setting it on failure would make the column lie, and reading it as
-- "when this was carried" is exactly the misreading this whole change exists to stop.
--
-- The sweep uses it for backoff: a row that fails permanently (a provider id that will
-- never resolve, of which this database already holds one) must not generate a provider
-- call every fifteen minutes for ever.

ALTER TABLE public.suppressed_emails
  -- NULL means never attempted. That is the state every existing row is in, and it is
  -- the state the sweep looks for first. It is deliberately distinguishable from
  -- 'not_required', which means we asked the provider and it holds nothing.
  ADD COLUMN IF NOT EXISTS carry_status       text,
  ADD COLUMN IF NOT EXISTS carry_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS carry_error        text;

-- Mirrors OUTBOUND_SUPPRESSION_STATUSES in src/lib/suppression/provider-suppression.ts
-- and the CHECK in 20260904100000_provider_suppression_columns.sql. Same three values,
-- deliberately, so an operator reading either store reads the same vocabulary.
-- Changing one means changing all three in the same commit.
ALTER TABLE public.suppressed_emails
  DROP CONSTRAINT IF EXISTS suppressed_emails_carry_status_valid;
ALTER TABLE public.suppressed_emails
  ADD CONSTRAINT suppressed_emails_carry_status_valid
  CHECK (carry_status IS NULL OR carry_status IN ('not_required', 'confirmed', 'failed'));

-- A status with no attempt behind it, or an attempt with no status, is a half-written
-- record. Both move together or neither does. Same shape as the revocation constraint
-- above it, and for the same reason.
ALTER TABLE public.suppressed_emails
  DROP CONSTRAINT IF EXISTS suppressed_emails_carry_complete;
ALTER TABLE public.suppressed_emails
  ADD CONSTRAINT suppressed_emails_carry_complete
  CHECK (
    (carry_status IS NULL     AND carry_attempted_at IS NULL)
    OR
    (carry_status IS NOT NULL AND carry_attempted_at IS NOT NULL)
  );

-- A failure MUST carry a reason, and a success must not.
--
-- The first half is the important one. provider-suppression.ts already refuses to return
-- "a silent empty string" on failure, and this is the database saying the same thing: a
-- failed carry with no reason is a row an operator cannot act on, and it is precisely
-- what a caught-and-swallowed exception would write.
ALTER TABLE public.suppressed_emails
  DROP CONSTRAINT IF EXISTS suppressed_emails_carry_error_matches_status;
ALTER TABLE public.suppressed_emails
  ADD CONSTRAINT suppressed_emails_carry_error_matches_status
  CHECK (
    (carry_status = 'failed'  AND carry_error IS NOT NULL AND length(btrim(carry_error)) > 0)
    OR
    (carry_status IS DISTINCT FROM 'failed' AND carry_error IS NULL)
  );

-- The sweep's query: active rows that still need carrying, oldest attempt first.
-- Partial, because a confirmed row is never selected again and there is no reason to
-- index it. This stays small by construction.
CREATE INDEX IF NOT EXISTS suppressed_emails_needs_carry_idx
  ON public.suppressed_emails (carry_attempted_at NULLS FIRST)
  WHERE revoked_at IS NULL
    AND (carry_status IS NULL OR carry_status = 'failed');

COMMENT ON COLUMN public.suppressed_emails.carry_status IS
  'Whether this suppression reached the sending provider. NULL = never attempted. '
  'not_required = the provider holds no lead for this address. confirmed = every lead '
  'it held was stopped and read back. failed = see carry_error. Written ONLY by '
  'carryOneSuppression in src/lib/suppression/carry.ts.';

COMMENT ON COLUMN public.suppressed_emails.carry_attempted_at IS
  'When the carry was LAST ATTEMPTED, set on failure as well as success. Not a success '
  'stamp: success is carry_status. Used for retry backoff.';

-- ─────────────────────────────────────────────────────────────────────────────
-- ACCESS
--
-- No grant change is needed or made: 20260821172500_create_suppressed_emails.sql already
-- grants SELECT, INSERT, UPDATE on this table to service_role and revokes anon and
-- authenticated by name, and privileges are per TABLE, not per column.
--
-- Read back anyway rather than assumed, in both directions, per the standing rule.
-- Expected: t, t, t, f, f.
SELECT
  has_table_privilege('service_role',  'public.suppressed_emails', 'SELECT') AS service_select,
  has_table_privilege('service_role',  'public.suppressed_emails', 'INSERT') AS service_insert,
  has_table_privilege('service_role',  'public.suppressed_emails', 'UPDATE') AS service_update,
  has_table_privilege('authenticated', 'public.suppressed_emails', 'SELECT') AS authenticated_select,
  has_table_privilege('anon',          'public.suppressed_emails', 'SELECT') AS anon_select;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--
-- Additive and nullable, and no gate reads these columns: the send gate consults
-- suppressed_emails only through lookupSuppressedEmails, which selects email alone.
-- So dropping them cannot make a send less safe than it is today.
--
--   ALTER TABLE public.suppressed_emails
--     DROP COLUMN IF EXISTS carry_status,
--     DROP COLUMN IF EXISTS carry_attempted_at,
--     DROP COLUMN IF EXISTS carry_error;
--
-- The provider stops already made stay made. They are at the provider, not here.
