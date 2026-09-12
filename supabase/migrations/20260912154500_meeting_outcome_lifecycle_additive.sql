-- Status: APPLIED (verified live 2026-09-12)
--   Both projects read back all SEVEN new columns and all THREE new CHECK constraints, and
--   held_confirmed_by now admits 'host' on both.
--   production hjpvnvjryxdjcfdsfhzy: columns and constraint definitions read back by name.
--   test tidqheqjzvwmrrrebzir: 7 columns, 3 checks, widened constraint read back.
--   The constraints were then proved to BITE rather than merely exist, on the test project,
--   with a probe that cannot commit: see the PROBE VERDICT lines quoted in the commit.
--
-- The meeting outcome lifecycle. Additive only. See ADR-057.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
--
-- Held versus no-show is a human judgement, permanently. Cal.com's automatic "didn't join"
-- events fire only for Cal Video, and our clients use their own Google Meet, Teams or Zoom,
-- so no attendance signal will ever arrive for them. The primary path is therefore CLIENT
-- CONFIRMATION: after a meeting's scheduled end the client is asked, in one click, whether
-- it happened.
--
-- If they never answer, the decision of 2026-08-24 applies: a meeting occurring in month M
-- rolls unconfirmed onto the M+1 invoice, and if it is STILL unconfirmed at the end of M+1
-- it bills automatically. That is a commercial term the client agrees to. It is not the same
-- thing as the 72-hour auto-held job, which was built separately, was never part of that
-- decision, and is paused and declared off (20260911210000).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE TWO CHECK CONSTRAINTS ARE THE POINT OF THIS MIGRATION
--
-- Both express a rule that has until now lived only in application code, where a later edit
-- could drop it silently. In the database they cannot be dropped by accident: a write that
-- breaks them fails loudly, whichever code path makes it.
--
--   meetings_billable_records_its_basis   a billable meeting must say HOW it became
--                                         billable. No row can be billable anonymously.
--   meetings_billable_needs_a_prospect    a booking we could not tie to a prospect can
--                                         never be billed. This was a filter in
--                                         auto-held-resolution.ts, repeated on the read and
--                                         the update; it is now a property of the table.
--
-- SAFE TO ADD AS VALID, MEASURED 2026-09-12: production holds 0 meetings and 0 billable
-- rows; the test project holds 83 meetings, 0 billable, 0 with a held decision. So no
-- existing row can violate either constraint and no backfill is needed. Read back after
-- applying rather than assuming this stayed true.
--
-- 'host' joins held_confirmed_by because Cal.com lets the HOST mark an attendee as a no-show
-- on the past-bookings screen, and that is a person's judgement arriving through the webhook
-- rather than through our own confirm link. It can only ever record a no-show, never a held
-- meeting, so it never makes anything billable.

-- ── Lifecycle timestamps ────────────────────────────────────────────────────

ALTER TABLE public.meetings
  -- The scheduled END, as the booking tool reported it. Until now only the start was kept,
  -- so "has this meeting finished?" could not be answered for a meeting of unknown length.
  ADD COLUMN IF NOT EXISTS scheduled_end_at timestamptz,
  -- When we first asked the client for an outcome, and when the ask last went out.
  ADD COLUMN IF NOT EXISTS outcome_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0,
  -- The calendar deadline: the last instant of the month AFTER the meeting's month, UTC.
  -- Stored rather than recomputed so the operator list, the reminders and the backstop all
  -- read ONE value, and so a deadline cannot move because a different function computed it.
  ADD COLUMN IF NOT EXISTS bill_unconfirmed_after timestamptz,
  -- How this meeting became billable. NULL until it is.
  ADD COLUMN IF NOT EXISTS billable_basis text;

COMMENT ON COLUMN public.meetings.bill_unconfirmed_after IS
  'The last instant of the month after the meeting month, UTC. If still unconfirmed after this, the meeting bills unconfirmed (2026-08-24 decision). A calendar date, never a fixed number of days from the meeting.';

COMMENT ON COLUMN public.meetings.billable_basis IS
  'How the meeting became billable: client_confirmed, operator_marked, or unconfirmed_backstop. Required whenever is_billable is true, and shown on every billing view.';

-- ── A billable meeting must say how, and must have a prospect ───────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_billable_basis_check') THEN
    ALTER TABLE public.meetings ADD CONSTRAINT meetings_billable_basis_check
      CHECK (billable_basis IS NULL OR billable_basis IN ('client_confirmed', 'operator_marked', 'unconfirmed_backstop'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_billable_records_its_basis') THEN
    ALTER TABLE public.meetings ADD CONSTRAINT meetings_billable_records_its_basis
      CHECK (NOT is_billable OR billable_basis IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_billable_needs_a_prospect') THEN
    ALTER TABLE public.meetings ADD CONSTRAINT meetings_billable_needs_a_prospect
      CHECK (NOT is_billable OR prospect_id IS NOT NULL);
  END IF;
END $$;

-- ── The host may record a no-show through the booking tool ──────────────────

ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_held_confirmed_by_check;
ALTER TABLE public.meetings ADD CONSTRAINT meetings_held_confirmed_by_check
  CHECK (held_confirmed_by IS NULL OR held_confirmed_by IN ('client', 'operator', 'auto', 'host'));

-- 'auto' is kept deliberately. It is the value the retired 72-hour job wrote, and production
-- holds no such row today, but removing it from the constraint would make the history
-- unwritable rather than making it untrue. Nothing new writes it: the backstop records
-- billable_basis 'unconfirmed_backstop' and leaves held_confirmed_by alone, because billing
-- an unconfirmed meeting is not a claim that anybody attended it.

-- ── Indexes for the daily sweep and the operator screen ────────────────────

-- The sweep asks: which undecided meetings have finished, or are near their deadline?
CREATE INDEX IF NOT EXISTS meetings_awaiting_outcome_idx
  ON public.meetings (scheduled_end_at)
  WHERE meeting_status = 'booked' AND held_decision_locked = false;

CREATE INDEX IF NOT EXISTS meetings_billing_deadline_idx
  ON public.meetings (bill_unconfirmed_after)
  WHERE meeting_status = 'booked' AND held_decision_locked = false;

-- The billing view asks: what is billable for this client, and on what basis?
CREATE INDEX IF NOT EXISTS meetings_billable_by_org_idx
  ON public.meetings (organisation_id, billable_basis)
  WHERE is_billable = true;
