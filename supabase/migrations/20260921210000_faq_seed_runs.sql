-- Status: APPLIED (verified live 2026-09-21, both production and test projects)
-- faq_seed_runs: one row per FAQ seed run, and the lock that stops two at once.
--
-- WHY A TABLE AND NOT A FLAG. The seed agent costs a real Opus call per run and writes
-- 5 to 15 pending candidates. Two runs started together would both pay and both write,
-- doubling the operator's curation queue. A read-then-write check in the route cannot
-- stop that: both requests read "none running" before either writes. The unique index
-- below is the chokepoint, because an INSERT either wins it or raises 23505.
--
-- WHY NOT agent_runs. agent_runs already allows status='running' and is already reaped,
-- so it was the obvious host. It was rejected because the agent writes its OWN completed
-- or failed row at the end of every run: a claim row there would make every single run
-- appear in agent_runs twice, and anyone counting runs would be wrong. agent_runs stays
-- the agent's history (ADR-029); this table is the lock and the operator-facing record.

CREATE TABLE IF NOT EXISTS public.faq_seed_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  state               text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  candidates_created  integer,
  started_by_user_id  uuid REFERENCES auth.users(id),
  error_message       text
);

-- THE LOCK. At most one live run per organisation. Partial, so completed and failed
-- history rows accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS faq_seed_runs_one_live_per_org
  ON public.faq_seed_runs (organisation_id)
  WHERE state = 'running';

-- Reading "when did the last run happen" for one org.
CREATE INDEX IF NOT EXISTS faq_seed_runs_org_started_at
  ON public.faq_seed_runs (organisation_id, started_at DESC);

-- ── Privileges ───────────────────────────────────────────────────────────────
-- Service-role only: the operator route owns the auth gate. RLS is enabled because it
-- is what actually denies rows today, and the grants are revoked BY NAME as well,
-- because Supabase's ALTER DEFAULT PRIVILEGES grants anon and authenticated explicitly
-- and REVOKE ... FROM PUBLIC alone is a silent no-op against those. See CLAUDE.md,
-- "Rule: THE SAME TRAP APPLIES TO TABLES".
ALTER TABLE public.faq_seed_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.faq_seed_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.faq_seed_runs FROM anon, authenticated;
GRANT ALL ON TABLE public.faq_seed_runs TO service_role;
