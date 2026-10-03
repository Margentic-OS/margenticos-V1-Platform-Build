-- Competitor exclusion: where the verdict on one prospect is kept.
-- Status: APPLIED (verified live 2026-10-01, production and test database; column type, RLS and grants read back)
--
-- Operator rule 7 of the second reading (2026-10-01): a prospect that sells the same
-- service as the client is a competitor, not a buyer, and is excluded BEFORE research is
-- paid for. The categories live in the client's outbound brief
-- (strategy_documents.content.outbound_brief.competitor_categories). This column holds
-- what the screen decided about one prospect, written by
-- src/lib/sourcing/competitor-screen.ts and by nothing else.
--
-- One additive, nullable jsonb column. NULL means "never judged": a prospect whose
-- provider record carries none of the brief's phrases is never judged and never written,
-- because that check is free and is simply repeated. A row is written only when a model
-- was asked, so the paid question is never asked twice under the same list.
--
-- THE EXCLUSION ITSELF IS NOT THIS COLUMN. An excluded prospect also gets
-- sourced_tier = NULL and tiering_reason = 'competitor', which is the shape every paid
-- stage already refuses (src/lib/sourcing/tier-verdict.ts). This column is what makes that
-- verdict SURVIVE a re-tier: classifyTier reads it first, so a later tiering run, the
-- industry-tag re-tier and the settings-change thaw all return 'competitor' again rather
-- than quietly re-admitting the company.
--
-- RLS and grants: adding a column changes neither. prospects already has RLS enabled.
-- Read back after applying, per CLAUDE.md.

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS competitor_check jsonb;

COMMENT ON COLUMN public.prospects.competitor_check IS
  'Verdict of the competitor screen for this prospect: outcome (excluded or clear), the brief category, the phrases that matched, the model''s evidence, and the fingerprint of the category list it was judged against. NULL = never judged. Written only by src/lib/sourcing/competitor-screen.ts.';
