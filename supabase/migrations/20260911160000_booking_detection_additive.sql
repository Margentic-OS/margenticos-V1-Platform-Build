-- Status: APPLIED (verified live 2026-09-11) to production hjpvnvjryxdjcfdsfhzy AND the test
--   database tidqheqjzvwmrrrebzir. Read back on both: all six columns present; all five
--   constraints present, source CHECK now ('calendly','manual','webhook'); booking_url copied
--   for the two organisations that had calendly_url and NULL for the other three;
--   unattributed_bookings RLS on, service_role SELECT/INSERT/UPDATE/DELETE true, anon and
--   authenticated false for all four; can_book_meeting/cal_com row present and active.
--
-- DO NOT APPLY THIS FILE TO PRODUCTION AGAIN; the ADD CONSTRAINT statements are not idempotent.
--
-- Booking detection moves from Calendly to Cal.com: the ADDITIVE half. See ADR-054.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS HALF A MIGRATION
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A migration reaches production the moment it is applied. The code that reads it reaches
-- production only at merge. main still reads organisations.calendly_url today, so renaming
-- that column now would break the automated booking reply and the operator Settings page on
-- main for as long as this branch waits.
--
-- So this file only ADDS. Every Calendly column stays until the second half, which is
-- destructive, runs only after merge, and only on Doug's explicit yes. Its SQL is recorded in
-- ADR-054 and on the Notion Backlog, deliberately NOT as an unapplied file in this folder,
-- where anything replaying the folder onto a fresh database would run it.
--
-- The one statement here that is not an ADD is the meetings source CHECK, dropped and
-- re-created WIDER in a single ALTER. Every value it accepted before it still accepts, so no
-- existing row can fail it.

-- ── 1. organisations.booking_url ─────────────────────────────────────────────
--
-- The vendor-neutral successor to calendly_url, copied across once, here. An edit made on
-- main's Settings page between this running and the merge writes calendly_url, not this
-- column. The destructive half re-copies any booking_url still NULL for exactly that reason.

ALTER TABLE public.organisations ADD COLUMN IF NOT EXISTS booking_url text;

UPDATE public.organisations
   SET booking_url = calendly_url
 WHERE booking_url IS NULL
   AND calendly_url IS NOT NULL;

COMMENT ON COLUMN public.organisations.booking_url IS
  'The booking link sent to prospects in reply emails. Tool-agnostic: any booking tool''s '
  'link works for SENDING. Only booking DETECTION depends on which tool it is.';

-- ── 2. organisations.booking_host_ref ────────────────────────────────────────
--
-- Which booking-tool seat belongs to this organisation. Every client sits in one booking-tool
-- organisation of ours, and the notification names the seat that hosted the meeting, so this
-- is how a booking finds its client without testing a secret per client. It holds the
-- hosting seat's email address as the booking tool reports it.
--
-- Stored lowercased and trimmed so a lookup is an exact match, and unique so one seat can
-- never resolve to two clients. NULL means this organisation has no seat, and a booking
-- hosted by an unknown seat is quarantined in unattributed_bookings, never guessed.

ALTER TABLE public.organisations ADD COLUMN IF NOT EXISTS booking_host_ref text;

ALTER TABLE public.organisations
  ADD CONSTRAINT organisations_booking_host_ref_normalised
  CHECK (booking_host_ref IS NULL OR booking_host_ref = lower(btrim(booking_host_ref)));

ALTER TABLE public.organisations
  ADD CONSTRAINT organisations_booking_host_ref_key UNIQUE (booking_host_ref);

-- ── 3. meetings ──────────────────────────────────────────────────────────────
--
-- booking_uid     the booking tool's identifier for the booking. UNIQUE, which is what makes
--                 a second delivery of the same notification unable to create a second meeting.
-- prospect_match  how the booking was tied to a prospect: 'link' (our reference carried on the
--                 booking link came back), 'email' (fallback, case-insensitive), or 'none'. A
--                 'none' row is still recorded, and is excluded from auto-held billing in code.
-- attendee_email  who booked. Without these an unmatched meeting records nobody an operator
-- attendee_name   could contact, which would make "recorded" mean nothing.

ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS booking_uid text;
ALTER TABLE public.meetings ADD CONSTRAINT meetings_booking_uid_key UNIQUE (booking_uid);

ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS prospect_match text;
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_prospect_match_check
  CHECK (prospect_match IS NULL OR prospect_match IN ('link', 'email', 'none'));

ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS attendee_email text;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS attendee_name text;

-- Widened, never narrowed here. 'webhook' says HOW the row arrived, not which vendor sent it;
-- the registry says which tool serves can_book_meeting. 'calendly' leaves in the second half.
ALTER TABLE public.meetings
  DROP CONSTRAINT meetings_source_check,
  ADD CONSTRAINT meetings_source_check CHECK (source IN ('calendly', 'manual', 'webhook'));

-- ── 4. unattributed_bookings ─────────────────────────────────────────────────
--
-- A booking whose hosting seat maps to no organisation. meetings.organisation_id is NOT NULL,
-- so such a booking cannot be a meeting, and the brief is that a booking is never discarded.
-- Same shape as unattributed_replies. The operator is emailed on every new row.
--
-- provider has NO DEFAULT on purpose: a vendor name in a column default is the hardest kind
-- to remove later (CLAUDE.md, the verification_provider incident). The handler writes it.
--
-- RETENTION. This holds a booker's name and email with no client attached. The full payload
-- is deliberately NOT stored, only what an operator needs to act. No sweep is built in this
-- branch; the retention decision is recorded on the Notion Backlog.

CREATE TABLE IF NOT EXISTS public.unattributed_bookings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL,
  provider_booking_uid  text NOT NULL,
  host_ref              text,
  attendee_email        text,
  attendee_name         text,
  scheduled_start_at    timestamptz,
  cancelled_at          timestamptz,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolved_meeting_id   uuid REFERENCES public.meetings(id) ON DELETE SET NULL
);

-- The idempotency key: a repeated delivery is a no-op, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS unattributed_bookings_provider_uid_key
  ON public.unattributed_bookings (provider, provider_booking_uid);

-- Privileges. RLS is one layer, the grant underneath is the other. Supabase grants new tables
-- to anon and authenticated BY NAME, so REVOKE FROM PUBLIC alone is a silent no-op.
ALTER TABLE public.unattributed_bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.unattributed_bookings FROM PUBLIC;
REVOKE ALL ON TABLE public.unattributed_bookings FROM anon, authenticated;
GRANT ALL ON TABLE public.unattributed_bookings TO service_role;

-- ── 5. The registry row ──────────────────────────────────────────────────────
--
-- Added beside the Calendly row, which is removed in the second half. Nothing reads
-- can_book_meeting through the registry today, so two active rows for it are harmless.

INSERT INTO public.integrations_registry
  (capability, tool_name, is_active, api_handler_ref, config, connection_status)
VALUES
  ('can_book_meeting', 'cal_com', true, 'src/lib/integrations/handlers/cal-com', '{}'::jsonb, 'disconnected')
ON CONFLICT (capability, tool_name) DO NOTHING;
