# sections/15-sourcing.md — Prospect sourcing pipeline
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when building or modifying any
# part of the prospect sourcing, qualification, TAM, or tiering pipeline.
# Paired ADRs: ADR-015 (filter spec), ADR-016 (TAM + inventory), ADR-017 (tiered routing).

---

## Purpose

The sourcing pipeline gets qualified prospects into the prospects table, at the
volume needed to deliver each client's meeting targets, without manual CSV import,
without cross-client data leakage, and with the tool used for sourcing being
swappable per ADR-001.

---

## The five components

1. ICP Filter Specification — structured filter criteria produced by the ICP agent
2. Sourcing Orchestrator — deterministic code that runs sourcing against a handler
3. Inventory Monitor — deterministic scheduled job that triggers sourcing
4. TAM Report + Gate — pre-sale and post-intake TAM checks with green/amber/red
5. Tiering — Tier 1 / Tier 2 / Tier 3 classification and tier-aware downstream routing

Each component is described below. All five respect agent isolation (ADR-003) —
client_id flows through every call, every query, every log.

---

## 1. ICP Filter Specification

The ICP generation agent produces two artefacts:
  - The ICP strategy document (human-readable, in strategy_documents)
  - The ICP Filter Specification (structured, stored alongside)

Both are approved in the same approval review. The document is the client's IP.
The filter spec is the machine-readable version used for sourcing.

### Schema (v1)

Fields universally supported across tier-1 B2B data providers:
  job_titles                  array of strings
  job_titles_excluded         array of strings
  seniority_levels            array: c_suite, vp, director, manager, senior, entry
  departments                 array of strings
  person_countries            array of ISO-3166 alpha-2 codes
  company_countries           array of ISO-3166 alpha-2 codes
  company_headcount_min       integer
  company_headcount_max       integer
  industries                  array of canonical names (NAICS-derived)
  industries_excluded         array of canonical names
  keywords                    array of company-descriptor strings
  keywords_excluded           array of company-descriptor strings

Fields supported by most tier-1 providers:
  company_revenue_min         integer, optional
  company_revenue_max         integer, optional
  company_age_min_years       integer, optional
  company_age_max_years       integer, optional
  technologies_used           array, optional
  funding_stage               array, optional
  funded_since                ISO date, optional

Meta:
  notes                       freetext, operator-only

### Canonical industries

Internal storage uses NAICS-derived canonical names (e.g. "Management Consulting",
"Software Publishers", "Marketing Consultancy"). Each sourcing handler owns its
translation table from canonical names to tool-specific names. Doug never sees
NAICS codes; the UI displays canonical names.

### Handler capability manifest

Every sourcing handler declares a supported_fields manifest — the subset of the
filter spec fields it can apply as filters. The Sourcing Orchestrator checks the
active handler's manifest against the client's approved spec before each run.
If a spec field is unsupported by the handler, the run fails loudly with a
specific operator warning.

### Storage

Added to strategy_documents when document_type = 'icp':
  icp_filter_spec    jsonb    the structured spec object

When a new ICP version is approved, a new strategy_documents row is created with
its own icp_filter_spec. The sourcing pipeline always reads the current active
version.

---

## 2. Sourcing Orchestrator

Entry point: src/lib/sourcing/orchestrator.ts
Type: deterministic code (not an agent, no LLM call)

### Inputs
  client_id (required)
  trigger_type: 'inventory_monitor' | 'operator_manual'
  target_batch_size: integer (default calculated from inventory ceiling)

### Flow

  1. Read the active ICPFilterSpec for this client (most recent approved ICP
     with document_type = 'icp').
  2. Read the active sourcing handler from integrations_registry (is_active=true
     for capability 'can_source_prospects').
  3. Check handler.supported_fields against spec fields in use. If unsupported
     fields are in use, abort with OperatorWarning and log to agent_runs.
  4. Translate the spec into the handler's native filter format via the handler's
     adapter function.
  5. Call the handler to execute the search. Handler returns a list of
     ProspectCandidate objects in a standard normalised shape.
  6. For each candidate, run tier classification (see section 5 below).
  7. For candidates classified as Tier 1 or Tier 2 (or Tier 3 if enabled for
     this client), write to prospects table with sourced_tier and qualified_at.
  8. Discard candidates that don't meet any active tier.
  9. Log the run to agent_runs with counts per tier and total discards.

### Agent isolation

Every step passes client_id. No cross-client queries. Standard agent_runs logging
includes client_id.

---

## 3. Inventory Monitor

Entry point: src/lib/sourcing/inventory-monitor.ts
Type: deterministic code, scheduled job
Frequency: daily

### Flow per client

  1. Count unused qualified prospects (prospects where client's organisation_id
     matches, sourced_tier is not null, not yet added to a campaign,
     suppressed = false).
  2. Read send_velocity_per_day from the organisations table.
  3. Calculate days_of_inventory = unused_qualified_count / send_velocity_per_day.
  4. Evaluate thresholds:
       days_of_inventory < 10 business days  → trigger Sourcing Orchestrator
       days_of_inventory > 40 business days  → do not trigger even if other
                                               triggers fire (ceiling cap)
       otherwise                             → no action

  5. Log each client's inventory state to agent_runs.
  6. Emit daily summary to operator digest email.

### Target batch size

When triggering sourcing, the Monitor passes a target batch size calculated as:
  target = (40 - current_days_of_inventory) * send_velocity_per_day

This fills inventory back up to the ceiling. The Orchestrator may source slightly
over or under this target depending on handler behaviour, but the intent is to
land near the ceiling without going over.

---

## 4. TAM Report and Gate

Two TAM checks run per client:

### 4a. Pre-sale TAM tool (operator dashboard)

UI: new operator dashboard page, /operator/tam-tool

Inputs collected from the operator during a discovery call:
  target job titles (free text, one per line)
  target countries (multi-select)
  company headcount range (min and max)
  target industries (multi-select from canonical names)

Action:
  Constructs an Apollo People API Search query with per_page=1.
  Reads pagination.total_entries from the response.
  Returns the count within 2–3 seconds.
  No Apollo credits consumed (People API Search is free).

Display:
  "~2,100 matching people across ~840 companies"
  (heuristic: ~2.5 DMs per company for headcount-based estimate)

  Classification:
    6+ months of coverage (7,800+ people)      🟢 GREEN
    4–6 months (5,200–7,800 people)            🟡 AMBER
    below 4 months (under 5,200 people)        🔴 RED

  Commercial guidance shown below the count — not as a deliverable for the
  prospect, for Doug.

### 4b. Post-intake TAM report (system-run)

Trigger: when the ICP filter spec is approved via the approval flow.

Action:
  Runs Apollo People API Search against the full approved filter spec.
  Writes tam_status to organisations table.
  Writes tier_3_enabled = true if amber or red-with-override.
  If red without override, does NOT activate the sourcing pipeline.

Operator override:
  If red, the operator may override to accept the client with a recorded reason
  (stored in organisations.tam_override_reason, timestamped, operator user_id
  recorded). This is an auditable commercial decision.

Re-run:
  If the ICP is updated (new approved version), the post-intake TAM report
  re-runs automatically against the new spec. Status updates accordingly.

---

## 5. Tiering

Each client has tier definitions configured at onboarding. Stored in the
organisations table as tier_config (jsonb).

### Tier 1 — Ideal
Match: the full ICPFilterSpec, strictly applied.
No loosening.
Always enabled.

### Tier 2 — Good
Match: the spec with specific fields loosened, defined per client.
Example loosenings:
  company_headcount widened by 50% in both directions
  person_countries expanded to include adjacent geographies
  seniority_levels widened by one step

### Tier 3 — Acceptable (enabled conditionally)
Enabled only if:
  - tam_status = amber, OR
  - tam_status = red AND override recorded
Match: further loosening, defined per client.
Example loosenings:
  drop one of the should_match dimensions entirely
  widen industry list to adjacent categories

### Classification logic (deterministic)

For each candidate returned by the sourcing handler:
  1. Does the candidate match the strict Tier 1 spec? → sourced_tier = 'tier_1'
  2. Else, does the candidate match the Tier 2 loosened spec? → sourced_tier = 'tier_2'
  3. Else, if Tier 3 is enabled, does the candidate match the Tier 3 loosened spec?
     → sourced_tier = 'tier_3'
  4. Else: discard.

No LLM. Rule-based matching against the spec fields.

### Downstream consequences (ADR-017)

Tier 1 → full prospect research agent pipeline → trigger-personalised email 1
Tier 2 → light enrichment only → role-based pain proxy in email 1
Tier 3 → no per-prospect research → fully templated sequence

Sending infrastructure isolation: Tier 3 sends from separate domain pool per
sending-setup runbook.

---

## Operator visibility

### Prospects tab (new, in operator view)

Per client:
  Tier breakdown (Tier 1 / Tier 2 / Tier 3 counts and percentages)
  Total unused qualified inventory
  Days of inventory at current send velocity
  Last sourcing run (timestamp, count, handler used)
  Projected next sourcing run (if inventory floor not yet hit)
  TAM status (green / amber / red)
  Tier 3 enabled (yes/no, with reason)

### Signals log filter

Existing signals log gains a tier filter so signals and metrics can be sliced
by sourced_tier.

### Warnings engine additions

  Tier quality divergence: Tier 3 qualified_meeting_rate < 40% while Tier 1 > 70%
  → warning with recommendation to pause Tier 3 or review criteria

  TAM drift: if post-intake TAM re-runs show a shift from green to amber or
  amber to red, warning surfaces recommending ICP review.

---

## What this section does NOT cover

  Document generation agents (covered in 06-agents.md)
  Reply handling (covered in 06-agents.md and 09-reply-handling.md)
  Sending infrastructure provisioning (covered in /docs/runbooks/sending-setup.md)
  Signal processing and pattern aggregation (covered in 07-feedback-loop.md and 10-signals.md)
  Dashboard component design (covered in 12-dashboard.md)
  Integration registry pattern (covered in 02-stack.md and 13-integrations.md)
