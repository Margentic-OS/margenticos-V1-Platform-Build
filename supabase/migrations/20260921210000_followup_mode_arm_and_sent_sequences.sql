-- Written follow-ups reach the live path: what a prospect was ASSIGNED, what it
-- RECEIVED, and what we actually sent it.
--
-- Status: APPLIED (verified live 2026-09-21)
--
-- Applied via Supabase MCP apply_migration to BOTH projects and read back on each:
--
--   hjpvnvjryxdjcfdsfhzy  (production)
--   tidqheqjzvwmrrrebzir  (margenticos-baseline-restore-test)
--
-- Verified on both, in BOTH DIRECTIONS and across all EIGHT privileges, because checking
-- only the role that must have access proves nothing about who else does:
--
--   anon           SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN  all false
--   authenticated  the same eight                                                    all false
--   service_role   the same eight                                                    all true
--
-- Production also read back: relrowsecurity true, 0 policies (service-only by design),
-- 5 new columns on prospects, 10 columns on sent_sequences.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THERE ARE TWO MODE COLUMNS AND NOT ONE
--
-- followup_arm    what this prospect was ASSIGNED, deterministically. 100% generated
--                 today; the share is a parameter so a comparison is a setting change.
-- followup_mode   what this prospect actually RECEIVED.
--
-- They differ whenever a prospect assigned 'generated' had its follow-ups rejected by
-- their gates, or its Email 1 changed after the follow-ups were written. Counting only
-- the received mode would then move those prospects into the template group, and they are
-- not a random sample of it: they are the ones whose research produced copy that could not
-- clear a gate. The template group would quietly fill with weaker research and look worse
-- for a reason that has nothing to do with the follow-ups.
--
-- So the ASSIGNMENT is the comparison and the OUTCOME is the delivery record. A fair read
-- needs both, and one column cannot carry both.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NULLABLE, NO DEFAULT, NO BACKFILL
--
-- NULL means "composed before this column existed", which is a third honest state. A
-- default of 'template' would assert something about the 137 already-uploaded prospects
-- that nothing measured, and those rows are never re-composed, so the assertion could
-- never be corrected by ordinary operation.

alter table public.prospects
  add column if not exists followup_arm text
    check (followup_arm in ('template', 'generated')),
  add column if not exists followup_mode text
    check (followup_mode in ('template', 'generated')),
  add column if not exists followup_email2 text,
  add column if not exists followup_email3 text,
  add column if not exists followup_email1_fingerprint text;

comment on column public.prospects.followup_arm is
  'The arm this prospect was ASSIGNED, deterministically from its id. The comparison group. Written at composition.';
comment on column public.prospects.followup_mode is
  'What this prospect actually RECEIVED. Differs from followup_arm when generated follow-ups were rejected or went stale. Written at composition.';
comment on column public.prospects.followup_email2 is
  'Generated Email 2 middle prose. NULL means the approved template Email 2 ships.';
comment on column public.prospects.followup_email3 is
  'Generated Email 3 middle prose. NULL means the approved template Email 3 ships.';
comment on column public.prospects.followup_email1_fingerprint is
  'sha256 of the composed Email 1 body these follow-ups were written against. Composition re-computes it and discards the follow-ups on any mismatch, so a callback can never reference an Email 1 the prospect will not receive.';

-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WE ACTUALLY SENT
--
-- Today the composed sequence is built, converted to custom variables, POSTed to the
-- sending tool and never written down. "What did we send this person" is answerable only
-- from the provider, and with generated follow-ups it stops being reconstructible from our
-- own data at all: the messaging document moves (twice on 2026-09-21 alone), and a body
-- rebuilt from a trigger plus a document version needs that version to still exist and
-- composition to be unchanged.
--
-- A TABLE, NOT COLUMNS ON prospects. A prospect can be composed more than once, because a
-- failed upload reclaims it to 'pending' and it is composed again. Columns would overwrite
-- the record of what went out the first time, which is the thing being kept.

create table if not exists public.sent_sequences (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null references public.organisations(id) on delete cascade,
  prospect_id         uuid not null references public.prospects(id) on delete cascade,
  composed_at         timestamptz not null default now(),
  variant_id          text not null,
  messaging_doc_id    uuid not null,
  followup_arm        text not null check (followup_arm in ('template', 'generated')),
  followup_mode       text not null check (followup_mode in ('template', 'generated')),
  -- [{ position, subject, body }], exactly as handed to the sending tool: merge tag
  -- resolved, opt-out footer appended. The whole body rather than a reference, because a
  -- reference is only as good as the document it points at.
  emails              jsonb not null,
  -- The fingerprint that was checked, so a later reader can tell a match from an absent check.
  email1_fingerprint  text not null
);

create index if not exists sent_sequences_prospect_idx
  on public.sent_sequences (prospect_id, composed_at desc);
create index if not exists sent_sequences_org_idx
  on public.sent_sequences (organisation_id, composed_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS IS ONE LAYER. THE GRANT UNDERNEATH IT IS THE OTHER.
--
-- The standard advice for a service-only table is "enable RLS, add no policies", and it is
-- correct as far as it goes: RLS with zero policies genuinely denies every row to anon.
-- What it does not do is remove the GRANT sitting underneath, because Supabase runs ALTER
-- DEFAULT PRIVILEGES on the public schema granting tables to anon and authenticated by
-- name at creation time.
--
-- That is the 2026-08-25 verification_calls incident exactly: RLS was the ONLY thing
-- between an unauthenticated caller and the paid-spend ledger, and a single later migration
-- adding a permissive policy would have opened it with no second layer and nothing to say
-- so. This table holds the full text of every email sent to a named person, so it gets both.

alter table public.sent_sequences enable row level security;

revoke all on table public.sent_sequences from anon, authenticated;
grant all on table public.sent_sequences to service_role;
