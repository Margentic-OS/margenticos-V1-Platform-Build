-- A client may run more than one campaign for the same segment, each serving a REGION.
--
-- Operator instruction, 2026-10-05 (Backlog: "Route prospects to campaigns by time zone").
-- Until now handleUploadLeads matched prospects to campaigns by segment alone and refused a
-- segment with two campaigns as "ambiguous routing". A UK prospect therefore got the one
-- campaign's US Eastern window, landing mid-afternoon to evening UK time.
--
-- WHAT THE COLUMNS MEAN
--   region_countries  ISO 3166-1 alpha-2 codes this campaign takes, the same canonical form
--                     prospects.country is stored in (src/lib/sourcing/country-code.ts).
--                     NULL means the CATCH-ALL: every country no sibling campaign names,
--                     INCLUDING a prospect whose country is unknown. Every existing campaign
--                     is NULL, so a client with one campaign routes exactly as before.
--   region_name       What the operator sees on the upload panel ("UK/IE"). Display only;
--                     routing never reads it.
--
-- The router is src/lib/outbound/campaign-routing.ts. It refuses, rather than guesses, when
-- two campaigns in a segment name the same country or a segment has two catch-alls.
--
-- THE SCHEDULE IS DELIBERATELY NOT STORED HERE. Each campaign's send window, time zone and
-- daily limit live on the provider's campaign, which is the thing that enforces them, and
-- the upload panel reads them from there. A second copy in this table would be a record that
-- can stop being true without anything noticing.
--
-- ACCESS. Additive columns on an existing table; they inherit its grants and RLS (operators
-- ALL, a client SELECT on its own rows). No grant changes.
--
-- Status: APPLIED (verified live 2026-10-05, production and test database; columns, CHECK constraint read back; anon holds no SELECT or UPDATE on campaigns)

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS region_name text,
  ADD COLUMN IF NOT EXISTS region_countries text[];

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_region_countries_iso2 CHECK (
    region_countries IS NULL
    OR (
      cardinality(region_countries) > 0
      AND array_to_string(region_countries, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'
    )
  );

COMMENT ON COLUMN public.campaigns.region_countries IS
  'ISO-2 country codes this campaign takes at upload. NULL = catch-all: every country no sibling campaign in the same segment names, including unknown. Routed by src/lib/outbound/campaign-routing.ts.';
COMMENT ON COLUMN public.campaigns.region_name IS
  'Operator-facing label for the campaign''s region, e.g. UK/IE. Display only; routing reads region_countries.';
