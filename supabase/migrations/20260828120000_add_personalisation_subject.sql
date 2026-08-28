-- Adds prospects.personalisation_subject.
--
-- Every Email 1 has shipped the variant's AUTHORED subject line, unmodified, on every path.
-- On the researched path the body's second paragraph is replaced by the writer's
-- observation, and the authored subject was written against the paragraph that just went
-- away. So the subject named a framing the body no longer contained, and the subject is the
-- first thing the reader sees.
--
-- The writer now returns a fourth labelled block, the subject, derived from the observation
-- it just wrote, inside the model call that already produces the observation. No new call.
--
-- WHY A COLUMN RATHER THAN trigger_data. The same reasoning as personalisation_question,
-- which this sits beside: it is a send-time input read by composition on every send, not an
-- audit record, and reading a load-bearing value out of a debugging jsonb blob would make
-- the send path depend on the shape of that blob.
--
-- NULL means "use the variant's authored subject". That is the correct default, the state of
-- every existing row, and also the state of a prospect whose opening shipped but whose
-- generated subject failed its own gate. The subject gate FAILS SOFT: it never costs the
-- prospect an attempt, it only ever falls back to the approved subject.
--
-- Status: APPLIED (verified live 2026-08-28)

alter table public.prospects
  add column if not exists personalisation_subject text;

comment on column public.prospects.personalisation_subject is
  'Written Email 1 subject replacing the variant authored subject at composition. NULL keeps the authored subject. Written only when the personalised version wins the judge AND the generated subject passed its soft gate, so it may be NULL while personalisation_trigger is set.';
