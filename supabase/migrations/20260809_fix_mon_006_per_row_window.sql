-- Fix MON-006: per-row window evaluation, not single-org window
-- Each pending client_revision is now checked against its OWN org's auto_approve_window_hours
-- state='PROBLEM' if ANY row exceeds its own window
-- detail = count of overdue + oldest overdue timestamp
-- No LIMIT 1 subquery; evaluates all rows per-org

CREATE OR REPLACE VIEW public.mon_006 AS
  WITH revisions_with_windows AS (
    SELECT
      ds.created_at,
      o.auto_approve_window_hours,
      EXTRACT(EPOCH FROM (now() - ds.created_at)) / 60 / 60 as age_hours,
      EXTRACT(EPOCH FROM (now() - ds.created_at)) / 60 / 60 > COALESCE(o.auto_approve_window_hours, 72) as is_overdue
    FROM public.document_suggestions ds
    JOIN public.organisations o ON ds.organisation_id = o.id
    WHERE ds.status = 'pending'
      AND ds.update_trigger = 'client_revision'
      AND o.archived_at IS NULL
  ),
  overdue_summary AS (
    SELECT
      COUNT(*) as overdue_count,
      MIN(created_at) as oldest_overdue_created
    FROM revisions_with_windows
    WHERE is_overdue = true
  ),
  all_pending AS (
    SELECT COUNT(*) as revision_count
    FROM revisions_with_windows
  )
  SELECT
    'MON-006'::text as check_code,
    CASE
      WHEN all_pending.revision_count = 0 THEN 'OK'
      WHEN overdue_summary.overdue_count > 0 THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    CASE
      WHEN all_pending.revision_count = 0 THEN 'No client revisions pending'
      WHEN overdue_summary.overdue_count > 0 THEN
        overdue_summary.overdue_count::text || ' overdue revision(s) (exceeding org window). Oldest: ' ||
        TO_CHAR(overdue_summary.oldest_overdue_created, 'YYYY-MM-DD HH24:MI:SS UTC')
      ELSE all_pending.revision_count::text || ' revision(s) awaiting review (within window)'
    END as detail,
    CASE
      WHEN overdue_summary.overdue_count > 0 THEN overdue_summary.oldest_overdue_created
      ELSE null
    END as oldest_revision
  FROM all_pending, overdue_summary;
