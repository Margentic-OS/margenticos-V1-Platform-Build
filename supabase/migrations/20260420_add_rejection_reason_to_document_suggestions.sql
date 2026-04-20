-- Session 5, Part 2 — Task: reject with reason + regenerate
-- Stores the operator's stated reason for rejecting a suggestion.
-- Nullable — rejection without a reason is permitted.

ALTER TABLE document_suggestions
  ADD COLUMN IF NOT EXISTS rejection_reason text DEFAULT NULL;
