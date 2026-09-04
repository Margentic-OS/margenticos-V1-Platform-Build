-- Suppression that reaches the sending provider: the record of whether it did.
--
-- Status: PENDING
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- Marking a prospect suppressed changed nothing about what the provider had already
-- queued. Measured live on 2026-09-04, before any of this was built:
--
--   prospect ecc5f9d2-3b8e-4ad4-a70b-0f829409149f
--     our database:  suppressed = true, client_review_status = 'rejected'
--     the provider:  status 1 (Active), no interest status, step 3 executed 2026-08-31,
--                    step 4 still queued behind a seven-day delay
--
-- Uploaded 2026-08-21. Nothing in this codebase ever told the provider, and nothing
-- would have said so. That second half is the worse half.
--
-- Three of four suppression write sites made no provider call at all. The fourth, the
-- opt-out reply path, did, and its two prospects are correctly stopped. So the fault was
-- never "suppression cannot reach the provider": it was that only one path did it, and
-- no instrument compared the two sides.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A COLUMN AND NOT JUST AN ACTION ROW
--
-- The reply path already writes a reply_actions row carrying action_succeeded, and that
-- row is a good audit record. It is not an answer to the question this build has to be
-- able to answer: "does this prospect's row claim suppressed while the provider was
-- never told?"
--
-- Answering that from action rows means a join, per prospect, that only exists for one of
-- the four write sites. Answering it from the prospect row is one predicate, over every
-- write site, and it is what the reconciliation sweep reads. A record that claims
-- suppressed with no statement about the provider is precisely the silent state this is
-- built to remove.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE THREE VALUES, AND WHY THERE IS NO 'pending'
--
--   not_required  no lead exists at the provider for this prospect, so there is nothing
--                 to stop. The normal state for a prospect that was never uploaded.
--   confirmed     the provider was called AND THE LEAD WAS READ BACK showing our write
--                 landed. A 200 alone does not earn this value.
--   failed        the call failed, or the read-back disagreed, or no provider lead could
--                 be resolved for the address at all.
--
-- 'pending' is deliberately absent. Every write here happens synchronously, at the moment
-- of suppression, and a status that means "we have not finished" would be indistinguishable
-- from a crash halfway through. NULL already carries "never attempted", which is the only
-- other state that exists.
--
-- NULL on a suppressed row is itself a finding, not a gap: it means a suppression was
-- written by something that does not go through the shared path. Every one of the two
-- rejected rows measured above reads NULL, because they were suppressed by a hand-written
-- UPDATE. The reconciliation sweep does not trust these columns to find that case; it
-- reads the provider directly. These columns say what WE did, and the sweep says what IS.

ALTER TABLE public.prospects
  -- Named for the existing outbound_* family (outbound_lead_id, outbound_upload_status),
  -- which is this codebase's tool-agnostic prefix for anything the sending provider owns.
  ADD COLUMN IF NOT EXISTS outbound_suppression_status text,
  ADD COLUMN IF NOT EXISTS outbound_suppression_at     timestamptz,
  ADD COLUMN IF NOT EXISTS outbound_suppression_error  text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospects_outbound_suppression_status_valid'
  ) THEN
    ALTER TABLE public.prospects
      ADD CONSTRAINT prospects_outbound_suppression_status_valid
      CHECK (outbound_suppression_status IS NULL
             OR outbound_suppression_status IN ('not_required', 'confirmed', 'failed'));
  END IF;
END $$;

-- An error string only makes sense against a failure. Without this a 'confirmed' row could
-- carry an error message and read as both at once, which is the shape that made
-- suppressed_emails require revoked_at and revoked_reason to travel together.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospects_outbound_suppression_error_complete'
  ) THEN
    ALTER TABLE public.prospects
      ADD CONSTRAINT prospects_outbound_suppression_error_complete
      CHECK (outbound_suppression_error IS NULL
             OR outbound_suppression_status = 'failed');
  END IF;
END $$;

COMMENT ON COLUMN public.prospects.outbound_suppression_status IS
  'Whether the sending provider was actually told to stop, for a prospect this system has '
  'suppressed. not_required = no provider lead exists. confirmed = called and READ BACK. '
  'failed = the call failed, the read-back disagreed, or no lead could be resolved. NULL = '
  'never attempted, which on a suppressed row means something bypassed the shared path.';

COMMENT ON COLUMN public.prospects.outbound_suppression_at IS
  'When outbound_suppression_status was last written. Not the suppression time: '
  'suppressed_at is that. These two differing is the interval during which our record and '
  'the provider disagreed.';

COMMENT ON COLUMN public.prospects.outbound_suppression_error IS
  'Why the provider was not told, when status is failed. Constrained to failed rows only.';

-- Finding a suppressed prospect whose provider call did not land is the reconciliation
-- sweep's first query and the only one that runs over the whole table. Partial, because
-- the interesting rows are a small minority and always will be.
CREATE INDEX IF NOT EXISTS prospects_outbound_suppression_unfinished_idx
  ON public.prospects (organisation_id)
  WHERE suppressed = true
    AND (outbound_suppression_status IS NULL OR outbound_suppression_status = 'failed');

-- ═════════════════════════════════════════════════════════════════════════════
-- THE CAPABILITY
--
-- ADR-001: agents and application code reference capabilities, never tool names. The
-- opt-out reply path calls the provider handler directly, which its own comment flags as a
-- deferred ADR-001 violation. This build adds two more callers, and wiring them the same
-- way would triple a recorded violation rather than repay it.
--
-- So the capability comes first and all three paths go through it. Swapping the sending
-- provider is then a registry UPDATE plus a handler, with no change to any suppression
-- path, which is the whole point of the pattern.
--
-- is_active = true because the capability is real and implemented. Whether any call
-- actually leaves this machine is governed by instantly_api_active, which is a separate
-- row and a separate question, exactly as it is for can_upload_leads.
INSERT INTO public.integrations_registry (capability, tool_name, is_active, connection_status)
VALUES ('can_suppress_contact', 'instantly', true, 'connected')
ON CONFLICT (capability, tool_name) DO UPDATE SET
  is_active         = EXCLUDED.is_active,
  connection_status = EXCLUDED.connection_status;

-- Read back after applying:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'prospects' AND column_name LIKE 'outbound_suppression%';
--   SELECT * FROM public.integrations_registry WHERE capability = 'can_suppress_contact';
