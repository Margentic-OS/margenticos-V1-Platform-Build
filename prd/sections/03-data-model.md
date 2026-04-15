# sections/03-data-model.md — Database Tables, Fields, RLS Policies
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when creating or modifying database tables.
# RLS policies must be written and verified before any application code uses the table.

---

## RLS rule — non-negotiable

For every table:
  1. Write RLS policies first
  2. Verify they work correctly
  3. Only then write application code that uses the table

A client must never be able to read another client's data.
This is enforced at the database level, not just application level.

---

## organisations

The top-level tenant. Each client is one organisation.
MargenticOS itself is the first row (client zero).

  id                  uuid, primary key
  name                text, not null
  slug                text, unique (used in URLs)
  created_at          timestamptz
  contract_start_date date
  contract_status     text (active / paused / churned) — operator view only
  engagement_month    int (months since contract start) — operator view only
  payment_status      text (current / overdue / etc.) — operator view only
  pipeline_unlocked   boolean, default false
  pipeline_unlock_at  timestamptz (set when unlock trigger is met)
  meetings_count      int, default 0 (incremented on each qualified meeting)

RLS: clients can only read their own organisation row.
     Operator can read all rows.
     payment_status, contract_status, engagement_month: never exposed in client-facing queries.

---

## users

  id                  uuid, primary key (matches Supabase Auth user id)
  organisation_id     uuid, foreign key → organisations.id
  email               text, not null
  role                text (operator / client)
  display_name        text
  created_at          timestamptz
  last_seen_at        timestamptz

RLS: users can only read rows belonging to their own organisation_id.
     Operator can read all rows.

Note: Multiple users can belong to one organisation (e.g. founder + EA).
      All users in an organisation see the same client dashboard.

---

## strategy_documents

One row per document per version. Four document types per client.

  id                  uuid, primary key
  organisation_id     uuid, foreign key → organisations.id
  document_type       text (icp / positioning / tov / messaging)
  version             text (e.g. "1.0", "2.1") — always lowercase v, one decimal
  content             jsonb (structured document content)
  plain_text          text (for agent consumption)
  status              text (draft / active / archived)
  generated_at        timestamptz
  last_updated_at     timestamptz
  update_trigger      text (initial / signal_suggestion / intake_update / manual)
  is_stale            boolean, default false (operator flag — 60 days no update while active)

RLS: clients can only read documents for their own organisation_id.
     Agents may never write directly to this table — only via document_suggestions.

---

## document_suggestions

The suggestion queue. Agents write here. Doug approves. Documents version.
Agents never write to strategy_documents directly.

  id                      uuid, primary key
  organisation_id         uuid, foreign key → organisations.id
  document_id             uuid, foreign key → strategy_documents.id
  document_type           text (icp / positioning / tov / messaging)
  field_path              text (dot-notation path to the field being suggested)
  current_value           text
  suggested_value         text
  suggestion_reason       text (plain English explanation from the agent)
  confidence_level        text (low / medium / high) — schema only in phase one
  signal_count            int, default 0 — schema only in phase one
  ab_variant              text, nullable — schema only in phase one
  conflicting_suggestion_id uuid, nullable, self-referencing — schema only in phase one
  status                  text (pending / approved / rejected / superseded)
  created_at              timestamptz
  reviewed_at             timestamptz, nullable
  reviewed_by             uuid, nullable → users.id

Phase one note: signal_count, confidence_level, ab_variant, and conflicting_suggestion_id
fields exist in the schema but the processing logic that populates them is not built
until phase two. See ADR-011 and sections/07-feedback-loop.md.

RLS: operator can read all suggestions.
     Clients cannot read this table.

---

## intake_responses

Stores questionnaire answers for each organisation.

  id                  uuid, primary key
  organisation_id     uuid, foreign key → organisations.id
  field_key           text (unique identifier for the question)
  field_label         text (human-readable question)
  response_value      text
  is_critical         boolean (if true, counts toward the 80% completeness threshold)
  word_count          int (calculated on write — used to detect under-answered critical fields)
  section             text (which questionnaire section this belongs to)
  updated_at          timestamptz
  version             int, default 1 (incremented on meaningful update)

RLS: clients can only read and write their own organisation's intake_responses.
     Operator can read all rows.

---

## signals

Campaign performance events that feed the feedback loop.

  id                  uuid, primary key
  organisation_id     uuid, foreign key → organisations.id
  signal_type         text (email_open / email_reply / email_bounce / email_spam /
                            linkedin_post_like / linkedin_post_comment / linkedin_dm_reply /
                            meeting_qualified / meeting_unqualified / meeting_no_show /
                            opt_out / positive_reply / information_request)
  prospect_id         uuid, nullable → prospects.id
  campaign_id         uuid, nullable → campaigns.id
  raw_data            jsonb (full webhook payload or event data)
  processed           boolean, default false
  processed_at        timestamptz, nullable
  created_at          timestamptz

RLS: operator can read all signals.
     Clients cannot read this table directly (signals surface via dashboard views only).

---

## patterns

Cross-client aggregated insights. Anonymised — never raw client data.
Written ONLY by the dedicated pattern aggregation agent.
No other agent, no application code, no manual query ever writes to this table.

  id                  uuid, primary key
  pattern_type        text (subject_line / opening_line / cta / sequence_length / etc.)
  pattern_data        jsonb (aggregated insight — no client identifiers)
  sample_size         int (number of clients/campaigns contributing to this pattern)
  confidence_score    float
  created_at          timestamptz
  updated_at          timestamptz

RLS: operator and agents can read this table.
     Only the pattern aggregation agent may write to it.

---

## integrations_registry

The tool registry. See sections/02-stack.md for the full pattern.

  id                  uuid, primary key
  tool_name           text (e.g. "Instantly", "Taplio")
  capability          text (e.g. "can_send_email", "can_schedule_linkedin_post")
  is_active           boolean (which tool currently handles this capability)
  api_handler_ref     text (reference to the handler function)
  connection_status   text (connected / disconnected / error)
  config              jsonb (tool-specific configuration, never secrets)
  created_at          timestamptz
  updated_at          timestamptz

RLS: operator only. Clients never read this table.

---

## campaigns

  id                  uuid, primary key
  organisation_id     uuid, foreign key → organisations.id
  campaign_type       text (cold_email / linkedin_post / linkedin_dm)
  external_id         text (ID in Instantly / Taplio / Lemlist)
  status              text (draft / active / paused / completed)
  sequence_name       text
  started_at          timestamptz, nullable
  paused_at           timestamptz, nullable
  created_at          timestamptz

RLS: operator can read all. Clients can only read their own organisation's campaigns
     (surfaced via dashboard views — not raw table access).

---

## prospects

  id                  uuid, primary key
  organisation_id     uuid, foreign key → organisations.id
  first_name          text
  last_name           text
  email               text
  company_name        text
  role                text
  linkedin_url        text, nullable
  personalisation_trigger text, nullable (Trigger-Bridge-Value output)
  research_source     text (apollo / web_search / website / pain_proxy)
  suppressed          boolean, default false
  suppressed_at       timestamptz, nullable
  suppression_reason  text, nullable
  created_at          timestamptz

RLS: operator can read all. Clients cannot read this table.

---

## meetings

  id                  uuid, primary key
  organisation_id     uuid, foreign key → organisations.id
  prospect_id         uuid, foreign key → prospects.id
  booked_at           timestamptz
  meeting_date        timestamptz
  status              text (booked / completed / no_show / cancelled)
  qualification       text (qualified / unqualified / pending)
  qualification_notes text, nullable
  revenue_value       numeric, nullable
  created_at          timestamptz

RLS: operator can read all. Clients can read their own organisation's meetings
     (surfaced via dashboard pipeline view after unlock).
