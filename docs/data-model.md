# data-model.md — Database Tables, Fields, RLS Policies
# Last updated: April 2026 — client_organisation_view added; client direct SELECT on organisations removed
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
  pipeline_unlocked   — whether the pipeline view is visible to the client
  pipeline_unlock_at  — when the unlock trigger was met
  meetings_count      — running count of qualified meetings booked
  created_at / updated_at

RLS:
  Operator: full access (read, write, update all rows) — queries organisations directly.
  Client:   NO direct SELECT access. Must use client_organisation_view (see below).
            The client SELECT policy (clients_read_own_organisation) was dropped so
            that sensitive fields are blocked at the database layer, not just in code.

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

How it works:
  The view is security_invoker=false (runs as postgres superuser), so it can read from
  organisations even though clients have no direct SELECT policy on that table.
  The WHERE clause (id = get_my_organisation_id()) is the security boundary —
  each client user sees only their own organisation row.

Permissions:
  SELECT granted to: authenticated (operators and clients)
  Operators will typically query organisations directly for full field access.
  Only clients are restricted to this view.

If you add a new operator-only field to organisations:
  Do not add it to this view. It will remain invisible to clients automatically.

If you add a new client-safe field to organisations:
  Add it to the SELECT list in the view definition (re-run the CREATE OR REPLACE VIEW).

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
  last_updated_at — when last changed
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
  personalisation_trigger — the Trigger-Bridge-Value output from research
  research_source         — apollo / web_search / website / pain_proxy
  suppressed              — true means no further contact, ever
  suppressed_at / suppression_reason
  created_at / updated_at

RLS:
  Operator: full access
  Client:   no access (prospects never exposed to clients directly)

---

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
