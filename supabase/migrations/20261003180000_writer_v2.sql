-- Writer v2: one model call writes a prospect's whole four-email sequence from the research
-- facts, the firm fact and the client's playbook. Built behind a per-client switch; the old
-- writing path stays in place and is what every client with the switch off still gets.
--
-- Operator decision, 2026-10-03 (Notion: "Writer v2: playbook format, MargenticOS playbook v1,
-- writer instructions (prototype spec)").
--
-- THREE ADDITIONS, ALL ADDITIVE:
--
--   organisations.sequence_writer_v2_enabled   the switch. Default false, so every client stays
--                                              on the old path until an operator turns it on.
--   prospects.writer_v2_sequence               what the writer produced: the tier, the four
--                                              emails (null for the template tier), the fact it
--                                              used, the angles, every attempt's check failures,
--                                              and the playbook version it was written from.
--                                              Read by composition at upload.
--   sent_sequences.sequence_writer / writer_tier / playbook_version
--                                              what reporting reads IN PLACE OF the variant for a
--                                              writer-v2 send. variant_id becomes nullable, and a
--                                              CHECK keeps it required for every old-path send and
--                                              for a writer-v2 send that fell to the template.
--
-- ACCESS. No new table. The columns inherit their tables' grants and RLS: organisations and
-- prospects are operator-ALL with client SELECT on their own rows; sent_sequences is
-- service-role only (read back 2026-10-01). No grant changes.
--
-- Status: NOT YET APPLIED

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS sequence_writer_v2_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organisations.sequence_writer_v2_enabled IS
  'When true, research skips the old opening writer, writer v2 writes each prospect''s whole sequence from the playbook in the messaging document, and upload composes from prospects.writer_v2_sequence. Set by an operator.';

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS writer_v2_sequence jsonb;

COMMENT ON COLUMN public.prospects.writer_v2_sequence IS
  'Writer v2 output (src/agents/sequence-writer-agent.ts): tier, emails, fact used, angles, attempts and playbook version. Written only while outbound_upload_status is pending. Read by composeSequence when the client''s sequence_writer_v2_enabled is true.';

ALTER TABLE public.sent_sequences
  ADD COLUMN IF NOT EXISTS sequence_writer text NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS writer_tier text,
  ADD COLUMN IF NOT EXISTS playbook_version integer;

ALTER TABLE public.sent_sequences
  ALTER COLUMN variant_id DROP NOT NULL;

ALTER TABLE public.sent_sequences
  ADD CONSTRAINT sent_sequences_sequence_writer_check
    CHECK (sequence_writer IN ('v1', 'v2')),
  ADD CONSTRAINT sent_sequences_writer_tier_check
    CHECK (writer_tier IS NULL OR writer_tier IN ('personalised', 'semi_personalised', 'template')),
  -- A writer-v2 send always says which tier it reached; an old-path send never claims one.
  ADD CONSTRAINT sent_sequences_writer_tier_matches_writer
    CHECK ((sequence_writer = 'v1' AND writer_tier IS NULL) OR (sequence_writer = 'v2' AND writer_tier IS NOT NULL)),
  -- The variant is what an old-path or template send was composed from, so it stays required
  -- there. Only a writer-v2 personalised or semi-personalised send has no variant.
  ADD CONSTRAINT sent_sequences_variant_required_unless_writer_v2
    CHECK (variant_id IS NOT NULL OR (sequence_writer = 'v2' AND writer_tier IN ('personalised', 'semi_personalised')));

COMMENT ON COLUMN public.sent_sequences.sequence_writer IS
  'v1 = the old template-plus-opening path; v2 = writer v2 wrote the whole sequence.';
COMMENT ON COLUMN public.sent_sequences.writer_tier IS
  'Writer v2 only: personalised, semi_personalised, or template (the last resort, composed from variant_id).';
COMMENT ON COLUMN public.sent_sequences.playbook_version IS
  'Writer v2 only: writer_playbook.version of the messaging document the sequence was written from.';
