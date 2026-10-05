-- A regional campaign switches itself on when its first leads arrive, and the client's daily
-- sending stays at its configured total.
--
-- Operator instruction, 2026-10-05: "when an upload routes leads to a paused regional campaign
-- that has never sent, activate it and set each campaign's daily limit from per-client config,
-- keeping the client's total at its cap. While a regional campaign has no leads, the other
-- campaign carries the full total." Built in src/lib/outbound/regional-activation.ts, called by
-- handleUploadLeads after the upload.
--
-- CONFIG, ONE SOURCE EACH (Rule Zero: per client, nothing hard-coded)
--   organisations.outbound_daily_cap  the client's total sends per day across every campaign.
--                                     NULL = limits are not managed for this client, and a
--                                     regional campaign is NOT auto-activated (it stays paused
--                                     and the log says why).
--   campaigns.daily_limit_share       a REGIONAL campaign's daily limit once it is live.
--                                     The catch-all campaign has no share: its limit is the cap
--                                     minus the shares of the live regional campaigns. Derived,
--                                     not stored, so the parts cannot drift from the total.
--   campaigns.auto_activated_at       set when the upload switched the campaign on. A campaign
--                                     is auto-activated once only: if an operator pauses it
--                                     afterwards, an upload never switches it back on.
--
-- THE LOG. campaign_automation_log records every automatic activation and limit change, and
-- every refusal, with the before and after values. The upload panel shows it. Service-role
-- only: written by the upload action with the service client, read by the operator page with
-- the service client. RLS on with no policies AND anon/authenticated revoked by name, per the
-- database security rules (RLS must not be the only layer).
--
-- Status: APPLIED (verified live 2026-10-05, production and test database; anon and authenticated hold none of the eight privileges on campaign_automation_log or its sequence, service_role all; RLS on; columns read back)

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS outbound_daily_cap integer
    CONSTRAINT organisations_outbound_daily_cap_positive CHECK (outbound_daily_cap IS NULL OR outbound_daily_cap > 0);

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS daily_limit_share integer
    CONSTRAINT campaigns_daily_limit_share_positive CHECK (daily_limit_share IS NULL OR daily_limit_share > 0),
  ADD COLUMN IF NOT EXISTS auto_activated_at timestamptz;

COMMENT ON COLUMN public.organisations.outbound_daily_cap IS
  'Client total sends per day across all campaigns. NULL = not managed: regional campaigns are never auto-activated. See src/lib/outbound/regional-activation.ts.';
COMMENT ON COLUMN public.campaigns.daily_limit_share IS
  'A regional campaign''s daily limit once it has leads. The catch-all''s limit is outbound_daily_cap minus the live regional shares, derived, never stored.';
COMMENT ON COLUMN public.campaigns.auto_activated_at IS
  'When an upload switched this regional campaign on. Set once; an upload never re-activates a campaign an operator paused afterwards.';

CREATE TABLE IF NOT EXISTS public.campaign_automation_log (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  campaign_id     uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN ('activated', 'daily_limit_set', 'refused', 'failed')),
  from_value      text,
  to_value        text,
  detail          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_automation_log_org_created_idx
  ON public.campaign_automation_log (organisation_id, created_at DESC);

ALTER TABLE public.campaign_automation_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.campaign_automation_log FROM PUBLIC;
REVOKE ALL ON TABLE public.campaign_automation_log FROM anon, authenticated;
GRANT ALL ON TABLE public.campaign_automation_log TO service_role;
REVOKE ALL ON SEQUENCE public.campaign_automation_log_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.campaign_automation_log_id_seq TO service_role;

COMMENT ON TABLE public.campaign_automation_log IS
  'Every automatic campaign activation and daily-limit change made by an upload, and every refusal. Service-role only; shown on the operator upload panel.';
