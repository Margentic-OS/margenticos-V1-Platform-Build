-- Session 5, Part 1 — Task 3
-- Create agent_runs table for observability across all agent invocations.
-- Writes are service role only. Operators read all; clients read their own org only.

CREATE TABLE agent_runs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid        NOT NULL REFERENCES organisations(id),
  agent_name     text        NOT NULL,
  status         text        NOT NULL CHECK (status IN ('completed', 'failed', 'running')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  duration_ms    integer,
  output_summary text,
  error_message  text
);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;

-- Operators can read all agent run rows
CREATE POLICY "operators_read_all_agent_runs"
  ON agent_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role = 'operator'
    )
  );

-- Clients can read only rows belonging to their own organisation
CREATE POLICY "clients_read_own_agent_runs"
  ON agent_runs
  FOR SELECT
  TO authenticated
  USING (
    client_id = (
      SELECT organisation_id FROM users
      WHERE users.id = auth.uid()
        AND users.role = 'client'
    )
  );

-- No INSERT / UPDATE / DELETE policies for authenticated users.
-- All writes go through service role only.
