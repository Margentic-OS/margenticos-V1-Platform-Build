-- Status: APPLIED (verified live 2026-09-20 on BOTH projects: production hjpvnvjryxdjcfdsfhzy
-- and test tidqheqjzvwmrrrebzir). Privileges read back in both directions on each: anon holds
-- none of SELECT/INSERT/UPDATE/DELETE, authenticated holds all four, service_role holds all,
-- RLS on, 2 policies.
--
-- Typed storage for the five buyer-targeting intake questions.
--
-- ─── WHY A TABLE AND NOT intake_responses ────────────────────────────────────
--
-- intake_responses is an EAV table whose every value is one nullable `text` column. Four of
-- these five answers are not text: two are integers that a filter is built from, and three
-- are lists the client adds to one entry at a time. Putting any of them in `response_value`
-- means choosing a delimiter and writing a parser, and a parser on the read side is exactly
-- the thing this design exists to remove. A country list joined with commas cannot represent
-- a country whose name contains a comma, and a headcount pair stored as prose has to be read
-- back by guessing at it.
--
-- So: one row per organisation, real Postgres types. A consumer reads two integers and three
-- text[] columns and parses nothing.
--
-- ─── WHY ONE ROW PER ORGANISATION AND NOT COLUMNS ON organisations ───────────
--
-- organisations is the record every RLS helper resolves against and that client-facing views
-- select from. Intake answers are not organisation identity, and widening that table to hold
-- them puts client-editable content behind the same grants as pipeline_unlocked. ADR-039 is
-- the record of what that costs.
--
-- ─── WHY THE THREE SINGLES LIVE HERE TOO ─────────────────────────────────────
--
-- first_contact_role, signoff_required and signoff_role are a single short answer, a boolean
-- and a conditional single short answer. The first and third could have stayed in the EAV
-- table. They are here because they are answers to the same question group, and splitting one
-- group across two stores means every consumer performs two reads in two shapes to answer one
-- question. signoff_required settles it on its own: it is a boolean, and a boolean in a text
-- column is 'yes' | 'true' | 'Yes' | '' and a parser to tell them apart.
--
-- ─── NOTHING READS THIS YET ──────────────────────────────────────────────────
--
-- Session A stores these answers and stops. No agent, prompt, filter specification or document
-- generator reads this table. The columns are deliberately shaped for the readers that arrive
-- in a later session rather than for any reader that exists today.
--
-- RULE ZERO: nothing here names an industry, sector, country, company or job title.

CREATE TABLE IF NOT EXISTS public.intake_buyer_profile (
  -- One row per organisation. The primary key IS the organisation, so a second row cannot be
  -- created and no consumer has to decide which of two rows is current.
  organisation_id uuid PRIMARY KEY
    REFERENCES public.organisations(id) ON DELETE CASCADE,

  -- Q1. Where the client is willing to be sourced in. One entry per country, the client's own
  -- free text, in the order they added them.
  target_countries text[] NOT NULL DEFAULT '{}',

  -- Q2. The buyer's company size, as two integers. NULL means not answered; the CHECK below
  -- forbids answering only half of it, because half a range is not a range.
  buyer_headcount_min integer,
  buyer_headcount_max integer,

  -- Q3. The job titles the buyer holds, free text, one per entry.
  buyer_job_titles text[] NOT NULL DEFAULT '{}',

  -- Q3, second half. Provider seniority bands. Stored as the provider's own tokens because
  -- that is what the client selected from; the application validates membership against
  -- src/lib/sourcing/handlers/provider-seniority.ts, which is the one list of them.
  -- Deliberately NOT a Postgres enum: an enum here would be a second copy of that list,
  -- kept in step by hand, which is the parallel-array defect in another table.
  buyer_seniority_bands text[] NOT NULL DEFAULT '{}',

  -- Q4. Who receives the email, whether they need sign-off, and from whom. signoff_required
  -- is nullable on purpose: NULL is "not answered", which is a different state from "no".
  first_contact_role text NOT NULL DEFAULT '',
  signoff_required boolean,
  signoff_role text NOT NULL DEFAULT '',

  -- Q5. Who the client would turn away despite fitting everything above.
  disqualifiers text[] NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Both halves of the pair, or neither. A min with no max describes no range, and a consumer
  -- reading "two integers" would get one and a NULL.
  CONSTRAINT intake_buyer_profile_headcount_pair_complete CHECK (
    (buyer_headcount_min IS NULL) = (buyer_headcount_max IS NULL)
  ),
  -- A company has at least one person, and the range runs upward. Equal passes: a client whose
  -- buyer is always the same size is answering the question, not making an error.
  CONSTRAINT intake_buyer_profile_headcount_ordered CHECK (
    buyer_headcount_min IS NULL
    OR (buyer_headcount_min >= 1 AND buyer_headcount_max >= buyer_headcount_min)
  )
);

COMMENT ON TABLE public.intake_buyer_profile IS
  'Typed storage for the buyer-targeting intake answers. One row per organisation. '
  'Nothing reads it yet: added in the session that collects the answers, ahead of the '
  'session that wires them to sourcing.';

-- ─── updated_at ──────────────────────────────────────────────────────────────
-- The same trigger function every other table here uses, so the column cannot go stale in a
-- way that differs from its neighbours.

DROP TRIGGER IF EXISTS intake_buyer_profile_set_updated_at ON public.intake_buyer_profile;
CREATE TRIGGER intake_buyer_profile_set_updated_at
  BEFORE UPDATE ON public.intake_buyer_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- Mirrors intake_responses exactly, which is the table holding the other answers to the same
-- questionnaire. Read back live below rather than assumed.

ALTER TABLE public.intake_buyer_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clients_manage_own_buyer_profile ON public.intake_buyer_profile;
CREATE POLICY clients_manage_own_buyer_profile
  ON public.intake_buyer_profile
  FOR ALL TO authenticated
  USING (organisation_id = public.get_my_organisation_id())
  WITH CHECK (organisation_id = public.get_my_organisation_id());

DROP POLICY IF EXISTS operators_full_access_buyer_profile ON public.intake_buyer_profile;
CREATE POLICY operators_full_access_buyer_profile
  ON public.intake_buyer_profile
  FOR ALL TO authenticated
  USING (public.is_operator())
  WITH CHECK (public.is_operator());

-- ─── Grants ──────────────────────────────────────────────────────────────────
--
-- RLS is one layer, not the only one. Supabase runs ALTER DEFAULT PRIVILEGES on the public
-- schema granting anon and authenticated BY NAME, so a new table arrives already readable by
-- anon and REVOKE ... FROM PUBLIC would be a silent no-op against it. Name the roles.
--
-- authenticated keeps the four DML privileges because the client edits this row through the
-- session client, under the policies above. anon gets nothing.

REVOKE ALL ON TABLE public.intake_buyer_profile FROM PUBLIC;
REVOKE ALL ON TABLE public.intake_buyer_profile FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intake_buyer_profile TO authenticated;
GRANT ALL ON TABLE public.intake_buyer_profile TO service_role;
