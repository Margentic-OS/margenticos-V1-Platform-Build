-- Exclude archived organisations from all detection views
-- Archived orgs should not trigger PROBLEM alerts or appear in monitoring

-- MON-006: Client revisions
-- Evaluates each pending client revision against its OWN org's auto_approve_window_hours
-- Problem if oldest revision exceeds its org's window
CREATE OR REPLACE VIEW public.mon_006 AS
  WITH stats AS (
    SELECT
      COUNT(*) as revision_count,
      MIN(ds.created_at) as oldest_created,
      MAX(EXTRACT(EPOCH FROM (now() - ds.created_at)) / 60 / 60) as oldest_age_hours
    FROM public.document_suggestions ds
    JOIN public.organisations o ON ds.organisation_id = o.id
    WHERE ds.status = 'pending'
      AND ds.update_trigger = 'client_revision'
      AND o.archived_at IS NULL
  ),
  oldest_org AS (
    SELECT o.auto_approve_window_hours
    FROM public.document_suggestions ds
    JOIN public.organisations o ON ds.organisation_id = o.id
    WHERE ds.status = 'pending'
      AND ds.update_trigger = 'client_revision'
      AND o.archived_at IS NULL
    ORDER BY ds.created_at ASC
    LIMIT 1
  )
  SELECT
    'MON-006'::text as check_code,
    CASE
      WHEN revision_count = 0 THEN 'OK'
      WHEN oldest_age_hours > COALESCE((SELECT auto_approve_window_hours FROM oldest_org), 72) THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    CASE
      WHEN revision_count = 0 THEN 'No client revisions pending'
      ELSE revision_count::text || ' client revision(s) awaiting review. Oldest: ' ||
           TO_CHAR(oldest_created, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    oldest_created as oldest_revision
  FROM stats;

-- MON-011: Unresolved failed agent runs
CREATE OR REPLACE VIEW public.mon_011 AS
  WITH failed_runs AS (
    SELECT COUNT(*) as count, MAX(ar.completed_at) as newest
    FROM public.agent_runs ar
    JOIN public.organisations o ON ar.organisation_id = o.id
    WHERE ar.status = 'failed'
      AND ar.completed_at >= (now() - interval '7 days')
      AND o.archived_at IS NULL
  )
  SELECT
    'MON-011'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No unresolved failed agent runs'
      ELSE count::text || ' failed agent run(s) in last 7 days. Newest: ' ||
           TO_CHAR(newest, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    newest as oldest_incident
  FROM failed_runs;

-- MON-012: Zombie agent runs
CREATE OR REPLACE VIEW public.mon_012 AS
  WITH zombies AS (
    SELECT COUNT(*) as count, MAX(ar.started_at) as oldest_started
    FROM public.agent_runs ar
    JOIN public.organisations o ON ar.organisation_id = o.id
    WHERE ar.status = 'running'
      AND ar.started_at < (now() - interval '15 minutes')
      AND o.archived_at IS NULL
  )
  SELECT
    'MON-012'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No zombie agent runs detected'
      ELSE count::text || ' zombie run(s) running for >15min. Oldest started: ' ||
           TO_CHAR(oldest_started, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    oldest_started as oldest_zombie
  FROM zombies;

-- MON-013: Orphaned campaigns
CREATE OR REPLACE VIEW public.mon_013 AS
  WITH orphaned AS (
    SELECT COUNT(*) as count
    FROM public.campaigns c
    JOIN public.organisations o ON c.organisation_id = o.id
    WHERE c.status = 'active'
      AND c.external_id IS NULL
      AND o.archived_at IS NULL
  )
  SELECT
    'MON-013'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No orphaned active campaigns'
      ELSE count::text || ' active campaign(s) with no external_id (sync incomplete)'
    END as detail,
    now() as check_time
  FROM orphaned;

-- MON-014: Stale unprocessed signals
CREATE OR REPLACE VIEW public.mon_014 AS
  WITH stale AS (
    SELECT COUNT(*) as count, MIN(s.created_at) as oldest
    FROM public.signals s
    JOIN public.organisations o ON s.organisation_id = o.id
    WHERE s.processed = false
      AND s.created_at < (now() - interval '48 hours')
      AND o.archived_at IS NULL
  )
  SELECT
    'MON-014'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No stale unprocessed signals'
      ELSE count::text || ' signal(s) unprocessed for >48h. Oldest: ' ||
           TO_CHAR(oldest, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    oldest as oldest_signal
  FROM stale;

-- MON-015: Permanently failed replies
CREATE OR REPLACE VIEW public.mon_015 AS
  WITH failed_actions AS (
    SELECT COUNT(*) as count, MAX(rha.created_at) as newest
    FROM public.reply_handling_actions rha
    JOIN public.organisations o ON rha.organisation_id = o.id
    WHERE rha.action_taken = 'permanently_failed'
      AND rha.created_at >= (now() - interval '7 days')
      AND o.archived_at IS NULL
  )
  SELECT
    'MON-015'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No permanently failed reply actions in last 7 days'
      ELSE count::text || ' reply action(s) marked permanently_failed. Newest: ' ||
           TO_CHAR(newest, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    newest as newest_failure
  FROM failed_actions;
