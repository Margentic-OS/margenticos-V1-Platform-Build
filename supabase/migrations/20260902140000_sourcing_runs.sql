-- Status: APPLIED (verified live 2026-09-02)
-- Give a sourcing run an identity, so one batch can be seen on its own.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE PROBLEM
--
-- Every count on the pipeline review screen sums every cohort the organisation has ever
-- had. Measured on production 2026-09-02: the Tier 1 card read 93, which is 20 + 1 + 1 + 1
-- from four runs on 2026-08-10 plus 70 from one run on 2026-09-01. Nothing could separate
-- them, because there was no batch identifier on prospects at all.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A NEW TABLE RATHER THAN REUSING agent_runs
--
-- A sourcing run ALREADY writes to agent_runs, twice: one row named 'sourcing_entry' from
-- startAgentRun, and one named 'sourcing_orchestrator' from the orchestrator's own insert.
-- Neither is usable as a batch identity:
--
--   1. Its counts are PROSE. output_summary reads "candidates returned 25, written 25,
--      dropped 0 (suppressed: 0, duplicate_person_key: 0, ...)". A screen cannot group by
--      that without parsing it, and a parser over a log line is a defect waiting to happen.
--   2. agent_runs is read by CLIENTS. Policy clients_read_own_agent_runs grants SELECT to
--      authenticated for their own organisation. Hanging a foreign key off a client-readable
--      table, then adding columns like target versus written, would expose miss rate.
--
-- So: a purpose-built table shaped like enrichment_runs, which is the existing precedent
-- for "a run, with its counts as integers". agent_run_id back-links to the agent_runs row
-- so the two do not become rival histories.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT HERE: COST
--
-- No credit, spend or token columns. Vendor enrichment credits and paid verification calls
-- are recorded per prospect and can be reached through the foreign key below. ANTHROPIC
-- SPEND IS NOT RECORDED ANYWHERE: research makes four model calls per prospect and
-- job_queue.spend_detail records only which sources were attempted, never tokens or cost.
-- A cost column here would be right for new batches and silently understated for every
-- older one, which is the frozen-verdict shape CLAUDE.md warns about. Cost stays off the
-- record until the largest component of it is actually measured.
--
-- Related: BACKLOG "PER-BATCH COUNTERS NEED A COLUMN, A MIGRATION AND A BACKFILL DECISION".

BEGIN;

-- ── The run record ────────────────────────────────────────────────────────────
CREATE TABLE public.sourcing_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES public.organisations(id),

  started_at            timestamptz NOT NULL DEFAULT now(),
  -- NULL means still in flight, or died without a terminal write. The backfill treats a
  -- NULL end time as unusable rather than guessing one.
  completed_at          timestamptz NULL,
  status                text NOT NULL DEFAULT 'running'
    CONSTRAINT sourcing_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed')),

  -- How many were asked for, how many came back, how many were new.
  target_batch_size     integer NOT NULL,
  candidates_returned   integer NOT NULL DEFAULT 0,
  prospects_written     integer NOT NULL DEFAULT 0,

  -- How many were already known, BY REASON, as an object keyed on the dedupe verdict.
  --
  -- JSONB RATHER THAN FOUR INTEGER COLUMNS, AND THIS IS THE PARALLEL-LIST RULE IN CLAUDE.md.
  -- Four columns named after today's four dedupe verdicts would be a second list that has
  -- to be kept in step by hand with the verdict list in orchestrator.ts. Adding a fifth
  -- verdict would produce no error: the new reason would simply have no column and its
  -- count would vanish, and a batch that lost prospects to it would look like a batch that
  -- did not lose them. This column is DERIVED from the verdict counts, so a new verdict
  -- appears here the moment it exists.
  dropped_by_reason     jsonb NOT NULL DEFAULT '{}'::jsonb,

  error_message         text NULL,
  trigger_type          text NOT NULL,

  -- Which ICP version the run filtered against. Specs are frozen at promotion time and
  -- nothing recomputes them, so when a batch comes back wrong the first question is which
  -- spec produced it. NULL when the run failed before reading one.
  icp_document_id       uuid NULL REFERENCES public.strategy_documents(id),

  -- Who clicked. The route already had this and threw it away. NULL for the CLI and for
  -- backfilled rows, where nobody clicked.
  created_by            uuid NULL REFERENCES public.users(id),

  -- The agent_runs row for the same run, so the two histories stay tied together rather
  -- than diverging. NULL when the agent_runs insert failed, which startAgentRun tolerates.
  agent_run_id          uuid NULL REFERENCES public.agent_runs(id),

  -- Set only on rows RECONSTRUCTED from agent_runs by the backfill, never on a live run.
  --
  -- Not in the original proposal, and added deliberately. A backfilled row's counts were
  -- parsed out of a prose log line rather than recorded as they happened, and a row that
  -- cannot be told apart from a directly-recorded one invites exactly the over-trust this
  -- whole change exists to remove. The screen says so where it matters.
  backfilled_at         timestamptz NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Newest run first, per organisation. This is the run list's only query shape.
CREATE INDEX idx_sourcing_runs_org_started
  ON public.sourcing_runs (organisation_id, started_at DESC);

-- ── The link from a prospect to its run ───────────────────────────────────────
--
-- ON DELETE RESTRICT, and each alternative is worse in a specific way:
--
--   CASCADE  deletes real prospects, money already spent, because somebody tidied a run
--            record. Never.
--   SET NULL silently un-batches a whole cohort. The screen would go back to summing
--            everything and nothing would say why. That is the silent-failure shape.
--   RESTRICT means a run record cannot be deleted while prospects point at it. Removing
--            one is then a decision about its prospects, taken deliberately.
--
-- NULL stays permitted: 19 prospects platform-wide genuinely predate run logging or are
-- test fixtures, and they are shown as unattributed rather than hidden.
--
-- NOT the precedent set by prospects.enrichment_run_id, which is a bare uuid with an index
-- and no foreign key at all, so nothing stops it pointing at a run that does not exist.
ALTER TABLE public.prospects
  ADD COLUMN sourcing_run_id uuid NULL
    REFERENCES public.sourcing_runs(id) ON DELETE RESTRICT;

CREATE INDEX idx_prospects_sourcing_run
  ON public.prospects (organisation_id, sourcing_run_id);

-- ── RLS, and the grants underneath it ─────────────────────────────────────────
--
-- Operator-only, which in this codebase means service-role-only: the operator routes own
-- the auth gate and read through a service client (ADR-027).
--
-- RLS WITH ZERO POLICIES IS ONE LAYER AND NOT THE ONLY ONE. Supabase runs ALTER DEFAULT
-- PRIVILEGES on the public schema granting anon and authenticated BY NAME, so this table
-- received explicit grants at creation. REVOKE ... FROM PUBLIC removes a grant that was
-- never there: it is a silent no-op, it does not error, and it does not warn. That is the
-- 2026-08-25 verification_calls shape exactly, where RLS was the only thing standing
-- between anon and the paid-verification ledger.
--
-- So both layers, and the roles named explicitly.
ALTER TABLE public.sourcing_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sourcing_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.sourcing_runs FROM anon, authenticated;
GRANT ALL ON TABLE public.sourcing_runs TO service_role;

COMMIT;

-- ── VERIFICATION, run separately after apply, in BOTH directions ──────────────
--
-- Checking only the role that MUST have it passes while the hole stays open. That is the
-- entire failure mode of the 2026-08-24 job_queue incident.
--
--   SELECT has_table_privilege('service_role',  'public.sourcing_runs', 'SELECT'), -- t
--          has_table_privilege('anon',          'public.sourcing_runs', 'SELECT'), -- f
--          has_table_privilege('authenticated', 'public.sourcing_runs', 'SELECT'); -- f

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- ALTER TABLE public.prospects DROP COLUMN IF EXISTS sourcing_run_id;
-- DROP TABLE IF EXISTS public.sourcing_runs;
