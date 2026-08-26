-- Migration: synthesis_batches + synthesis_batch_entries
-- Date: 2026-08-26
--
-- Status: APPLIED (verified live 2026-08-26)
--
-- Read-back after apply, all twenty-four privilege checks in BOTH directions:
--
--   synthesis_batches       RLS on, 0 policies
--   synthesis_batch_entries RLS on, 0 policies
--   service_role  SELECT/INSERT/UPDATE/DELETE  ->  true,  true,  true,  true   (both tables)
--   anon          SELECT/INSERT/UPDATE/DELETE  ->  false, false, false, false  (both tables)
--   authenticated SELECT/INSERT/UPDATE/DELETE  ->  false, false, false, false  (both tables)
--
-- The whole-database audit from CLAUDE.md returned zero rows: no table in public is
-- readable by anon without RLS.
--
-- The REVOKE was then proved to BITE rather than to be a no-op. Running as anon inside
-- BEGIN ... ROLLBACK against a live probe row:
--
--   ERROR 42501: permission denied for table synthesis_batch_entries
--
-- That error comes from the GRANT layer, before RLS is consulted at all. It is the exact
-- layer that was open on verification_calls on 2026-08-25, where RLS held and the grant
-- did not. Two independent controls, both confirmed present.
--
-- Every guard was then broken ON PURPOSE, each inside BEGIN ... ROLLBACK, and the
-- database refused each one:
--
--   batch id without a submitted_at stamp  ->  23514 synthesis_batches_id_implies_submitted
--   two live entries for one prospect      ->  23505 ..._one_live_per_prospect
--   state 'submitted' with a null batch_id ->  23514 ..._batch_required
--   an entry state that does not exist     ->  23514 ..._state_valid
--   deleting a batch with a live entry     ->  23514 ..._batch_required (via the SET NULL)
--
-- And the paths that must work, do:
--
--   expiry -> requeue: state back to pending_submission, submit_attempts 0 -> 1,
--             raw_sources INTACT. Nothing is re-bought. This is the failure mode that
--             costs real money and it is the one verified most directly.
--   collection releases the prospect's slot, so an ordinary later run can start fresh.
--   pruning a COLLECTED batch succeeds, nulls the pointer, and leaves the entry and its
--             snapshot untouched.
--   the entry id used as custom_id is 36 characters and satisfies Anthropic's
--             ^[a-zA-Z0-9_-]{1,64}$, checked against the live regex rather than counted
--             by eye.
--   expires_at - requested_at = exactly 1 day, matching Anthropic's 24-hour ceiling.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
--
-- Moving the research synthesis call onto Anthropic's Message Batches API. Batch
-- pricing is 50% of standard on both input and output, it stacks with prompt
-- caching, and the bytes and the model are identical, so there is no quality
-- trade. Synthesis is 78% of the Anthropic spend per prospect.
--
-- The cost of that discount is TIME. A batch may take up to 24 hours. Nothing in
-- this system can hold a lease that long: research's lease is 360 seconds and the
-- agent_runs reaper marks any run still 'running' after 600 seconds as failed. So
-- the research run splits into two jobs with a wait between them, and these two
-- tables are what survives the wait.
--
--   PHASE 1  fetch the four sources exactly as today, snapshot everything the
--            second half will need, submit the synthesis calls. Job completes.
--   WAIT     a pg_cron sweep polls batch status. Nothing holds a lease.
--   PHASE 2  read the synthesis out of the batch result, run writer + floor +
--            judge as today, write ONE complete prospect_research_results row.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE SNAPSHOT LIVES HERE AND NOT IN prospect_research_results
--
-- The obvious design is to write a research row after synthesis and fill in the
-- opening later. It is wrong, and the reason is worth stating because it is not
-- obvious until you read loadStoredFindings.
--
-- storeResearchResult requires an `opening`. There is no row shape meaning
-- "synthesis done, opening pending". And the reuse filter in loadStoredFindings
-- is candidates.length > 0 and nothing else. A synthesis-only row HAS candidates,
-- so an ordinary run for the same prospect would select that half-built row as
-- reuse material and hand a later prospect a synthesis with no judged opening.
-- Silently. No error, no log line, just worse copy.
--
-- Keeping the intermediate state in its own table removes the failure instead of
-- guarding against it. storeResearchResult is untouched. loadStoredFindings is
-- untouched. No live selection path changes. prospect_research_results gains its
-- row at the same moment it always has: once, complete, at the end.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY EVERY SNAPSHOT COLUMN IS A SNAPSHOT AND NOT A RE-READ
--
-- Phase 2 runs up to 24 hours after phase 1. Anything it re-reads instead of
-- reading back can have moved, and every one of these moves silently: the copy is
-- simply different, nothing fails.
--
--   raw_sources      the four source payloads. storeResearchResult writes them
--                    into raw_linkedin/raw_apollo/raw_website/raw_web_search, and
--                    sources_attempted/sources_successful are DERIVED from them by
--                    buildSourceTracking. Re-fetching would cost Apify, Apollo and
--                    Brave money for data we already bought. This column IS the
--                    protection against the 141-credit re-spend shape.
--
--   detected_signal  detectRecencySignal(rawData, now) is pure but takes the
--                    CLOCK. A LinkedIn post sitting just inside the recency
--                    threshold at phase 1 can be outside it 24 hours later, which
--                    would flip has_dateable_signal on the stored row for reasons
--                    that have nothing to do with the research.
--
--   client_context   the five strings buildSynthesisPrompt renders from. Snapped
--                    whole rather than as icp_summary alone so a RESUBMISSION
--                    after a batch expiry rebuilds a byte-identical system prompt.
--                    A drifting prompt would also lose the prompt cache, which is
--                    half the point of the exercise.
--
--   messaging_*      THE ONE THAT WOULD HAVE SHIPPED WRONG COPY. The writer takes
--                    p3, cta and templateOpening from the approved messaging
--                    document, and composeEmail1WithOpening builds the artifact
--                    the judge reads from the same document. Today the whole run
--                    finishes in about three minutes so the document cannot move.
--                    Across a batch wait it can.
--
--                    The content is snapshotted WHOLE, not as a doc id pointer.
--                    Measured: 18 messaging documents on file, mean 6,687 bytes,
--                    max 9,750. It is small, and a copy is immune to versioning,
--                    archival and deletion in a way a pointer is not.
--
--                    promote_strategy_doc_version was read live before choosing
--                    this: a new version is a NEW ROW with a new id, and the old
--                    row is only UPDATEd to set status='archived'. content is
--                    never mutated in place, and all four UPDATE sites in the
--                    application touch client_approval_status, approval_source,
--                    approved_at or icp_filter_spec, never content. So the id
--                    would have been sufficient for correctness. The copy is kept
--                    anyway because it also survives the window where a document
--                    has been promoted but not yet approved, during which
--                    fetchApprovedMessagingDoc matches nothing and THROWS.
--
--                    doc_id and doc_version are stored alongside so collection can
--                    report doc_superseded when the snapshot is no longer the
--                    active approved document. Reported, never acted on: the
--                    snapshot is used regardless. See MON-021.
--
--   variant_id       the writer targets a specific variant's P3 and CTA. Today
--                    prospects.variant_id is null at research time and resolves
--                    deterministically. If composition runs for this prospect
--                    during the wait and writes a variant_id, phase 2 would
--                    otherwise retarget and write an opening scoped to the wrong
--                    variant's email.
--
--   client_name      organisations.name as the writer saw it.
--   segment_id       as resolved by phase 1, which stamps it when it was null.

-- ═════════════════════════════════════════════════════════════════════════════
-- ONE ROW PER SUBMITTED BATCH
--
-- THIS IS ALSO THE PAID-CALL LEDGER, and that governs the column names. The row
-- is written BEFORE Anthropic is called, exactly like verification_calls: a call
-- that spends money and then fails on the way back still leaves evidence that it
-- happened. requested_at is the pre-call stamp. submitted_at is the post-call one.
-- A row with requested_at set and submitted_at null is the un-reconciled window,
-- and it is the only shape that can cost money with nothing to show for it.

CREATE TABLE IF NOT EXISTS synthesis_batches (
  -- OUR id, not Anthropic's. It has to exist before the call, because the row has
  -- to exist before the call.
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Agent isolation, per CLAUDE.md. A batch never spans organisations: the system
  -- prompt is per client, so mixing clients in one batch would destroy the shared
  -- cached prefix that makes batching worth doing.
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  -- Anthropic's msgbatch_... id. NULL until create() returns. NULL with a state of
  -- 'attempted' past the reconcile threshold means "we may have paid and lost the
  -- receipt", which is the case the sweep reconciles by listing recent batches and
  -- matching the custom_ids it finds against synthesis_batch_entries.
  anthropic_batch_id  text,

  -- attempted  ledger row written, Anthropic not yet called or not yet answered
  -- submitted  Anthropic returned a batch id, processing_status in_progress
  -- ended      Anthropic reports processing_status 'ended', results downloadable
  -- collected  every entry has been read out and the batch is finished with
  -- failed     terminal, see error
  -- expired    hit Anthropic's 24-hour ceiling. Expired entries are NOT BILLED.
  state               text        NOT NULL DEFAULT 'attempted',

  -- How many requests went in. Anthropic's ceiling is 100,000 requests or 256 MB
  -- per batch, whichever comes first. Measured against our own data this is not a
  -- constraint we can reach: the prompt material is 4,109 bytes mean and 10,298
  -- max per prospect, plus a ~27 KB system prompt, so a thousand-prospect batch is
  -- about 31 MB. Recorded because a number that is never checked is a number that
  -- becomes wrong quietly.
  request_count       integer     NOT NULL DEFAULT 0,

  -- Which model and which cache TTL, so a cache-rate measurement is attributable
  -- to the configuration that produced it rather than to whatever is in the code
  -- when someone reads the table later.
  --
  -- THE TTL CHOICE IS PROVISIONAL. Anthropic documents in-batch cache hits as
  -- best-effort at 30% to 98%. A 1-hour write costs 2x base input against 1.25x
  -- for 5 minutes, so at the bottom of that documented range the 1-hour TTL is a
  -- LOSS, not a saving. This column is how that gets settled with data.
  model               text        NOT NULL,
  cache_ttl           text        NOT NULL,

  -- ── The ledger stamps ──────────────────────────────────────────────────────
  requested_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  ended_at            timestamptz,
  collected_at        timestamptz,

  -- requested_at + 24h. Anthropic expires a batch that has not finished by then
  -- and does not bill the unfinished requests. Stored rather than computed so the
  -- SLA is visible in a plain SELECT and MON-021 can age against it.
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),

  -- Poll bookkeeping. poll_count rising with state stuck is the signature of a
  -- batch that will need ageing out.
  last_polled_at      timestamptz,
  poll_count          integer     NOT NULL DEFAULT 0,

  -- Anthropic's request_counts object, verbatim.
  counts              jsonb,

  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT synthesis_batches_state_valid
    CHECK (state IN ('attempted','submitted','ended','collected','failed','expired')),

  -- A batch id means Anthropic answered, which means submitted_at must be set.
  -- Stated as a constraint rather than a convention because the pair is the
  -- difference between "we know what we bought" and the un-reconciled window.
  CONSTRAINT synthesis_batches_id_implies_submitted
    CHECK ((anthropic_batch_id IS NULL) = (submitted_at IS NULL))
);

-- Anthropic's id is unique on their side; make it unique on ours so a
-- double-recorded submission is a database error rather than two batches we then
-- collect twice. Partial because it is NULL for the whole pre-call window.
CREATE UNIQUE INDEX IF NOT EXISTS synthesis_batches_anthropic_id_uniq
  ON synthesis_batches (anthropic_batch_id)
  WHERE anthropic_batch_id IS NOT NULL;

-- The sweep's working set: everything not yet finished, oldest first.
CREATE INDEX IF NOT EXISTS synthesis_batches_open_idx
  ON synthesis_batches (state, requested_at)
  WHERE state IN ('attempted','submitted','ended');

CREATE INDEX IF NOT EXISTS synthesis_batches_org_idx
  ON synthesis_batches (organisation_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════════
-- ONE ROW PER PROSPECT IN A BATCH
--
-- This is where the per-entry outcome lives, keyed on custom_id, and where the
-- phase-2 snapshot lives. An entry exists BEFORE any batch does: phase 1 writes
-- it in state 'pending_submission' and the sweep gathers pending entries for one
-- organisation into a batch. That is why batch_id is nullable.

CREATE TABLE IF NOT EXISTS synthesis_batch_entries (
  -- THIS IS THE custom_id. Anthropic requires ^[a-zA-Z0-9_-]{1,64}$ and echoes it
  -- back on every result; a uuid is 36 characters and matches. Using the primary
  -- key itself means the mapping from a returned result to our row cannot drift,
  -- and it is what makes orphan reconciliation possible: read any batch's results,
  -- look its custom_ids up here, and if they resolve the batch is ours.
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The batch this entry was LAST gathered into. NULL before the first one.
  --
  -- Kept, not cleared, when a batch expires and the entry is requeued: state goes
  -- back to pending_submission and this keeps saying which batch failed it, which
  -- is the more useful fact when reading the table later. submit_attempts counts
  -- the rounds.
  --
  -- ON DELETE SET NULL, NOT CASCADE, and the difference is money. This row holds
  -- four source payloads that were paid for. Cascading would mean that pruning old
  -- batch rows destroys entries still waiting to be submitted, and a prune is
  -- exactly the kind of tidy-up that gets run without thinking about what it takes
  -- with it. Orphaning the entry is recoverable; deleting the snapshot is not.
  batch_id            uuid        REFERENCES synthesis_batches(id) ON DELETE SET NULL,

  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  prospect_id         uuid        NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  -- pending_submission  sources fetched and snapshotted, not yet sent
  -- submitted           in a live batch, awaiting a result
  -- succeeded           Anthropic returned a message. response_text is populated.
  -- errored             Anthropic returned an error for THIS request. NOT BILLED.
  -- expired             the batch hit 24 hours before this request ran. NOT BILLED.
  -- cancelled           the batch was cancelled before this request ran. NOT BILLED.
  -- collected           phase 2 has consumed this entry and written its research row
  -- failed              terminal for a reason of ours, see error
  state               text        NOT NULL DEFAULT 'pending_submission',

  -- ── The snapshot. See the long note at the top of this file. ───────────────
  raw_sources         jsonb       NOT NULL,
  detected_signal     jsonb       NOT NULL,
  client_context      jsonb       NOT NULL,
  client_name         text        NOT NULL,
  segment_id          uuid,
  variant_id          text        NOT NULL,

  messaging_doc_id    uuid        NOT NULL,
  messaging_doc_version text      NOT NULL,
  -- Deliberately NOT a foreign key. A FK here would either block deleting an
  -- organisation (ON DELETE RESTRICT) or quietly blank the pointer (SET NULL), and
  -- the content column below means the pointer is for reporting, not for reading.
  messaging_content   jsonb       NOT NULL,
  -- Set at collection: was this snapshot still the active approved document?
  -- Reported and surfaced in MON-021. Never acted on. Using the snapshot is the
  -- decision; this column is how often that decision mattered.
  doc_superseded      boolean     NOT NULL DEFAULT false,

  -- The phase-1 agent_runs row. Each phase opens and closes its OWN run, because
  -- reap-agent-runs marks anything still 'running' after 600 seconds as failed and
  -- a single run spanning the wait would be reaped mid-flight. This column is what
  -- keeps the pair joinable afterwards.
  phase1_run_id       uuid,

  -- ── The result, filled at collection ──────────────────────────────────────
  -- The model's raw text. Everything downstream of the API call in synthesizeResearch
  -- is pure: parseSynthesisResponse, selectCandidate, scrubAITells and
  -- applyTriggerReadabilityGate take no clock and make no call. Given this text plus
  -- the snapshot above, phase 2 reproduces a byte-identical SynthesisOutput.
  response_text       text,
  -- usage verbatim. cache_read_input_tokens here is the only production evidence of
  -- whether caching survived batching, which is the open question this whole change
  -- rests on.
  usage               jsonb,
  result_type         text,
  stop_reason         text,
  error               text,

  -- How many batches this entry has been through. A batch that expires requeues its
  -- entries REUSING raw_sources, so this rises without any source being re-bought.
  submit_attempts     integer     NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT synthesis_batch_entries_state_valid
    CHECK (state IN ('pending_submission','submitted','succeeded','errored',
                     'expired','cancelled','collected','failed')),

  -- ── ONE L, AND IT IS NOT A TYPO ───────────────────────────────────────────
  -- result_type holds ANTHROPIC'S wire value verbatim, and Anthropic spells it
  -- 'canceled'. The `state` column above holds OURS, and this codebase spells it
  -- 'cancelled', matching JOB_STATES in src/lib/queue/types.ts.
  --
  -- A one-letter difference between a wire value and an internal value is the
  -- producer/consumer format mismatch from CLAUDE.md: the Apollo handler wrote
  -- "Germany", the send rule matched 'DE', both sides had passing tests, nothing
  -- tested the seam, and two German prospects were mailed. So the translation
  -- between these two vocabularies lives in exactly ONE function in TypeScript and
  -- is covered by a test that exercises the PAIR, not each side alone.
  CONSTRAINT synthesis_batch_entries_result_type_valid
    CHECK (result_type IS NULL OR result_type IN ('succeeded','errored','expired','canceled')),

  -- An IN-FLIGHT entry must name its batch. Catches a gather that moved the state
  -- and forgot the pointer, which would leave a paid-for request nothing could
  -- ever collect.
  --
  -- Scoped to 'submitted' alone and not to "anything past pending_submission",
  -- because batch_id is ON DELETE SET NULL and a SET NULL fires this CHECK. The
  -- wider version made it impossible to prune ANY finished batch: the cascade
  -- would try to null out its collected entries and this would refuse. Scoped this
  -- way, pruning a finished batch works and pruning one with live entries still
  -- fails loudly, which is the outcome worth having.
  CONSTRAINT synthesis_batch_entries_batch_required
    CHECK (state <> 'submitted' OR batch_id IS NOT NULL)
);

-- ── ONE LIVE ENTRY PER PROSPECT ────────────────────────────────────────────
-- Two live entries for one prospect means two synthesis calls paid for and two
-- research rows written, with the second overwriting the first's classification.
-- Structural, not a convention.
CREATE UNIQUE INDEX IF NOT EXISTS synthesis_batch_entries_one_live_per_prospect
  ON synthesis_batch_entries (prospect_id)
  WHERE state IN ('pending_submission','submitted','succeeded','errored','expired','cancelled');

-- The gather query: pending entries for one organisation, oldest first.
CREATE INDEX IF NOT EXISTS synthesis_batch_entries_pending_idx
  ON synthesis_batch_entries (organisation_id, created_at)
  WHERE state = 'pending_submission';

CREATE INDEX IF NOT EXISTS synthesis_batch_entries_batch_idx
  ON synthesis_batch_entries (batch_id, state);

CREATE INDEX IF NOT EXISTS synthesis_batch_entries_prospect_idx
  ON synthesis_batch_entries (prospect_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════════
-- SECURITY. TWO LAYERS, BOTH REQUIRED. See CLAUDE.md, 2026-08-25 incident.
--
-- RLS with no policies genuinely denies every row to anon. What it does NOT do is
-- remove the GRANT underneath it, because Supabase runs ALTER DEFAULT PRIVILEGES
-- on the public schema and a table created there receives EXPLICIT, BY-NAME grants
-- to anon and authenticated at creation time. REVOKE ... FROM PUBLIC removes a
-- grant that was never there: a silent no-op that does not error and does not warn.
--
-- These tables hold four source payloads bought with real money, a client's whole
-- messaging document, and the ledger of what has been spent with Anthropic. Both
-- layers, and both read back in both directions before this migration is stamped
-- APPLIED.

ALTER TABLE synthesis_batches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_batch_entries  ENABLE ROW LEVEL SECURITY;

-- No policies. Nothing client-facing reads these; every caller is a service-role
-- route or the pg_cron sweep. A policy added later is a decision to be argued for
-- on its own, not a default.

REVOKE ALL ON TABLE public.synthesis_batches       FROM PUBLIC;
REVOKE ALL ON TABLE public.synthesis_batch_entries FROM PUBLIC;
REVOKE ALL ON TABLE public.synthesis_batches       FROM anon, authenticated;
REVOKE ALL ON TABLE public.synthesis_batch_entries FROM anon, authenticated;

GRANT ALL ON TABLE public.synthesis_batches       TO service_role;
GRANT ALL ON TABLE public.synthesis_batch_entries TO service_role;
