-- organisations.sourcing_revenue_filter_enabled: the per-client opt-in for the revenue band.
--
-- Status: APPLIED (verified live 2026-09-10)
--   Production hjpvnvjryxdjcfdsfhzy: recorded as version 20260910233902 (the MCP records its
--     own timestamp, not this filename's). Read back: boolean, NOT NULL, default false,
--     comment present, 5 organisations, 0 opted in.
--   Test tidqheqjzvwmrrrebzir: applied the same day. Read back identically, 570
--     organisations, 0 opted in.
--   Both: organisations policies unchanged, operators_full_access_organisations (ALL) and
--     clients_read_own_organisation (SELECT). No client write path.
--   Applied before the branch is merged. Additive and defaulted, so the deployed code, which
--     does not read the column, is unaffected until merge.
--
-- ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
--
-- A client's ICP document may state a revenue band, and the spec derived at approval would
-- send it to the sourcing provider as a filter. MEASURED 2026-09-10: the provider's revenue
-- filter EXCLUDES every company it holds no revenue figure for, and no request shape keeps
-- them (19 tried, including every "include unknown" flag, all silently dropped). On one live
-- client's search 78% of people sat at companies with no figure, and a band kept 3,873 of
-- 98,831. So the cut is mostly companies the provider knows nothing about, not companies
-- outside the band.
--
-- So the band is OPT-IN PER CLIENT and DEFAULT OFF. When off, the spec still reads the band
-- from the document and records it as deliberately switched off, with the reason. When on,
-- the band is sent.
--
-- ─── READ WHEN THE SPEC IS BUILT, NOT WHEN THE SEARCH RUNS ───────────────────
--
-- The stored spec must describe the search it produces, so the switch is read at spec
-- derivation (ICP approval) and takes effect at the next approval. Flipping it does not
-- rewrite a stored spec. Reading it at search time instead would let the stored spec say
-- one thing while the search did another, which is the defect this change set exists to end.
--
-- ─── ACCESS ──────────────────────────────────────────────────────────────────
--
-- Inherits organisations' existing policies, read back live on 2026-09-10:
-- operators_full_access_organisations (ALL, is_operator()) and clients_read_own_organisation
-- (SELECT only). There is no client UPDATE policy, so a client cannot switch it on.

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS sourcing_revenue_filter_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organisations.sourcing_revenue_filter_enabled IS
  'Per-client opt-in for the ICP revenue band as a sourcing filter. Default false. Read when the spec is derived at ICP approval, so a change takes effect at the next approval. The provider filter excludes every company with no revenue figure recorded.';
