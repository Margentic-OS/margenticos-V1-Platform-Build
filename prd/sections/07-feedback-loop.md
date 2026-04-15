# sections/07-feedback-loop.md — Signal Thresholds, Suggestion Queue, A/B Testing
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on the feedback loop or suggestion queue.

---

## Phase one scope — what is built and what is deferred

### Phase one: build the infrastructure
  - document_suggestions table with all fields (including those not yet used)
  - Signal logging (signals table, signal processing agent writes signals as processed)
  - Operator view of pending suggestions (Doug reviews manually)
  - Approval/rejection flow for suggestions

### Phase one: schema-only (do not build the processing logic)
  - Signal threshold evaluation (3/5/10 tier logic)
  - A/B test variant generation
  - Conflict resolution between competing suggestions

These three are schema-only in phase one. The fields exist in document_suggestions.
The processing logic is NOT implemented until campaign data makes it meaningful.
Flag to Doug before implementing any of this logic — do not build speculatively.
See ADR-011 for the full reasoning.

### Phase two: build the processing logic
  - 3-signal threshold evaluation (low-confidence suggestion generation)
  - 5-signal threshold evaluation (A/B variant generation)
  - 10-signal + winner threshold evaluation (high-confidence suggestion)
  - Conflict resolution UI when competing suggestions exist for the same field
  - This begins when founding client campaigns have generated meaningful signal volume

---

## Core principle — agents never update documents directly

Agents write to document_suggestions. Doug reviews and approves.
Strategy documents are never updated directly from agent output.

This keeps a human in the loop as quality gate during the period when signal volume
is low and agent judgment is unproven.

The path to full autonomy is additive: add a confidence threshold field, add one condition.
Nothing gets rebuilt. The architecture already supports it.

---

## Suggestion queue — how it works

When an agent determines a strategy document should be updated:
  1. Agent writes a row to document_suggestions with:
     - The document and field being suggested
     - Current value and suggested value
     - A plain English reason for the suggestion
     - signal_count and confidence_level (populated when threshold logic is built in phase two)
  2. Doug sees the pending suggestion in the operator dashboard
  3. Doug reviews: approve → document is versioned with the change; reject → suggestion archived
  4. Client sees only the approved, versioned document — never the suggestion queue

---

## Signal thresholds (phase two specification — schema only in phase one)

Three tiers. The document_suggestions table fields that support this must exist from day one.

  3 signals (same type, unrelated prospects):
    → low-confidence suggestion generated (informational — Doug reviews but no urgency)
    → confidence_level = 'low', signal_count = 3

  5 signals:
    → agent generates an A/B test variant for the next batch
    → ab_variant field populated with the proposed variant
    → confidence_level = 'medium', signal_count = 5

  10 signals + confirmed A/B test winner:
    → high-confidence suggestion generated
    → confidence_level = 'high', signal_count = 10+

---

## A/B testing framework (phase two — deferred)

This framework is specified here for planning. Do not build it in phase one.

OVAT — One Variable At A Time.
Test sequence: subject line → opening line → CTA → sequence length.
Minimum 200 prospects per variant for meaningful results.
Wait 5–7 business days before evaluating.
Winner requires 15–30% relative lift over control.

At small list sizes (<200 per client), treat A/B results as directional signals,
not declared winners. The pattern library across multiple clients compensates
for lack of statistical power at individual client level.

---

## Conflict resolution (phase two — deferred)

When two suggestions exist for the same document field:
  Surface them together in the operator view with three options:
    A) Apply suggestion one
    B) Apply suggestion two
    C) Wait for more signal

  Default is always C. Active choice is required to apply either suggestion.
  conflicting_suggestion_id field links the two competing suggestions.

Do not build this UI in phase one. Build it in phase two alongside threshold logic.

---

## Auto-approve (phase four — do not build)

Auto-approve is phase four only. It adds one field and one condition to the existing
queue processor — the architecture already supports it.
Do not build it in phase one, two, or three.

---

## Document versioning

When a suggestion is approved:
  1. Create a new strategy_documents row with version incremented (e.g. 1.0 → 1.1)
  2. Set the previous version status = 'archived'
  3. Set the new version status = 'active'
  4. Record update_trigger = 'signal_suggestion'
  5. Update last_updated_at
  6. Reset the 60-day operator staleness flag (is_stale = false)

Version format: always lowercase v, always one decimal place (v1.0, v2.1, not V1 or 1.0.0).
