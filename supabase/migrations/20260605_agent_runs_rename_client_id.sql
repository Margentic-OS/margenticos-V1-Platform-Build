-- Rename agent_runs.client_id → organisation_id
--
-- agent_runs was the only table in the schema using client_id.
-- All 18 other tables use organisation_id. This eliminates the naming
-- inconsistency and removes the structural cause of the 2026-06-05
-- "column client_id does not exist" error (code querying the wrong
-- column name against a non-agent_runs table).
--
-- Corresponding application code changes are in the same commit.
-- Apply this migration only after the code deploy is READY on Vercel.

ALTER TABLE public.agent_runs RENAME COLUMN client_id TO organisation_id;

ALTER TABLE public.agent_runs
  RENAME CONSTRAINT agent_runs_client_id_fkey TO agent_runs_organisation_id_fkey;

-- Recreate the client RLS policy — it referenced client_id by name
DROP POLICY IF EXISTS clients_read_own_agent_runs ON public.agent_runs;

CREATE POLICY clients_read_own_agent_runs ON public.agent_runs
  FOR SELECT TO authenticated
  USING (organisation_id = (
    SELECT users.organisation_id
    FROM public.users
    WHERE users.id = auth.uid()
      AND users.role = 'client'
  ));
