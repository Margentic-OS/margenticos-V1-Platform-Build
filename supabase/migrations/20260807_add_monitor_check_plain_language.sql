-- Add plain_meaning, plain_impact, plain_action columns to monitor_checks
-- These columns hold plain-language explanations for operators (non-technical readers).

ALTER TABLE public.monitor_checks ADD COLUMN plain_meaning text NOT NULL DEFAULT '';
ALTER TABLE public.monitor_checks ADD COLUMN plain_impact text NOT NULL DEFAULT '';
ALTER TABLE public.monitor_checks ADD COLUMN plain_action text NOT NULL DEFAULT '';

-- Backfill all existing checks with plain language
UPDATE public.monitor_checks SET
  plain_meaning = 'A system process that automatically promotes document suggestions to active strategy documents has not run in over an hour.',
  plain_impact = 'Approved documents may not be deployed to campaigns on schedule.',
  plain_action = 'Check Vercel logs for the auto-approve cron job. If down, redeploy the application.'
WHERE code = 'MON-001';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system stopped asking for new replies and reply statuses from the email platform.',
  plain_impact = 'Campaign performance data is stale. New replies may not be detected. Automatic response actions are delayed.',
  plain_action = 'Check Supabase pg_cron logs for the instantly-poll job. Verify Instantly API credentials are valid.'
WHERE code = 'MON-002';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system stopped processing incoming replies to route them to handlers.',
  plain_impact = 'Positive replies are not automatically answered. Unsubscribes are not recorded. Escalations build up.',
  plain_action = 'Check Vercel logs for the process-replies cron. Verify Instantly API key is set in environment.'
WHERE code = 'MON-003';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system stopped cleaning up agent processes that crashed or took too long.',
  plain_impact = 'Zombie background jobs accumulate, blocking new document generation requests.',
  plain_action = 'Check Supabase pg_cron logs for the reap-agent-runs job. Verify the cron service is healthy.'
WHERE code = 'MON-004';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system stopped monitoring itself for failures.',
  plain_impact = 'Other failure conditions go undetected. Alert responses are delayed.',
  plain_action = 'Check Vercel logs. Redeploy the application if the monitor-sweep route is broken.'
WHERE code = 'MON-005';

UPDATE public.monitor_checks SET
  plain_meaning = 'A client has revised a strategy document and is waiting for approval to go live.',
  plain_impact = 'Updated campaigns are held pending operator review. Client changes take longer than expected.',
  plain_action = 'Visit /dashboard/operator/monitor. Approve or reject the pending revision in the client strategy page.'
WHERE code = 'MON-006';

UPDATE public.monitor_checks SET
  plain_meaning = 'Strategy documents could be auto-promoted on schedule, but this feature is not yet built.',
  plain_impact = 'Not applicable — this check is scheduled for a future phase.',
  plain_action = 'No action needed yet. Remind the team to schedule this when ready.'
WHERE code = 'MON-007-UNSCHEDULED';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system could nudge clients to complete unfinished intake questionnaires, but this feature is not yet built.',
  plain_impact = 'Not applicable — this check is scheduled for a future phase.',
  plain_action = 'No action needed yet. Remind the team to schedule this when ready.'
WHERE code = 'MON-008-UNSCHEDULED';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system could automatically trigger campaign warmup at 50% completion, but this feature is not yet built.',
  plain_impact = 'Not applicable — this check is scheduled for a future phase.',
  plain_action = 'No action needed yet. Remind the team to schedule this when ready.'
WHERE code = 'MON-009-UNSCHEDULED';

UPDATE public.monitor_checks SET
  plain_meaning = 'The system could auto-resolve escalations after they have been on hold too long, but this feature is not yet built.',
  plain_impact = 'Not applicable — this check is scheduled for a future phase.',
  plain_action = 'No action needed yet. Remind the team to schedule this when ready.'
WHERE code = 'MON-010-UNSCHEDULED';

UPDATE public.monitor_checks SET
  plain_meaning = 'A background document generation job crashed and was marked failed. It remains unresolved and is less than 7 days old.',
  plain_impact = 'A strategy document generation failed. The client may be blocked from a campaign launch.',
  plain_action = 'Visit the client dashboard. Check the document page for error details. Trigger a new generation or tell Claude the code.'
WHERE code = 'MON-011';

UPDATE public.monitor_checks SET
  plain_meaning = 'A background document generation job is still marked as running but started more than 15 minutes ago (likely crashed).',
  plain_impact = 'A zombie process may be holding resources. New document generation requests may be blocked.',
  plain_action = 'Check Vercel function logs for the agent name. If the process is truly hung, the reaper should clean it up within the next cron run. If not, tell Claude the code.'
WHERE code = 'MON-012';

UPDATE public.monitor_checks SET
  plain_meaning = 'A campaign is marked active but has no ID from the email platform. The sync with Instantly did not complete.',
  plain_impact = 'Campaign tracking is incomplete. Replies and opens may not sync back. Email sends may fail.',
  plain_action = 'Visit the campaign details. Check if the Instantly account is connected. If connected, retry the sync. If not, tell Claude the code.'
WHERE code = 'MON-013';

UPDATE public.monitor_checks SET
  plain_meaning = 'A reply or event from the email platform has been logged but not yet processed. It is older than 48 hours.',
  plain_impact = 'Some replies are delayed in routing. Automatic responses are held up. Reply metrics may be incomplete.',
  plain_action = 'Check the Supabase signals table for the oldest unprocessed row. Inspect it for corruption. Manually mark it processed or tell Claude the code.'
WHERE code = 'MON-014';

UPDATE public.monitor_checks SET
  plain_meaning = 'A reply was marked as permanently undeliverable (bounce, invalid, opt-out). This occurred in the last 7 days.',
  plain_impact = 'A prospect took an action that requires followup (e.g., unsubscribed). If not suppressed, resends will waste credits.',
  plain_action = 'Visit the reply handling logs. Verify the prospect is suppressed in Instantly. If not, suppress manually or tell Claude the code.'
WHERE code = 'MON-015';

-- Verify all rows now have plain language filled in
UPDATE public.monitor_checks SET
  plain_meaning = 'Undefined check',
  plain_impact = 'Unknown impact',
  plain_action = 'Tell Claude the code'
WHERE plain_meaning = '' OR plain_impact = '' OR plain_action = '';
