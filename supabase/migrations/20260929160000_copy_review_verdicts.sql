-- Status: APPLIED (verified live 2026-09-29, both production hjpvnvjryxdjcfdsfhzy and test
--         tidqheqjzvwmrrrebzir). Privileges read back for all three roles in BOTH directions:
--         service_role SELECT/INSERT true; anon and authenticated false on SELECT, INSERT,
--         UPDATE and DELETE; RLS enabled with zero policies, which is the intended state for
--         a service-only table.
-- copy_review_verdicts: what an automated reviewer thought of a piece of copy. REPORT ONLY.
--
-- ═══ IT NEVER BLOCKS, AND THE TABLE IS THE WHOLE OF ITS OUTPUT ═══════════════
--
-- Nothing reads this table to decide anything. The reviewer applies the operator's hard-fail
-- rubric to copy that has ALREADY passed every gate and shipped or been stored, and writes
-- down what it found. A verdict here has no effect on what a prospect receives.
--
-- That is deliberate and it is the only way the rubric can be calibrated. An automated
-- reviewer is worth switching on when its agreement with the operator's own reading is known,
-- on BOTH the fails and the passes, and that number cannot exist until it has been run
-- alongside a human reading of the same copy.
--
-- ═══ WHY A SEPARATE TABLE AND NOT A COLUMN ON prospect_research_results ══════
--
-- Because a SIGNED-IN CLIENT CAN READ THAT TABLE. RLS is on there with two SELECT policies
-- for `authenticated`, and clients_read_own_research_results admits any user whose role is
-- 'client' to their own organisation's rows. A reviewer's verdict is an internal judgement
-- about our own output, often a judgement that it is WRONG, and it does not belong on a
-- surface a client can query.
--
-- A column-level REVOKE does not fix that and is worth recording so nobody tries: Postgres
-- table-level SELECT implies every column, including ones added later, so denying one column
-- means revoking table SELECT and re-granting every other column by name, which silently
-- re-exposes each new column somebody adds. A separate service-only table is the correct
-- shape, and it is the shape research_usage and verification_calls already use.
--
-- ═══ ONE ROW PER EMAIL REVIEWED, NOT ONE PER PROSPECT ════════════════════════
--
-- The rubric is about a piece of copy, and the three positions are written by different calls
-- against different rules. There is deliberately NO unique constraint: this is report-only,
-- so the same copy may be reviewed repeatedly as the rubric changes, and comparing two
-- reviews of one email is exactly how a rubric change is measured.
--
-- copy_fingerprint IS WHAT STOPS A VERDICT OUTLIVING ITS COPY. Copy is rewritten constantly
-- on this project; a verdict naming a prospect and not the text it judged would silently
-- become a verdict about something else. The fingerprint is of the composed body, so a
-- verdict can always be matched back to the exact words that produced it.

CREATE TABLE IF NOT EXISTS public.copy_review_verdicts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  prospect_id         uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,

  -- The run the copy was written from, when it is known. NULLABLE and SET NULL rather than
  -- CASCADE: a verdict is about the COPY, and it stays meaningful when the research row that
  -- produced it is superseded or deleted. research_usage cascades because usage without its
  -- run is meaningless; a review without its run is still a review.
  research_result_id  uuid REFERENCES public.prospect_research_results(id) ON DELETE SET NULL,

  -- 1, 2 or 3. Email 4 is always the approved template and is never reviewed.
  email_position      int NOT NULL CHECK (email_position IN (1, 2, 3)),

  -- sha256 of the composed body this verdict judged. See the header.
  copy_fingerprint    text NOT NULL,

  -- ── The rubric ──────────────────────────────────────────────────────────────
  -- jsonb rather than a column per category, because the rubric is the operator's and is
  -- still moving. A category added to the code must not need a migration, and a verdict
  -- written under an older rubric must stay readable rather than gaining empty columns.
  --
  -- Shape: { "<category>": { "failed": bool, "quote": string|null, "why": string } }
  hard_fails          jsonb NOT NULL,

  -- SCORED SEPARATELY AND NEVER A FAIL, on the operator's instruction. "The bridge does not
  -- follow from the fact" is a judgement about how well an argument lands, not about whether
  -- a statement is true, and mixing it into the hard-fail count would make the count mean two
  -- different things at once.
  soft_notes          jsonb,

  -- True when any category in hard_fails failed. DERIVED AND STORED, so the common query does
  -- not have to know the rubric's shape, and a rubric change cannot silently alter what past
  -- rows meant.
  any_hard_fail       boolean NOT NULL,

  model               text NOT NULL,
  usage               jsonb NOT NULL,
  -- The reply as returned, so a verdict can be read rather than inferred.
  raw                 text,
  reviewed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copy_review_verdicts_prospect_idx
  ON public.copy_review_verdicts (prospect_id, email_position, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS copy_review_verdicts_org_idx
  ON public.copy_review_verdicts (organisation_id, reviewed_at DESC);

COMMENT ON TABLE public.copy_review_verdicts IS
  'Automated reviewer verdicts on copy that has already shipped or been stored. Report only: '
  'nothing reads this to decide anything. Service-role only, because a verdict is an internal '
  'judgement about our own output and prospect_research_results is client-readable.';

-- ── Privileges ───────────────────────────────────────────────────────────────
-- Service-role only. RLS is enabled because it is what actually denies rows today, AND the
-- grants are revoked BY NAME, because Supabase's ALTER DEFAULT PRIVILEGES grants anon and
-- authenticated explicitly and REVOKE ... FROM PUBLIC alone is a silent no-op against those.
-- See CLAUDE.md, "Rule: THE SAME TRAP APPLIES TO TABLES. RLS is one layer, not the only one."
ALTER TABLE public.copy_review_verdicts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.copy_review_verdicts FROM PUBLIC;
REVOKE ALL ON TABLE public.copy_review_verdicts FROM anon, authenticated;
GRANT ALL ON TABLE public.copy_review_verdicts TO service_role;
