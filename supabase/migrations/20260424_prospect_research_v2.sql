-- prospect_research_v2: new table + new columns on prospects.
-- All raw source data stored indefinitely. One row per research run per prospect.
-- Operators read all rows. Clients read their own org only. All writes via service role.

CREATE TABLE prospect_research_results (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id           uuid        NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  organisation_id       uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  run_id                uuid        REFERENCES agent_runs(id),

  -- Synthesis output
  research_tier         text        NOT NULL CHECK (research_tier IN ('tier1', 'tier3')),
  qualification_status  text        NOT NULL DEFAULT 'qualified'
                                    CHECK (qualification_status IN ('qualified', 'flagged_for_review', 'disqualified')),
  qualification_reason  text,
  trigger_text          text,
  trigger_source        jsonb,
  synthesis_reasoning   text,
  synthesis_confidence  text        CHECK (synthesis_confidence IN ('high', 'medium', 'low')),

  -- Raw source data stored indefinitely
  raw_linkedin          jsonb,
  raw_apollo            jsonb,
  raw_website           jsonb,
  raw_web_search        jsonb,

  -- Source tracking
  sources_attempted     text[]      NOT NULL DEFAULT '{}',
  sources_successful    text[]      NOT NULL DEFAULT '{}',

  synthesized_at        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE prospect_research_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operators_read_all_research_results"
  ON prospect_research_results FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'operator')
  );

CREATE POLICY "clients_read_own_research_results"
  ON prospect_research_results FOR SELECT TO authenticated
  USING (
    organisation_id = (
      SELECT organisation_id FROM users
      WHERE users.id = auth.uid() AND users.role = 'client'
    )
  );

CREATE INDEX idx_prr_prospect_id      ON prospect_research_results(prospect_id);
CREATE INDEX idx_prr_organisation_id  ON prospect_research_results(organisation_id);
CREATE INDEX idx_prr_synthesized_at   ON prospect_research_results(synthesized_at DESC);

-- New columns on prospects (denormalised for fast compose-sequence lookup).
-- current_research_result_id points to the latest run. SET NULL on result deletion.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS research_tier              text CHECK (research_tier IN ('tier1', 'tier3')),
  ADD COLUMN IF NOT EXISTS qualification_status       text DEFAULT 'qualified'
    CHECK (qualification_status IN ('qualified', 'flagged_for_review', 'disqualified')),
  ADD COLUMN IF NOT EXISTS current_research_result_id uuid
    REFERENCES prospect_research_results(id) ON DELETE SET NULL;
