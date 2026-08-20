-- Adds prospects.personalisation_question.
--
-- The research writer now produces three parts: the observation, the bridge, and the
-- closing question. The question replaces the variant's approved CTA at composition time.
-- The approved P3 offer line is NOT touched: it is the client's positioning and what they
-- approved, and only the closing question moves.
--
-- WHY A COLUMN RATHER THAN trigger_data. This is a send-time input, exactly parallel to
-- personalisation_trigger, not an audit record. Composition reads it on every send, and
-- reading a load-bearing value out of an audit jsonb blob would make the send path depend
-- on the shape of a debugging field. The two columns are also set and cleared together,
-- which is far easier to assert and query when both are real columns.
--
-- NULL means "use the variant's approved CTA", which is the correct default and the state
-- of every existing row.
--
-- Status: PENDING (not yet applied)

alter table public.prospects
  add column if not exists personalisation_question text;

comment on column public.prospects.personalisation_question is
  'Written closing question replacing the variant approved CTA at composition. NULL keeps the approved CTA. Written only when the personalised version wins the judge, always together with personalisation_trigger.';
