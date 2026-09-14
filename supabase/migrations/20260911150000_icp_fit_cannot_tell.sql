-- Migration: 20260911150000_icp_fit_cannot_tell.sql
-- Status: APPLIED (verified live 2026-09-11), on Doug's approval. Production recorded it as
-- version 20260911192928 and the test project as 20260911192930. Both CHECKs read back from
-- pg_constraint with all five values and convalidated = true, and no row's icp_fit changed.
--
-- The fit judge gains a fourth outcome, 'cannot_tell': no grade was reached, because the
-- research did not show enough, the judge's answer failed, or it could not be read. Before
-- this, all three were stored as 'moderate'. See ICP_FIT_OUTCOMES in
-- src/lib/agents/research/types.ts, which a test compares against this CHECK.
--
-- WIDENING ONLY. Every value allowed before is still allowed and no row changes.
-- 'unassessed' stays: it is the column default for a prospect never graded, a different fact
-- from a grade the judge could not reach.
--
-- MUST BE APPLIED, to production and to the test project, BEFORE the code that writes
-- 'cannot_tell' is merged. Otherwise every research write that reaches no grade fails the CHECK.
--
-- Rollback: re-add the four-value CHECK. It fails while any row holds 'cannot_tell', which is
-- deliberate: those rows would need deciding first, not silently re-labelling as a grade.

ALTER TABLE public.prospects DROP CONSTRAINT prospects_icp_fit_check;
ALTER TABLE public.prospects ADD CONSTRAINT prospects_icp_fit_check
  CHECK (icp_fit = ANY (ARRAY['strong'::text, 'moderate'::text, 'weak'::text, 'unassessed'::text, 'cannot_tell'::text]));

ALTER TABLE public.prospect_research_results DROP CONSTRAINT prospect_research_results_icp_fit_check;
ALTER TABLE public.prospect_research_results ADD CONSTRAINT prospect_research_results_icp_fit_check
  CHECK (icp_fit = ANY (ARRAY['strong'::text, 'moderate'::text, 'weak'::text, 'unassessed'::text, 'cannot_tell'::text]));
