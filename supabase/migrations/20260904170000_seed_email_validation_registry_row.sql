-- Seed the ACTIVE email-validation row so a rebuild produces a working validator.
--
-- Status: NOT APPLIED. Deliberately, and this is not an oversight.
--   Production already holds this row, so applying this file there is a no-op by
--   construction: ON CONFLICT DO NOTHING on an existing (capability, tool_name).
--   The session that wrote it was scoped to reads only against both projects, so nothing
--   was applied. Its entire purpose is the REBUILD path, where the row is absent.
--   Applying it whenever convenient is safe and changes no value; verify afterwards with
--     SELECT capability, tool_name, is_active, config
--       FROM integrations_registry WHERE capability = 'can_validate_email';
--   and expect two rows, exactly one of them active, unchanged from before.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
--
-- The active can_validate_email row has existed in production since 2026-06-15 and was
-- created by NO MIGRATION. It was inserted by hand or by a script that is not in this
-- repository. Grepping every migration for the tool name returns one hit and it is a
-- comment in 20260826001500.
--
-- MEASURED 2026-09-04, not inferred. A full ordered replay into a scratch database
-- produced an integrations_registry in which the only can_validate_email row was the
-- INACTIVE one. Consequences on a rebuild, every one of them silent:
--
--   * 20260903160000_daily_verification_limit_config.sql matches ZERO ROWS and does
--     nothing. An UPDATE that matches nothing returns success.
--   * getDailyVerificationLimit finds no active row, logs a warning, and falls back to
--     the compiled FALLBACK_DAILY_VERIFICATION_LIMIT of 100.
--   * The endpoint and key-name config the row carries do not exist at all.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY DO NOTHING, AND WHY THE ROW SET IS NOT ASSERTED
--
-- DO NOTHING means: fill this row if it is missing, never touch it if it is present. So
-- this file cannot change any live value, and it cannot revert a budget somebody edits
-- later.
--
-- It also names exactly one row and deletes nothing. Capabilities are added to this
-- table by other work in flight, and a seed that asserted the full row set would fight
-- them. Any row this file does not know about is left alone by construction.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ONE ACTIVE ROW PER CAPABILITY IS LOAD-BEARING
--
-- getDailyVerificationLimit reads .eq('capability','can_validate_email')
-- .eq('is_active', true).maybeSingle(). Two active rows would make maybeSingle error and
-- send the reader to its fallback. The other row for this capability is seeded
-- is_active = false in 20260420 and must stay that way.
--
-- FIELD PROVENANCE, so this reproduces the working row rather than a guess:
--   is_active            true          the row the verification sweep actually reads
--   api_handler_ref      handler path  matches the adapter module that owns the calls
--   connection_status    disconnected  the column default; never set on the live row
--   endpoint             base URL      DESCRIPTIVE ONLY. The handler builds its own URL
--                                      and does not read this key.
--   api_key_env_var      env var NAME  DESCRIPTIVE ONLY, and a name, never a secret.
--                                      The handler reads the environment directly.
--   max_retry_attempts   3             seeded and read by nothing today
--   retry_window_hours   6             seeded and read by nothing today
--   rate_limit_per_minute 30           seeded and read by nothing today
--   daily_verification_limit 10000     THE ONLY KEY ANYTHING READS, via
--                                      DAILY_VERIFICATION_LIMIT_KEY in
--                                      src/lib/sourcing/verification-limits.ts
--
-- The five descriptive keys are reproduced because the instruction was to seed the
-- working row and not a subset of it. That four of them are inert is recorded in BACKLOG
-- as its own decision to make later; deleting them here would be a second change hiding
-- inside this one.

INSERT INTO public.integrations_registry
  (capability, tool_name, is_active, api_handler_ref, connection_status, config)
VALUES (
  'can_validate_email',
  'myemailverifier',
  true,
  'src/lib/sourcing/handlers/adapter-myemailverifier',
  'disconnected',
  jsonb_build_object(
    'endpoint',                 'https://client.myemailverifier.com/verifier/validate_single',
    'api_key_env_var',          'MYEMAILVERIFIER_API_KEY',
    'max_retry_attempts',       3,
    'retry_window_hours',       6,
    'rate_limit_per_minute',    30,
    'daily_verification_limit', 10000
  )
)
ON CONFLICT (capability, tool_name) DO NOTHING;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- This file adds a row that production already has, so applying it live is a no-op and
-- reverting the code removes nothing. Deleting the row would break verification.
