# data-model.md — Database Tables, Fields, RLS Policies
# Last updated: 2026-09-02 — sourcing_runs added (batch identity), prospects.sourcing_run_id.
# Previously 2026-08-21 — suppressed_emails added (global bounce/unsubscribe list, closes audit D2).
# Previously April 2026 — pipeline_unlock_manual_override added to organisations; sequence_position documented on document_suggestions; generated types written to src/types/database.ts
# Written for non-developers. Update this file whenever a table is added or changed.
# The spec is in /prd/sections/03-data-model.md — this is the living reference.

---

## How the database is secured

Every table has Row Level Security (RLS) enabled. This means the database itself
enforces who can see what data — not just the application code.

Two helper functions power all RLS policies:

  get_my_organisation_id()  — returns the current user's organisation ID
  is_operator()             — returns true if the current user is the operator (Doug)

Both functions use SECURITY DEFINER, which means they run with elevated permissions
to avoid an infinite loop (the functions need to query the users table to check roles,
but the users table also has RLS — SECURITY DEFINER breaks the loop safely).

---

## Table: organisations

The top-level tenant. Each client is one organisation. MargenticOS itself is a row too.

Fields:
  id                  — unique identifier (auto-generated)
  name                — company name
  slug                — URL-safe identifier, must be unique
  contract_start_date — when the engagement began
  contract_status     — active / paused / churned (operator only)
  engagement_month    — months since contract start (operator only)
  payment_status      — current / overdue / etc. (operator only)
  pipeline_unlocked                — whether the pipeline view is visible to the client
  pipeline_unlock_at               — when the unlock trigger was met
  pipeline_unlock_manual_override  — operator-only toggle; when true, forces pipeline visible
                                     regardless of the automatic unlock rules (2 months / 5 meetings).
                                     Default false. Never exposed to clients via client_organisation_view.
  meetings_count      — running count of qualified meetings booked
  created_at / updated_at

RLS (read back from pg_policies live on 2026-08-27, not from the migration files):
  Operator: operators_full_access_organisations — ALL, authenticated, qual is_operator().
  Client:   clients_read_own_organisation — SELECT, authenticated,
            qual (id = get_my_organisation_id()).

  CORRECTED 2026-08-27. This section previously said the client SELECT policy
  "was dropped" and that clients had NO direct SELECT access on organisations. That is
  not true and a live read of pg_policies contradicts it: the policy exists, it is a
  SELECT policy, and it scopes the client to their own row. What clients do NOT have is
  an UPDATE, INSERT or DELETE policy, so writes match zero rows.

  The stale claim mattered. It was the stated justification for running
  client_organisation_view as its owner, and anyone reasoning from it would conclude that
  setting security_invoker = true must break every client read. It does not, because the
  policy is there and its predicate is identical to the view's own WHERE clause.
  Verified by SET ROLE with a real client's JWT, before and after the change: one row,
  own organisation, both times.

---

## View: client_organisation_view

A read-only view over the organisations table for client-role queries.
Excludes the three operator-only fields: contract_status, payment_status, engagement_month.

This is the required path for any client-facing query that needs organisation data.
Direct SELECT on organisations is permitted for operators only.

Columns exposed (all others excluded):
  id, name, slug, contract_start_date,
  pipeline_unlocked, pipeline_unlock_at, meetings_count,
  created_at, updated_at

How it works (CHANGED 2026-08-27, migration 20260827220000):
  The view is security_invoker = TRUE. It runs as the CALLER, so RLS on organisations is
  consulted normally. The WHERE clause (id = get_my_organisation_id()) and the RLS policy
  clients_read_own_organisation carry the identical predicate, so the caller sees exactly
  their own organisation row. Two independent gates now agree instead of one gate
  standing alone.

  It was previously security_invoker = false, meaning it ran as its postgres owner and RLS
  was never consulted. On the READ path that was survivable, because the WHERE clause
  self-scopes and get_my_organisation_id() denies EXECUTE to anon.

  THE WRITE PATH WAS NOT SURVIVABLE, and that is what the change actually fixed.
  This view is auto-updatable (is_updatable = YES), and anon and authenticated both held
  the full default arwdDxtm grant set on it. Measured as a real signed-in client:

      UPDATE via the view       -> SUCCEEDED, 1 row changed   (RLS bypassed)
      UPDATE via organisations  -> SUCCEEDED, 0 rows          (RLS holding, correctly)

  A client could therefore set pipeline_unlocked on their own organisation, defeating the
  operator-controlled phased unlock, and could rewrite name, slug, contract_start_date and
  meetings_count. Scoped to their own organisation by the WHERE clause, so it was
  escalation within one tenant, never cross-tenant. Closed by making the view run as the
  caller AND by reducing the grant to SELECT.

Permissions (read back live after the change):
  relacl  {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres}
  authenticated  SELECT only. No INSERT, UPDATE, DELETE or MAINTAIN.
  anon           removed from the ACL entirely.
  service_role   unchanged; it bypasses RLS by role attribute regardless.

  Operators will typically query organisations directly for full field access.
  Only clients are restricted to this view.

  Nothing in src/ reads this view today. There is no `.from('client_organisation_view')`
  anywhere in the application, only generated FK metadata in the two database.types
  files. If you wire a client-facing organisation read, this is the path to use.

If you add a new operator-only field to organisations:
  Do not add it to this view. It will remain invisible to clients automatically.

If you add a new client-safe field to organisations:
  Add it to the SELECT list in the view definition.

  DO NOT do that with a bare DROP + CREATE. A drop loses the ACL, and Supabase's
  ALTER DEFAULT PRIVILEGES on the public schema re-grants anon and authenticated the full
  arwdDxtm set by name at creation time. That is how the write grant got here in the first
  place. CREATE OR REPLACE VIEW preserves both the ACL and the reloptions; if you ever do
  have to drop it, re-apply the REVOKE/GRANT block from 20260827220000 in the same
  migration and read the privileges back for anon, authenticated and service_role before
  committing.

---

## Table: users

Extends Supabase Auth. One row per user. The id matches the Supabase Auth user id.

Fields:
  id              — matches auth.users id
  organisation_id — which organisation this user belongs to
  email
  role            — operator or client
  display_name
  created_at
  last_seen_at    — updated by the application on each session

RLS:
  Operator: full access
  Client:   can read all members of their own organisation (for display purposes)
            can update their own profile row only

Note: Multiple users can belong to one organisation.
      All client users in an org see the same dashboard.
      Doug creates all user accounts manually in phase one.

---

## Table: integrations_registry

The tool-agnostic capability registry. Maps capabilities to the tool currently
handling them. Never reference tool names outside this table and its handlers.

Fields:
  id              — unique identifier
  tool_name       — e.g. "Instantly", "Taplio"
  capability      — e.g. "can_send_email", "can_schedule_linkedin_post"
  is_active       — which tool is currently active for this capability
  api_handler_ref — path to the handler function in src/lib/handlers/
  connection_status — connected / disconnected / error
  config          — tool-specific config (never secrets — secrets go in env vars)
  created_at / updated_at

RLS:
  Operator: full access
  Client:   no access

---

## Table: intake_responses

One row per question per organisation. Clients fill this in.
The document generation agents read this to produce strategy documents.

Fields:
  id
  organisation_id
  field_key       — unique identifier for the question (e.g. "icp_industry")
  field_label     — human-readable question text
  response_value  — the client's answer
  is_critical     — if true, counts toward the 80% completeness threshold
  word_count      — calculated on write, used to detect under-answered fields
  section         — which questionnaire section (company / icp / competitors / etc.)
  version         — incremented on meaningful update
  updated_at
  UNIQUE on (organisation_id, field_key)

RLS:
  Operator: full access
  Client:   can read and write their own organisation's intake only

---

## Table: strategy_documents

One row per document per version. Four document types per client:
icp, positioning, tov (tone of voice), messaging.

Fields:
  id
  organisation_id
  document_type   — icp / positioning / tov / messaging
  version         — always lowercase v, one decimal: "1.0", "2.1"
  content         — structured document content (JSON)
  plain_text      — plain text version for agent consumption
  status          — draft / active / archived
  generated_at    — when the agent generated this version
  last_updated_at — NOT a modification timestamp, despite the name. Nothing in src/
                    writes it: every reference is a read, and some render it to the
                    client as "updated N ago". Its only writers are the SQL functions
                    approve_document_suggestion and the segment variants, which set it
                    on the ARCHIVE step only. So it marks a STATUS TRANSITION.
  updated_at      — when the row last actually changed. Maintained by the trigger
                    strategy_documents_set_updated_at (BEFORE UPDATE, set_updated_at()),
                    the same convention campaigns, intake_responses, integrations_registry,
                    meetings, organisations, patterns and prospects use. Added 2026-09-01,
                    backfilled to created_at for all 55 existing rows, because none of
                    them was modified at migration time. This is the column to read when
                    the question is "has this document changed since it was approved";
                    before it existed, an in-place edit to an active document moved no
                    timestamp at all and that question could not be answered.
  update_trigger  — initial / signal_suggestion / intake_update / manual
  is_stale        — operator flag, set true after 60 days without update
  created_at

RLS:
  Operator: full access
  Client:   read only, active documents only, their own organisation only

IMPORTANT: Agents never write to this table directly.
           All agent-suggested changes go to document_suggestions first.
           Doug approves → new version created → previous version archived.

---

## Table: document_suggestions

The suggestion queue. Agents write here. Operator reviews and approves.
Approved suggestions create a new strategy_documents version.

Fields:
  id
  organisation_id
  document_id               — which strategy document this suggestion applies to
  document_type             — icp / positioning / tov / messaging
  field_path                — dot-notation path to the field (e.g. "icp.target_title")
  current_value             — what the field says now
  suggested_value           — what the agent thinks it should say
  suggestion_reason         — plain English explanation from the agent
  confidence_level          — low / medium / high (schema only in phase one)
  signal_count              — how many signals triggered this (schema only in phase one)
  ab_variant                — A/B test variant text (schema only in phase one)
  conflicting_suggestion_id — links to a competing suggestion for the same field (phase one schema only)
  sequence_position         — ordering field for suggestions within a sequence (nullable integer).
                              Present in database but not yet used by any logic. Phase two.
  status                    — pending / approved / rejected / superseded
  created_at
  reviewed_at               — when Doug reviewed it
  reviewed_by               — which user reviewed it

Phase one note: signal_count, confidence_level, ab_variant, conflicting_suggestion_id
exist in the schema but the logic that populates them is not built until phase two.
See ADR-011 and prd/sections/07-feedback-loop.md.

RLS:
  Operator: full access
  Client:   no access

---

## Table: campaigns

One row per campaign per organisation.

Fields:
  id
  organisation_id
  campaign_type   — cold_email / linkedin_post / linkedin_dm
  external_id     — the ID in Instantly / Taplio / Lemlist
  status          — draft / active / paused / completed
  sequence_name   — human-readable name for the sequence
  started_at / paused_at
  created_at / updated_at

RLS:
  Operator: full access
  Client:   read only, their own organisation's campaigns

---

## Table: prospects

One row per prospect per organisation.

Fields:
  id
  organisation_id
  first_name / last_name / email / company_name / role / linkedin_url
  personalisation_trigger — the observation and bridge written by research. Replaces
                            Email 1's P2 slot at composition. NULL means the variant's
                            authored opener ships unchanged.
  personalisation_question — the written closing question. Replaces the variant's approved
                            CTA. NULL keeps the approved one. Set and cleared with
                            personalisation_trigger.
  personalisation_subject — the written Email 1 subject, derived from the observation
                            above. Replaces the variant's authored subject_line at
                            composition, on the researched path only. NULL keeps the
                            authored subject. NOT always set when the trigger is: the
                            subject has its own gate and it FAILS SOFT, so an opening can
                            ship with the authored subject above it.
  research_source         — apollo / web_search / website / pain_proxy
  suppressed              — true means no further contact, ever
  suppressed_at / suppression_reason
  created_at / updated_at

RLS:
  Operator: full access
  Client:   no access (prospects never exposed to clients directly)

---

**sourcing_run_id (added 2026-09-02).** Which sourcing run added this prospect. Written
once, when the prospect is inserted, and never updated: dedupe drops a prospect a later run
re-encounters, so the answer cannot change.

The foreign key is ON DELETE RESTRICT, which means a run record cannot be deleted while
prospects point at it. The alternatives were both worse: CASCADE would delete real
prospects, which cost real money, because somebody tidied a run record; SET NULL would
silently un-batch a whole cohort and send the screen back to summing everything with
nothing to say why.

NULL is allowed and means "belongs to no recorded run". Nineteen prospects are in that
state: twelve in an organisation archived before run logging existed, and seven test
fixtures. They are SHOWN on the review screen as their own group rather than hidden,
because a total that quietly omits rows is the defect the batch identity exists to remove.

## Table: sourcing_runs

**What it is.** One row per sourcing run. This is the batch identity: it is what lets the
review screen show "this batch" rather than "everything this client has ever had".

**Why it exists.** Before 2026-09-02 there was no batch identifier on prospects at all.
Every count on the pipeline review screen summed every cohort the organisation had ever
had, so the Tier 1 card read 93 with no way to tell that it was five separate runs.

**Columns.**

| Column | What it holds |
|---|---|
| id | the batch identity |
| organisation_id | whose batch. Foreign key to organisations |
| started_at / completed_at | when. completed_at NULL means still running, or died |
| status | running, completed or failed |
| target_batch_size | how many were asked for. NULL only on backfilled rows (see below) |
| candidates_returned | how many the sourcing tool sent back |
| prospects_written | how many were new and were kept |
| dropped_by_reason | how many were already known, as an object keyed by dedupe verdict |
| error_message | why it failed |
| trigger_type | operator_manual today; 'backfilled' on reconstructed rows |
| icp_document_id | which ICP version the run filtered against |
| created_by | which operator clicked. NULL for the command-line runner |
| agent_run_id | the matching agent_runs row, so the two histories stay tied together |
| backfilled_at | set ONLY on rows reconstructed from history. See below |

**dropped_by_reason is an object, not four columns, and that is deliberate.** Four columns
named after today's four dedupe reasons would be a second list that has to be kept in step
by hand with the list in the orchestrator. A fifth reason would then produce no error at
all: it would simply have no column, its count would vanish, and a batch that lost
prospects to it would look like a batch that did not. The object is built from the reasons
that actually fired, so a new one appears the moment it exists.

**No cost columns, deliberately.** Enrichment credits and paid verification calls are
recorded per prospect and can be reached through prospects.sourcing_run_id. Model spend is
recorded NOWHERE: research makes four model calls per prospect and the job queue records
only which sources were attempted, never tokens or cost. A cost column here would be right
for new batches and quietly understated for every older one, so there is none until the
largest part of the cost is actually measured.

**backfilled_at, and why it matters when reading these numbers.** Eleven rows were
reconstructed on 2026-09-02 from the run log that already existed. Their counts were parsed
out of an English sentence rather than written down as they happened, so they are as good
as that log and no better. The screen says so on those rows. A row without backfilled_at
was recorded as it ran.

**Security.** RLS enabled, zero policies, and the grants revoked underneath it by name:
anon and authenticated have no privilege at all, service_role has all. Operator-only, and
clients cannot read it. This was checked by reading has_table_privilege back for all three
roles rather than assuming the REVOKE worked, because REVOKE ... FROM PUBLIC is a silent
no-op on this platform. See the CLAUDE.md database security rules.

**What to check if it breaks.** If the review screen shows no runs, check that rows exist
for the organisation. If a batch line disagrees with the card above it, the screen already
says so in words; the difference should be exactly the prospects belonging to no run.

## Table: signals

Campaign performance events. Each webhook or event from Instantly, Taplio, etc.
creates a signal row. The signal processing agent reads unprocessed rows.

Fields:
  id
  organisation_id
  signal_type     — email_open / email_reply / email_bounce / email_spam /
                    linkedin_post_like / linkedin_post_comment / linkedin_dm_reply /
                    meeting_qualified / meeting_unqualified / meeting_no_show /
                    opt_out / positive_reply / information_request
  prospect_id     — which prospect triggered this signal (nullable)
  campaign_id     — which campaign this signal belongs to (nullable)
  raw_data        — full webhook payload or event data (JSON)
  processed       — false until the signal processing agent handles it
  processed_at
  created_at

RLS:
  Operator: full access
  Client:   no access (signals surface only via dashboard views)

Indexes (added migration add_signals_indexes, 2026-04-17 while table was empty):

  idx_signals_org_type         — (organisation_id, signal_type)
                                  Primary pattern query shape: all signals of type X for org Y
  idx_signals_org_processed_at — (organisation_id, processed_at)
                                  Signals for org Y in a time range
  idx_signals_type_processed_at — (signal_type, processed_at)
                                   Cross-org pattern queries by type and time (pattern aggregation agent)
  idx_signals_processed        — (processed)
                                  Pattern agent's unprocessed signal scan

If new query patterns emerge, add indexes with CREATE INDEX CONCURRENTLY to avoid locking
a live table with data already in it.

---

## Table: suppressed_emails

**What it holds.** Every email address that has bounced or unsubscribed in any
client's campaign. A global do-not-contact list, added 2026-08-21 to close audit
finding D2, where bounce detection was correct and consumed by nothing.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `email` | text NOT NULL | Stored lowercase and trimmed. Enforced by `CHECK (email = lower(btrim(email)))`, not by convention. |
| `reason` | text NOT NULL | `'bounced'` or `'unsubscribed'`, enforced by CHECK. |
| `source_org_id` | uuid | Which client's campaign produced it. `ON DELETE SET NULL`. |
| `source_signal_id` | uuid | The `signals` row that caused it. Nullable. `ON DELETE SET NULL`. |
| `created_at` | timestamptz | |
| `revoked_at` | timestamptz | Set to lift the suppression. Never delete the row. |
| `revoked_reason` | text | Mandatory whenever `revoked_at` is set, enforced by CHECK. |

**Indexes.** `UNIQUE (email) WHERE revoked_at IS NULL` is the suppression itself: one
active entry per address, and idempotency for a repeated bounce. It is partial so a
revoked row does not block a later re-suppression of the same address. Plus a plain
index on `email` for the send gate's batch lookups.

**Why `email` is normalised at the database level.** If `Bob@X.com` and `bob@x.com`
can both exist, the same person escapes suppression by capitalisation. The application
normalises on write and on every lookup; the CHECK constraint is the backstop for a
hand-written INSERT that forgets.

**Why `source_org_id` does not cascade.** Every other organisation-referencing table
here uses `ON DELETE CASCADE`. This one must not. Deleting a client would otherwise
resurrect their bounced addresses as sendable. The suppression outlives the
organisation; only the provenance goes null.

**RLS.** Enabled with **zero policies**, the same shape as `integration_credentials`.
No authenticated user reaches it, not even operators. `anon` and `authenticated` are
additionally revoked at the grant level; `service_role` holds SELECT, INSERT and
UPDATE. Clients must never read this table and there is no client-facing surface for it.

**No org-consistency trigger, deliberately.** `faqs`, `faq_extractions` and `prospects`
each carry a BEFORE INSERT OR UPDATE trigger that raises when a referenced row belongs
to a different organisation. This table must not inherit that pattern: its whole
purpose is that a row written from organisation A applies when organisation B uploads.

**How it relates to `prospects.suppressed`.** They are two independent gates, not one
derived from the other. `prospects.suppressed` is per organisation and already carries
four meanings unrelated to deliverability. Both are checked in one function,
`findBlockedProspects()` in `src/lib/suppression/send-gate.ts`, which is the single
chokepoint for the send decision.

---

## Table: meetings

One row per meeting booked.

Fields:
  id
  organisation_id
  prospect_id   — who the meeting is with
  campaign_id   — which campaign generated this meeting
  booked_at     — when it was booked
  meeting_date  — when the meeting actually takes place
  status        — booked / completed / no_show / cancelled / rescheduled
  qualification — qualified / unqualified / pending
  qualification_notes
  revenue_value — for pipeline value tracking (nullable)
  created_at / updated_at

RLS:
  Operator: full access
  Client:   read only, their own organisation (visible after pipeline unlock)

---

## Table: patterns

Cross-client anonymised insights. Never contains raw client data.
Written ONLY by the pattern aggregation agent using the service role key.
No application code, no other agent, no manual query ever writes here.

Fields:
  id
  pattern_type     — subject_line / opening_line / cta / sequence_length / etc.
  pattern_data     — aggregated insight (JSON, no client identifiers)
  sample_size      — number of clients/campaigns contributing
  confidence_score — 0.0 to 1.0
  created_at / updated_at

RLS:
  Operator: read only
  Client:   no access
  Write:    service role only (bypasses RLS — enforces the write restriction)

---

## Table: reply_handling_actions

One row per processed signal, recording what action the reply-handling pipeline took.
Written by process-reply.ts after each signal is classified and routed.

Fields:
  id
  signal_id        — FK to signals
  organisation_id  — FK to organisations (explicit tenant scope)
  action_taken     — enum, one of the values below
  tier             — 1, 2, or 3 (Phase 2 only; null for Phase 1 actions)
  metadata         — JSON; context-specific detail (e.g. OOO return date, classifier error)
  created_at

action_taken values:
  Phase 1 (process-reply.ts direct actions):
    suppress             — prospect suppressed in Instantly (opt-out, negative reply)
    ooo_log              — out-of-office detected; sequence paused, resume date noted
    send_reply           — Tier 1 auto-reply sent (positive_direct_booking, high confidence)
    log_only             — signal logged but no action taken (e.g. positive reply below routing threshold)
    classifier_failed    — LLM classifier threw or returned invalid output; signal quarantined
    permanently_failed   — signal exceeded max retries or entered unrecoverable state

  Phase 2 (orchestrator-triggered):
    drafted              — Tier 2 or Tier 3 AI draft created; waiting for operator approval
    manual_required      — Tier 3 signal routed to operator without a draft (escalation)
    draft_failed         — draft-orchestrator circuit-breaker fired (3+ agent_runs failures
                           in 24h); placeholder row created so signal is not silently lost

RLS:
  Operator: full access
  Client:   no access

---

## Table: job_queue

**What it holds.** One row per prospect per unit of slow, money-spending work. Added
2026-08-24. Three job types: `enrich` (Apollo), `research` (Apify plus Anthropic) and
`compose` (Anthropic). Document generation is **not** queued: those agents run once per
client, not once per prospect.

**Why this exists.** All three used to run inside a single web request. Vercel kills any
request at 300s, and research is measured at 46.8s per prospect, so one request admitted
about five prospects. That capped the whole volume plan at a few prospects per click.

**Why it is not `agent_runs`.** Read this before proposing a merge; the overlap is
superficial. `agent_runs` is a history table, written after the fact to record that
something ran. It has no claim state, no lease, no attempt count and no spend record,
and those four are the entire substance of a durable queue. Adding them would give one
table two meanings. `agent_runs` stays as the history and both are written during a job:
`agent_runs` answers "what did we run and when", `job_queue` answers "what is owed, who
holds it, what has it cost, and what happens next".

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `job_type` | text NOT NULL | `'enrich'`, `'research'` or `'compose'`, enforced by CHECK. |
| `organisation_id` | uuid NOT NULL | Agent isolation, and the per-organisation fairness key. `ON DELETE CASCADE`. |
| `prospect_id` | uuid NOT NULL | The target. `ON DELETE CASCADE`: a job for a deleted prospect has nothing to act on. |
| `state` | text NOT NULL | `queued` / `claimed` / `done` / `failed` / `cancelled`, enforced by CHECK. Default `queued`. |
| `claimed_by` | text | Which worker invocation holds it. Cleared on reclaim. |
| `lease_expires_at` | timestamptz | The claim expiry. A dead worker's job is reclaimable once this passes. |
| `attempts` | integer NOT NULL | Incremented **at claim time**, not at completion. |
| `max_attempts` | integer NOT NULL | Per row, so an expensive job type can be capped tighter with no code change. Default 3. |
| `run_after` | timestamptz NOT NULL | Backoff schedule. The claim only sees rows where this has passed. |
| `last_error` | text | Mandatory on `failed`, enforced by CHECK. |
| `last_error_class` | text | `'transient'` or `'permanent'`, classified at the point of failure. |
| `spend_recorded_at` | timestamptz | **The pay-before-work stamp.** Non-null means a paid call already returned for this job. |
| `spend_detail` | jsonb | Credits, tokens, actor run id. Deliberately unconstrained, see below. |
| `result_summary` | text | |
| `enqueued_by` | text | Which surface enqueued it, for the flag rollback story. |
| `created_at`, `updated_at` | timestamptz | |

**Indexes.** `UNIQUE (job_type, prospect_id) WHERE state IN ('queued','claimed')` is the
idempotency spine: one live job per target per type, enforced by the database rather
than by application logic, so a double click collapses to one row. It is partial, so a
finished job never blocks a later deliberate re-run. Plus a partial claim index on
`(job_type, organisation_id, run_after, created_at) WHERE state='queued'`, a partial
lease index for reclaim, a monitoring index, and a plain `prospect_id` index so the
cascade delete does not sequentially scan.

**Why `spend_detail` has no constraint tying it to `spend_recorded_at`.** It is tempting
to require that a stamped row also carries detail. Do not add it. The stamp is written
in the microseconds after money leaves the account, and a constraint violation at that
exact moment would abort the one write that prevents paying twice. The recording path
must be incapable of throwing.

**How re-spend is prevented.** `record_job_spend()` writes `spend_recorded_at` the
instant a paid call returns, before any parsing, mapping or database write that can
throw. This is the fix pattern from commit 3de0589, where a crash mid-job left work
claimable and payable twice: 141 Apollo credits for 29 prospects on 10 August 2026,
against a ceiling of one per contact. When a worker claims a job that already has
`spend_recorded_at` set, it does **not** call the paid API. The job goes straight to
terminal `failed`, because a response we already paid for cannot be reconstructed and
calling again is precisely the bug.

**Database functions.** All eight are `SECURITY DEFINER` and callable only by
`service_role`: `enqueue_job`, `claim_jobs`, `queue_next_organisations`,
`record_job_spend`, `complete_job`, `fail_job`, `reclaim_expired_jobs`, and
`job_queue_backoff`. `claim_jobs` is a single `UPDATE ... RETURNING` using
`FOR UPDATE SKIP LOCKED`, never a `SELECT` followed by an `UPDATE`, which is what makes
two concurrent workers take disjoint sets. Backoff lives in SQL in one function so
reclaim and fail cannot drift apart.

**RLS.** Enabled with **zero policies**, the same shape as `suppressed_emails`.
`anon` and `authenticated` are revoked at both the table and the function grant level;
`service_role` holds SELECT, INSERT and UPDATE. There is no client-facing surface for
this table and there must never be one.

**A trap worth knowing about.** `REVOKE ... FROM PUBLIC` is **not sufficient** for
functions in the public schema on Supabase. `ALTER DEFAULT PRIVILEGES` has already
granted EXECUTE to `anon` and `authenticated` explicitly, so revoking `PUBLIC` is a
silent no-op. The roles must be named. This was caught during the C1 verification step,
when `has_function_privilege` showed `anon` still holding EXECUTE on all eight
`SECURITY DEFINER` functions, and fixed in
`20260824160500_job_queue_revoke_anon_authenticated.sql`. Always verify with
`has_function_privilege` for `anon` and `authenticated`, not just for the intended caller.

---

## Table: system_flags

**What it holds.** Explicit rollout flags, one row per key. Added 2026-08-24 alongside
`job_queue`.

| Field | Type | Notes |
|---|---|---|
| `key` | text | primary key, e.g. `queue_enrich` |
| `enabled` | boolean NOT NULL | Default **false**, which means the existing inline path runs. |
| `note` | text | Plain English. Humans read this table when deciding whether to flip something. |
| `updated_at` | timestamptz | |
| `updated_by` | text | Free text, not a FK: may be a person, a script, or the credit-exhaustion circuit breaker. |

**Current keys.** `queue_enrich`, `queue_research`, `queue_compose`. All false until each
job type is proven live. Flipping one back is a single UPDATE with no deploy.

**Why a database flag and never an environment variable.** Per CLAUDE.md, mode is never
inferred from `NODE_ENV`, `VERCEL_URL`, or the presence of a key. Inferred modes cannot
be audited, cannot be flipped without a deploy, and drift silently from whatever the UI
claims. Same discipline as `enrichment_live`.

**Why not `integrations_registry.config`.** That table is keyed by capability and holds
tool configuration. Queue rollout is not a capability and has no vendor. Putting it
there would repeat the one-table-two-meanings mistake described under `job_queue`.

---

## What to check if something breaks

1. "I can see data I shouldn't"
   → Check RLS is enabled on the table (list_tables via MCP)
   → Check the policy for that table allows the right role
   → Check get_my_organisation_id() is returning the correct org

2. "I can't see data I should be able to see"
   → Check the user has a row in public.users with the correct organisation_id
   → Check the user's role matches what the policy expects
   → Check the data actually exists in the table

3. "Supabase is returning nothing and there's no error"
   → RLS is silently blocking the query — this is working as intended
   → Add is_operator() check or organisation_id filter to your query

4. "I need to run a query as admin to fix data"
   → Use the service role key server-side — it bypasses RLS
   → Never expose the service role key client-side
