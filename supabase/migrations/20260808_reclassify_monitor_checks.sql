-- Reclassify daily cron monitors in monitor_checks after moving to pg_cron
--
-- MON-007 and MON-010: Now scheduled via pg_cron (daily), update classification
-- MON-008 and MON-009: Built but never-running jobs, update plain copy to reflect this

-- Update MON-007: strategy-doc-auto-approve
UPDATE monitor_checks
SET
  category = 'liveness',
  is_scheduled = true,
  expected_interval_minutes = 1440,
  plain_meaning = 'Runs once daily at 06:00 UTC via pg_cron to auto-approve strategy documents whose 3-day window has elapsed.'
WHERE code = 'MON-007-UNSCHEDULED';

-- Update MON-010: resolve-auto-held
UPDATE monitor_checks
SET
  category = 'liveness',
  is_scheduled = true,
  expected_interval_minutes = 1440,
  plain_meaning = 'Runs once daily at 09:00 UTC via pg_cron to resolve meetings past their auto-held window.'
WHERE code = 'MON-010-UNSCHEDULED';

-- Update MON-008: intake nudge (built but never-running job)
UPDATE monitor_checks
SET
  plain_meaning = 'Built but never-running job (no scheduled trigger). The intake flow supports manual nudges; automated nudges deferred to phase 2.'
WHERE code = 'MON-008-UNSCHEDULED';

-- Update MON-009: warmup halfway (built but never-running job)
UPDATE monitor_checks
SET
  plain_meaning = 'Built but never-running job (no scheduled trigger). Warmup halfway integration deferred to phase 2.'
WHERE code = 'MON-009-UNSCHEDULED';
