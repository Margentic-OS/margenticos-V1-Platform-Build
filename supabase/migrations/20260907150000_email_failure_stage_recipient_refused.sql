-- Status: APPLIED (verified live 2026-09-07). pg_get_constraintdef reads back
-- CHECK (stage = ANY (ARRAY['content_validation','provider_send','recipient_refused'])).
-- Extend the email_delivery_failures stage CHECK with 'recipient_refused'.
--
-- Two guards landed in sendTransactionalEmail on 2026-09-07, after the table in
-- 20260907140000 was written:
--
--   * TEST_EMAIL_RECIPIENT found set in production, where it would redirect every email
--     in the system to one address. The send is refused rather than silently delivered.
--   * An operator-only email whose recipient belongs to a client user.
--
-- Neither is a content fault and neither reached the provider, so recording them as
-- 'content_validation' would misreport both, and 'provider_send' would be a lie about
-- where they stopped.
--
-- MON-030 needs no change: its PROBLEM state counts every unresolved row regardless of
-- stage. Only its n_validation breakdown excludes these, which is correct, since they are
-- not validation failures.

ALTER TABLE public.email_delivery_failures
  DROP CONSTRAINT IF EXISTS email_delivery_failures_stage_check;

ALTER TABLE public.email_delivery_failures
  ADD CONSTRAINT email_delivery_failures_stage_check
  CHECK (stage IN ('content_validation', 'provider_send', 'recipient_refused'));
