-- Status: APPLIED (verified live 2026-09-14)
--   production hjpvnvjryxdjcfdsfhzy: column present as timestamp with time zone, partial
--     index reply_actions_link_sent_at_idx present, 0 rows carrying a send time, 0 rows with
--     action_taken = 'send_reply' at all, so there was nothing to backfill or guess at.
--   test tidqheqjzvwmrrrebzir: column and index both read back present.
--
-- reply_handling_actions.link_sent_at: when a booking link actually went to a prospect.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY NOT updated_at, WHICH ALREADY HOLDS THIS VALUE TODAY
--
-- The Tier 1 send path writes the action row before dispatch and updates it once after, so
-- updated_at currently equals the moment the link was sent, exactly. It is still the wrong
-- column to measure from, for one reason: NOTHING GUARANTEES IT STAYS THAT WAY. Any future
-- write to that row, a retry, a backfill, an operator annotation, moves updated_at forward
-- and silently shortens the measured interval between the link going out and the booking
-- arriving.
--
-- That error has a direction, and it is the flattering one. Time to booking is the
-- speed-to-lead claim the business rests on, and a proxy that can only ever make it look
-- FASTER is not a proxy worth keeping. This column is written once, at send time, and
-- nothing else touches it.
--
-- NULL means no link was sent. It is written ONLY when the provider accepted the send, so
-- "link_sent_at IS NOT NULL" is the honest population for any funnel measurement, and a
-- failed send is counted from action_succeeded = false instead. The two must never be
-- conflated: a prospect who asked to book and got nothing is the most expensive row on the
-- screen and would otherwise be invisible to a query filtered on a successful send.
--
-- No backfill. Measured 2026-09-14: zero rows carry action_taken = 'send_reply' on either
-- project, so there is no history to reconstruct and nothing to guess at.

ALTER TABLE public.reply_handling_actions
  ADD COLUMN IF NOT EXISTS link_sent_at timestamptz;

COMMENT ON COLUMN public.reply_handling_actions.link_sent_at IS
  'When a booking link was actually sent to the prospect, written once at send time and only on provider success. NULL means no link went out. Do not measure send time from updated_at: any later write to the row moves it and makes time-to-booking look faster than it was.';

-- The funnel reads "every successful link send", so the index is on the populated rows only.
CREATE INDEX IF NOT EXISTS reply_actions_link_sent_at_idx
  ON public.reply_handling_actions (link_sent_at)
  WHERE link_sent_at IS NOT NULL;
