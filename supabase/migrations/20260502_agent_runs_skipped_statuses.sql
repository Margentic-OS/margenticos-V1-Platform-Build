-- Allow 'skipped' and 'skipped_idempotent' in agent_runs.status.
-- The faq-extraction-agent writes these when the filler-detection gate fires
-- or idempotency is detected. Without them the observability writes silently fail.
ALTER TABLE public.agent_runs
  DROP CONSTRAINT agent_runs_status_check,
  ADD CONSTRAINT agent_runs_status_check
    CHECK (status = ANY (ARRAY[
      'completed'::text,
      'failed'::text,
      'running'::text,
      'skipped'::text,
      'skipped_idempotent'::text
    ]));
