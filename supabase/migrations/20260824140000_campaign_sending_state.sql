-- Migration: store live sending health per campaign, separately from campaign status.
-- Date: 2026-08-24
--
-- Status: APPLIED (verified live 2026-08-24)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A SECOND COLUMN AND NOT A WIDER campaigns.status
--
-- campaigns.status answers "what did somebody INTEND this campaign to do". It is a copy
-- of Instantly's campaign_status and nothing more. A campaign sitting at 'active' can be
-- sending precisely nothing: outside its schedule window, out of leads, at its daily cap,
-- or with every sending account already at its own cap.
--
-- The client dashboard needs the other question answered: "is mail actually leaving right
-- now". Telling a client their campaign is live because status says 'active', while their
-- accounts are at limit, replaces one lie with a better-dressed one. So the two live in
-- two columns and are never conflated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHERE THE VALUE COMES FROM, AND THE ENUM THAT WAS VERIFIED
--
-- Source: GET /api/v2/campaigns/{id}/sending-status, verified 2026-08-24 against
-- https://developer.instantly.ai/api-reference/openapi.json,
-- paths./api/v2/campaigns/{id}/sending-status.get, response 200,
-- properties.diagnostics.properties.status. A closed enum of EIGHTEEN strings:
--
--   healthy                          <- the ONLY unobstructed value
--   campaign_draft
--   campaign_paused
--   campaign_completed
--   campaign_running_subsequences
--   campaign_bounce_protect
--   campaign_accounts_unhealthy
--   campaign_account_suspended
--   out_of_schedule
--   waiting_for_leads
--   daily_limit_met
--   account_daily_limit_met
--   new_lead_limit_met
--   all_accounts_unhealthy
--   waiting_for_esp_match
--   domain_limit_reached
--   follow_up_delay_not_met
--   no_accounts_available
--
-- WORTH STATING PLAINLY, BECAUSE IT IS EASY TO GET WRONG: this is NOT the same enum as
-- the campaign object's not_sending_status. That field, on components.schemas.def-1
-- properties.not_sending_status, is a five-value NUMERIC enum:
--   1 out of schedule, 2 waiting for leads, 3 daily limit met,
--   4 all accounts at daily limit, 99 error.
-- Both were verified in the same pass. Anyone who reads the endpoint response and maps it
-- through the five-code vocabulary loses thirteen values, including every campaign-state
-- code and every account-health code. The endpoint is strictly richer, which is why it is
-- the source used here and not_sending_status is not fetched at all.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO COLUMNS, ONE CANONICAL AND ONE RAW
--
-- sending_state is OURS. Seven canonical values, translated from Instantly's eighteen by
-- the handler, per the tool-agnostic rule in CLAUDE.md: nothing above the integrations
-- layer sees an Instantly string. It carries a CHECK because it is our vocabulary and we
-- control when it changes.
--
-- sending_status_raw is INSTANTLY'S. It carries no CHECK deliberately. Constraining it
-- would put Instantly's closed enum in two places at once, so the day they add a
-- nineteenth value the write fails and takes the campaign's counters down with it, in the
-- same UPDATE statement. It exists for diagnostics: when sending_state says 'waiting',
-- this says whether that is a schedule window or an ESP match. It is never rendered to a
-- client and never joined on.
--
-- sending_status_checked_at is when we last got an ANSWER, not when we last got a
-- healthy one. It is stamped even when Instantly reports no data, because "we asked at
-- 15:15 and Instantly had nothing to say" is a different fact from "we have not asked
-- since Tuesday", and the dashboard has to be able to tell them apart before it prints
-- the word live.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS sending_state            text,
  ADD COLUMN IF NOT EXISTS sending_status_raw       text,
  ADD COLUMN IF NOT EXISTS sending_status_checked_at timestamptz;

COMMENT ON COLUMN public.campaigns.sending_state IS
  'Canonical live sending health, translated from Instantly''s sending-status endpoint by '
  'src/lib/integrations/handlers/instantly/campaign-sending-status.ts. NULL means we have '
  'not established it: never checked, or checked and Instantly reported no data. Only '
  '''sending'' means mail is actually going out. Never infer this from campaigns.status, '
  'which is intent.';

COMMENT ON COLUMN public.campaigns.sending_status_raw IS
  'The raw Instantly sending-status code behind sending_state. Diagnostics only. Never '
  'rendered to a client, never joined on, deliberately unconstrained so a new Instantly '
  'enum value cannot fail the write that also carries the campaign counters.';

COMMENT ON COLUMN public.campaigns.sending_status_checked_at IS
  'When Instantly last answered the sending-status call for this campaign, whether or not '
  'the answer contained a status. Staleness here is what stops the dashboard claiming a '
  'campaign is live on the strength of a reading from days ago.';

-- The seven canonical values. NULL is allowed and means "not established".
--
-- WHY SEVEN AND NOT EIGHTEEN. The dashboard has to answer "is it sending, and if not, is
-- that something the client should worry about". Eighteen vendor codes cannot be rendered
-- without leaking Instantly's vocabulary into client-facing copy, and most of them differ
-- only in detail an operator needs and a client does not.
--
--   sending        healthy
--   draft          campaign_draft
--   paused         campaign_paused
--   completed      campaign_completed
--   waiting        out_of_schedule, waiting_for_leads, follow_up_delay_not_met,
--                  waiting_for_esp_match, campaign_running_subsequences
--   limit_reached  daily_limit_met, account_daily_limit_met, new_lead_limit_met,
--                  domain_limit_reached
--   blocked        campaign_bounce_protect, campaign_accounts_unhealthy,
--                  campaign_account_suspended, all_accounts_unhealthy,
--                  no_accounts_available
--
-- campaign_running_subsequences lands in 'waiting' here, while campaigns.status maps
-- Instantly status 4 to 'active'. That is not a contradiction, it is the two questions
-- diverging exactly where they should: the campaign is still WORKING (intent is active)
-- and the primary sequence is NOT SENDING (health is not healthy). The sending-status
-- endpoint settles the ambiguity BACKLOG.md flagged against status 4, because it lists
-- the code among the reasons a campaign is not sending and treats 'healthy' as the sole
-- unobstructed value.
ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_sending_state_check;

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_sending_state_check
  CHECK (sending_state IS NULL OR sending_state = ANY (ARRAY[
    'sending'::text,
    'draft'::text,
    'paused'::text,
    'completed'::text,
    'waiting'::text,
    'limit_reached'::text,
    'blocked'::text
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- No new policies. These are columns on campaigns, which already carries
-- clients_read_own_campaigns (organisation_id = get_my_organisation_id()) and
-- operators_full_access_campaigns. Column-level grants are not in use on this table, so
-- the new columns inherit the row policies that are already correct.

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION
--
-- Expected: three column rows, all nullable, two text and one timestamptz; and a CHECK
-- definition listing all seven canonical values plus the NULL allowance.

SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'campaigns'
   AND column_name IN ('sending_state', 'sending_status_raw', 'sending_status_checked_at')
 ORDER BY column_name;

SELECT pg_get_constraintdef(con.oid) AS sending_state_check
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
 WHERE rel.relname = 'campaigns'
   AND con.conname = 'campaigns_sending_state_check';
