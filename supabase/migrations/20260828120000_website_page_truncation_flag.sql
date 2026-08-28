-- Makes website-page truncation visible on the row.
--
-- WHY. src/lib/intake/fetch-website.ts cuts every fetched page at MAX_CHARS_PER_PAGE
-- (3,000 characters) before storing it. Nothing recorded that it had happened, so a
-- reader of intake_website_pages could not tell a page that is genuinely short from one
-- that was cut mid-word. Measured 2026-08-28: three of the seven stored pages sit at
-- exactly 3,000 characters and end mid-word, and one of them cuts off in the middle of
-- the sentence describing the client's own sustainability model.
--
-- The cap is NOT raised here and nothing is re-fetched. This migration only makes the
-- existing behaviour observable. See ADR-043 and BACKLOG.
--
-- THE BACKFILL, and what it does and does not know.
-- Truncation is applied AFTER the extracted text is trimmed, so a stored page is exactly
-- 3,000 characters if and only if the raw extraction was longer than 3,000. A page whose
-- real length is exactly 3,000 would be marked truncated when it was not. That is
-- possible and vanishingly unlikely, and it errs towards over-reporting, which is the
-- safe direction for a flag whose whole purpose is to stop a cut page reading as a
-- complete one. Rows fetched from now on get the flag computed at fetch time rather than
-- inferred from length.

ALTER TABLE public.intake_website_pages
  ADD COLUMN IF NOT EXISTS extraction_truncated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.intake_website_pages.extraction_truncated IS
  'True when the raw page extraction exceeded MAX_CHARS_PER_PAGE in fetch-website.ts and '
  'was cut before storage. Set at fetch time. Rows predating this column were backfilled '
  'by length, since truncation is applied after trim and therefore lands on exactly the cap.';

UPDATE public.intake_website_pages
   SET extraction_truncated = true
 WHERE fetch_status = 'complete'
   AND extracted_text IS NOT NULL
   AND length(extracted_text) = 3000
   AND extraction_truncated = false;

-- Status: PENDING (apply via Supabase MCP apply_migration, then verify and mark APPLIED)
