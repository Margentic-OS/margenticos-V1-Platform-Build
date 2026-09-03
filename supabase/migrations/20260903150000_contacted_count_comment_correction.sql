-- Migration: 20260903150000_contacted_count_comment_correction.sql
-- Status: APPLIED (verified live 2026-09-03, both the primary and the baseline-restore-test project)
--
-- Comment only. No schema change, no data change.
--
-- WHY
--
-- campaigns.contacted_count carried a comment stating that it holds "Instantly's
-- contacted_count: leads for whom the sequence has started". That is what Instantly's
-- OpenAPI document says about the field, and it is wrong. Measured live on one campaign
-- on 2026-09-03:
--
--     leads_count                 24
--     new_leads_contacted_count   24
--     contacted_count             52     <- cannot be people: 52 > 24 leads
--     emails_sent_count           60
--
-- contacted_count exceeded the number of leads that existed, so it was never a count of
-- people. It tracks emails, lagging emails_sent_count. The column was therefore holding
-- an email count while the client overview rendered it as "prospects contacted", which
-- read 52 for a campaign that had emailed 24 people.
--
-- The column now holds new_leads_contacted_count, confirmed against two independent
-- ground truths rather than against the documentation: a FILTER_VAL_CONTACTED lead
-- listing returned exactly 24 distinct leads, and the per-step analytics showed 24 sends
-- on step one.
--
-- The comment is corrected here because it was actively asserting the thing that caused
-- the defect, and a future session reading it would have been told to trust the wrong
-- field. See campaign-analytics.ts, which carries the same measurement.

COMMENT ON COLUMN public.campaigns.contacted_count IS
  'People with at least one send, NOT emails. Sourced from the outbound provider''s '
  'new_leads_contacted_count and bounded by its leads_count. Do NOT source this from a '
  'field merely named contacted_count: on Instantly that field counts emails and read 52 '
  'against 24 leads on 2026-09-03, which is the defect this comment exists to prevent. '
  'sent_count is the email counter. This is the number behind "prospects contacted" on '
  'the client overview.';

-- Verification (expect the corrected text):
--   SELECT col_description('public.campaigns'::regclass,
--            (SELECT ordinal_position FROM information_schema.columns
--              WHERE table_schema='public' AND table_name='campaigns'
--                AND column_name='contacted_count')::int);
