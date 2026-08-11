-- Migration: Add fit_score column for phase 1 tiering consolidation
-- Status: PENDING

alter table prospects add column fit_score integer;

comment on column prospects.fit_score is 'Fitness score (0-100) calculated during prospect classification. Used in phase 1 two-stage tiering model (disqualifiers + fit score). Null indicates prospect was removed in disqualifier stage.';

-- Create index for tiering queries
create index if not exists prospects_fit_score_idx on prospects(organisation_id, fit_score);

-- Status: APPLIED (verified live 2026-08-11)
