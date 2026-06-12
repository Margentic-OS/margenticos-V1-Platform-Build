-- Notifications log table for document lifecycle event deduplication.
-- Prevents duplicate sends of the same notification type for the same subject
-- within the same organisation.

-- Notification types:
--   docs_ready: all four strategy documents are ready for client review
--   version_pending: a document has been updated and needs client review
--   revision_processed: a client-requested revision has been approved and is live
--   approval_reminder: operator reminder that a pending suggestion auto-approves soon

CREATE TABLE notifications_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT now(),

  -- Unique constraint prevents duplicate sends of the same notification type
  -- for the same subject within the same organisation.
  CONSTRAINT unique_notification_per_subject UNIQUE (organisation_id, notification_type, subject_id)
);

-- RLS: service_role writes only (cron + internal flows)
ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_insert_only ON notifications_log
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY block_all_other_access ON notifications_log
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
