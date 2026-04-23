-- intake_files: stores uploaded writing samples, ICP docs, and other source material.
-- Text is extracted at upload time and stored in extracted_text.
-- Agents read extracted_text only — they never download the binary from storage.
-- Path convention in the bucket: {organisation_id}/{uuid}_{sanitised_filename}

CREATE TABLE intake_files (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  storage_path       text        NOT NULL,
  original_filename  text        NOT NULL,
  file_size_bytes    integer     NOT NULL,
  mime_type          text        NOT NULL,
  file_purpose       text        NOT NULL CHECK (file_purpose IN ('voice_sample', 'icp_doc', 'case_study', 'other')),
  extracted_text     text,
  extraction_status  text        NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'complete', 'failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        REFERENCES users(id)
);

ALTER TABLE intake_files ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read, insert, and delete files for their own organisation.
-- Service role bypasses RLS — agents use service role to read extracted_text.

CREATE POLICY "users_select_own_org_files"
  ON intake_files FOR SELECT
  TO authenticated
  USING (
    organisation_id = (
      SELECT organisation_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "users_insert_own_org_files"
  ON intake_files FOR INSERT
  TO authenticated
  WITH CHECK (
    organisation_id = (
      SELECT organisation_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "users_delete_own_org_files"
  ON intake_files FOR DELETE
  TO authenticated
  USING (
    organisation_id = (
      SELECT organisation_id FROM users WHERE id = auth.uid()
    )
  );

-- ── Supabase Storage bucket ────────────────────────────────────────────────────
-- Private bucket (public=false). No public URLs.
-- file_size_limit: 10MB in bytes.
-- allowed_mime_types enforced here and in the upload route handler.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'intake-files',
  'intake-files',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── Storage object policies ─────────────────────────────────────────────────────
-- Path format: {organisation_id}/{uuid}_{filename}
-- (storage.foldername(name))[1] extracts the first path segment (the org UUID).
-- Compared as text to avoid cast errors if path is malformed.

CREATE POLICY "users_select_own_org_storage_files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'intake-files'
    AND (storage.foldername(name))[1] = (
      SELECT organisation_id::text FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "users_insert_own_org_storage_files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'intake-files'
    AND (storage.foldername(name))[1] = (
      SELECT organisation_id::text FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "users_delete_own_org_storage_files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'intake-files'
    AND (storage.foldername(name))[1] = (
      SELECT organisation_id::text FROM users WHERE id = auth.uid()
    )
  );
