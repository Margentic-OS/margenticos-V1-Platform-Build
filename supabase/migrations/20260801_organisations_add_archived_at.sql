-- Add org archiving: nullable archived_at timestamp for soft-deletion without data loss.
-- Archived orgs are excluded from all enumeration surfaces, cron iterations, and spend gates.
-- Late-arrival signals (replies, events) referencing archived orgs are recorded but not processed.

ALTER TABLE public.organisations
  ADD COLUMN archived_at timestamptz DEFAULT NULL;

-- Index for fast filtering in queries (all enumeration surfaces will use .is('archived_at', null))
CREATE INDEX idx_organisations_archived_at ON public.organisations (archived_at) WHERE archived_at IS NULL;
