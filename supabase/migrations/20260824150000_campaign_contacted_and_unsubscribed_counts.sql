-- Migration: store how many PEOPLE a campaign has contacted, and how many opted out,
--            alongside the existing count of emails sent.
-- Date: 2026-08-24
--
-- Status: APPLIED (verified live 2026-08-24)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY sent_count CANNOT ANSWER "HOW MANY PROSPECTS HAVE WE CONTACTED"
--
-- sent_count is emails. A four-step sequence sends up to four emails to one person, so
-- the two numbers diverge the moment a follow-up goes out. Live right now: campaign
-- cf695496 has sent_count 26 against 15 uploaded prospects.
--
-- The client overview has to say "prospects contacted", and there is no honest way to
-- derive it from what we already store:
--   - sent_count over-counts, badly, and gets worse every step of the sequence
--   - counting uploaded prospects is a different fact entirely. Uploaded means we handed
--     the list to the sending tool. Contacted means the sequence actually started for
--     that person. A campaign can hold leads it has not begun sending to.
--
-- Instantly answers it directly. GET /campaigns/analytics returns contacted_count,
-- documented as "Number of leads for whom the sequence has started", in the same response
-- that already carries emails_sent_count, reply_count and bounced_count. Verified
-- 2026-08-24 against paths./api/v2/campaigns/analytics.get in
-- https://developer.instantly.ai/api-reference/openapi.json. No extra API call.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY unsubscribed_count SHIPS IN THE SAME MIGRATION
--
-- It comes from the same analytics row, for free, and the client dashboard is required to
-- show an opt-out rate. Storing it now means the benchmarks work does not need its own
-- migration and its own edit to the poll loop. It is populated by this change and read by
-- the benchmarks page.
--
-- It is NOT a duplicate of the suppressed_emails table. That table is our global
-- suppression list, built from replies we classified as opt-outs plus manual additions,
-- and it is deliberately cross-campaign. This column is Instantly's own count of leads
-- who unsubscribed from THIS campaign. The two can legitimately disagree, and the rate a
-- client is shown must be the sending tool's number, because that is the one that governs
-- what actually goes out.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT 0, MATCHING THE COLUMNS THEY SIT BESIDE
--
-- sent_count, replied_count, bounced_count and open_count are all NOT NULL DEFAULT 0.
-- These two follow, so a caller summing across campaigns never has to null-guard, and so
-- the difference between "zero contacted" and "never refreshed" is carried by
-- campaign_stats_updated_at rather than smeared across every counter.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS contacted_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unsubscribed_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.campaigns.contacted_count IS
  'People, not emails. Instantly''s contacted_count: leads for whom the sequence has '
  'started. sent_count counts emails and over-counts people once follow-ups go out. This '
  'is the number behind "prospects contacted" on the client overview.';

COMMENT ON COLUMN public.campaigns.unsubscribed_count IS
  'Instantly''s count of leads who unsubscribed from this campaign. Not the same as the '
  'suppressed_emails table, which is our own cross-campaign suppression list. The client '
  'opt-out rate is computed from this, because the sending tool''s number is the one that '
  'governs what actually goes out.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- No new policies. Columns on campaigns, which already carries
-- clients_read_own_campaigns and operators_full_access_campaigns.

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION
--
-- Expected: two integer columns, both NOT NULL, both defaulting to 0.

SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'campaigns'
   AND column_name IN ('contacted_count', 'unsubscribed_count')
 ORDER BY column_name;
