-- Migration: 20260903153000_contacted_count_comment_evidence.sql
-- Status: APPLIED (verified live 2026-09-03, both the primary and the baseline-restore-test project)
--
-- Comment only. No schema change, no data change.
--
-- WHY
--
-- 20260903150000 corrected this comment to say the provider's contacted_count "counts
-- emails". That was an inference from two readings taken minutes apart, and it does not
-- hold. docs/DISCOVERY-per-domain-health.md captured the SAME campaign on 2026-08-24
-- reporting contacted_count 15 against leads_count 15 and emails_sent_count 30, where it
-- matched the people count exactly and was nowhere near the email count.
--
-- So the field is not consistently an email counter and is not consistently a people
-- counter. It agreed with people for weeks, then read 52 against 24 leads. Saying "it
-- counts emails" in a comment invites the next reader to use it wherever an email count
-- is wanted, which would be wrong for a different reason.
--
-- What is certain, and all this column needs to record: it exceeded the campaign's own
-- lead count, so it cannot be rendered as people, and the guard is a bound rather than a
-- theory about what the field means.

COMMENT ON COLUMN public.campaigns.contacted_count IS
  'People with at least one send, NOT emails. Sourced from the outbound provider''s '
  'new_leads_contacted_count and bounded by its leads_count. Do NOT source this from a '
  'field merely named contacted_count: on Instantly that field read 52 against 24 leads '
  'on 2026-09-03, having matched the people count exactly on 2026-08-24, so it is not '
  'reliably people and is not reliably emails either. sent_count is the email counter. '
  'This is the number behind "prospects contacted" on the client overview.';

-- Verification (expect the corrected text):
--   SELECT col_description('public.campaigns'::regclass,
--            (SELECT ordinal_position FROM information_schema.columns
--              WHERE table_schema='public' AND table_name='campaigns'
--                AND column_name='contacted_count')::int);
