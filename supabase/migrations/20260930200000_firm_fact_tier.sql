-- Firm-fact tier: where the extracted fact, its cost, and the tier each lead received live.
-- Status: APPLIED (verified live 2026-09-30, production and test database; columns and grants read back)
--
-- Plan: Notion "Firm-fact tier: plan (decided 30 September)", Round 7 build specification.
--
-- Three additive, nullable columns. Nothing reads them until the code on branch
-- firm-fact-tier merges, and nothing writes them until then either, so applying this ahead
-- of the merge is safe: deployed code never selects them and a NULL means "no fact".
--
-- 1. prospects.firm_fact
--    One jsonb verdict per prospect, written by src/lib/agents/research/firm-fact.ts only
--    for prospects that ended on template and are not yet uploaded. Holds the extracted
--    clause ({does}), the prospect's customer category ({for_whom}), the peer group label
--    chosen from the client's closed list, the verbatim quote and source URL, the research
--    row it was read from, and the verdict of every check. A failed extraction is STORED
--    with passed = false and its reason, so a second run does not pay again.
--
-- 2. research_usage.firm_fact
--    Token usage for the two firm-fact calls (extraction and the faithfulness judge),
--    kept separate from `opening` so the $0.02 per-prospect ceiling can be read back
--    directly. The row is written with arm = 'firm_fact' and research_result_id NULL,
--    which the existing CHECK (arm IS NOT NULL OR research_result_id IS NOT NULL)
--    admits, because research_result_id is UNIQUE and the research row already has
--    its own usage row.
--
-- 3. sent_sequences.opening_tier / opening_detail
--    Which of the three tiers each lead actually received (research, firm_fact,
--    template), and for the firm-fact tier which opener frame and which slot fills were
--    used. Without this, positive replies cannot be compared by tier.
--
-- RLS and grants: adding a column does not change a table's RLS or its grants. All three
-- tables already have RLS enabled; research_usage and sent_sequences are service-role
-- only. Read back after applying, both directions, per CLAUDE.md.

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS firm_fact jsonb;

COMMENT ON COLUMN public.prospects.firm_fact IS
  'Firm-fact tier verdict for a template-bound prospect. Written only by the firm-fact extraction step. NULL = never attempted. passed=false rows are kept so a re-run does not pay twice.';

ALTER TABLE public.research_usage
  ADD COLUMN IF NOT EXISTS firm_fact jsonb;

COMMENT ON COLUMN public.research_usage.firm_fact IS
  'Token usage of the firm-fact extraction and faithfulness judge calls, with per-model detail and the computed USD at full price. Rows carrying it use arm = firm_fact.';

ALTER TABLE public.sent_sequences
  ADD COLUMN IF NOT EXISTS opening_tier text,
  ADD COLUMN IF NOT EXISTS opening_detail jsonb;

ALTER TABLE public.sent_sequences
  DROP CONSTRAINT IF EXISTS sent_sequences_opening_tier_check;

ALTER TABLE public.sent_sequences
  ADD CONSTRAINT sent_sequences_opening_tier_check
  CHECK (opening_tier IS NULL OR opening_tier IN ('research', 'firm_fact', 'template'));

COMMENT ON COLUMN public.sent_sequences.opening_tier IS
  'Which Email 1 tier this lead received: research (a written trigger), firm_fact (opener from the prospect''s own site) or template. NULL on rows written before 2026-09-30.';
