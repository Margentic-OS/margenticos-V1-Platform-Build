-- Update research_source check constraint to match agent spec.
-- The stub used 'website'; the prospect research agent spec defines 'website_fetch'.
ALTER TABLE prospects
  DROP CONSTRAINT IF EXISTS prospects_research_source_check,
  ADD CONSTRAINT prospects_research_source_check
    CHECK (research_source = ANY (ARRAY['apollo', 'web_search', 'website_fetch', 'pain_proxy']));
