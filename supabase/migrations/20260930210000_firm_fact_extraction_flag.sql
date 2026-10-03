-- Firm-fact tier: the stop switch for extraction, seeded ON.
-- Status: APPLIED (verified live 2026-09-30 on production; applied to the test database too)
--
-- system_flags.firm_fact_extraction = true means firm-fact extraction may run. It is read
-- before every extraction by firmFactExtractionAllowed() in
-- src/lib/agents/research/firm-fact.ts, and a missing or unreadable row means NO
-- extraction (fail closed, the opposite default to the queue flags, because the failure
-- here would be spending money, not stalling work).
--
-- It is switched OFF automatically by post-call cost reconciliation if any prospect's
-- actual firm-fact cost exceeds $0.02, which the construction says is impossible: an
-- assumption is wrong and nobody should spend more until a person has looked.
--
-- ON here does not switch the TIER on. Extraction is also gated per client by
-- content.firm_fact_tier.enabled in the messaging document, and composition by the same.
-- This flag is the global brake under both.

INSERT INTO public.system_flags (key, enabled, note, updated_by)
VALUES (
  'firm_fact_extraction',
  true,
  'Firm-fact extraction allowed. Switched off automatically if a prospect''s actual cost exceeds $0.02.',
  'migration 20260930210000'
)
ON CONFLICT (key) DO NOTHING;
