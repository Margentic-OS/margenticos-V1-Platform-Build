# agents.md — Agent Documentation
# Last updated: April 2026
# Written for non-developers. Update whenever an agent is added or its output changes.
# The spec is in /prd/sections/06-agents.md — this is the living reference.

---

## Agent isolation rules — always active

Every agent call must pass organisation_id as a required parameter.
Every database query must include an explicit .eq('organisation_id', organisation_id) filter.
RLS handles the database layer. The application filter is a second, explicit enforcement layer.
Agent prompts must not reference any data outside the current client's context.

Agents are stateless. No module-level variables. All state passed as explicit parameters.
Each agent has one entry point file. No shared dispatcher.

---

## Output pattern — all document generation agents

All four document generation agents follow the same output pattern:
  - Write to document_suggestions only — never to strategy_documents directly
  - field_path: 'full_document' — suggests a complete document replacement, not a field-level patch
  - suggested_value: the full document content as a JSON string
  - status: 'pending' — Doug approves before anything reaches strategy_documents
  - Returns: { suggestion_id: string, organisation_id, document_type, status: 'pending' }

The approval handler reads the suggestion and creates the strategy_documents row.
See the Approval Handler section below.

---

## Approval Handler

Not an agent — a pair of API routes that promote or discard suggestions.
This is the only path by which strategy_documents rows are created or updated.

Routes:
  POST /api/suggestions/[id]/approve  →  src/app/api/suggestions/[id]/approve/route.ts
  POST /api/suggestions/[id]/reject   →  src/app/api/suggestions/[id]/reject/route.ts

Approve flow (atomic via Postgres function approve_document_suggestion):
  1. Verify suggestion exists and is 'pending'
  2. Archive any currently active strategy_document for the same org + document_type
  3. Insert a new strategy_document with status 'active', version = prior version + 1
     (version 1 if no prior document exists)
  4. Mark suggestion 'approved', reviewed_at = now(), reviewed_by = operator user id
  If any step fails, the whole transaction rolls back — suggestion returns to 'pending'.

Reject flow (simple update, no transaction needed):
  Mark suggestion 'rejected', reviewed_at = now(), reviewed_by = operator user id.
  No document changes.

Messaging special case:
  The messaging agent writes { emails: [...] } in suggested_value (ADR-012).
  The approval handler stores the emails array as the strategy_document content,
  not the wrapper object. All other document types store suggested_value directly.

Version numbering:
  Integer only ("1", "2", "3"). The PRD specifies decimals ("1.0") — intentional
  deviation recorded in the Postgres function and in ADR-013.

What to check if approve fails:
  - 'Suggestion not found or not in pending status' → suggestion was already actioned
  - 'suggested_value is not valid JSON' → the generating agent wrote malformed JSON
  - 'Messaging suggestion is missing the emails key' → messaging agent output format changed
  - Supabase RPC error → check the approve_document_suggestion function in the database

---

## ICP Generation Agent

Entry point:  src/agents/icp-generation-agent.ts
API route:    POST /api/agents/icp
Prompt file:  docs/prompts/icp-agent.md
Model:        claude-opus-4-6
Max tokens:   8192

Purpose: Generate the Ideal Client Profile document using the JTBD + Four Forces + Tier framework.

Dependencies: None — runs first in the generation sequence.

Inputs:
  - intake_responses for this organisation
  - Existing ICP document (if is_refresh: true)
  - patterns table (cross-client, read-only, may be empty in phase one)
  - 4 web research queries derived from intake data (buyer pain, trigger events, buyer profile, competitive landscape)

Output (1 row in document_suggestions):
  field_path:      'full_document'
  suggested_value: JSON string — JTBD statement, summary, 3 tiers (Ideal / Good / Do Not Target).
                   Each tier: company_profile, buyer_profile, four_forces (push/pull/anxiety/habit),
                   triggers, switching_costs, disqualifiers.

What to check if it fails:
  - ANTHROPIC_API_KEY not set → agent throws before calling Claude
  - No intake responses → agent throws before web research
  - Claude returns non-JSON → agent throws after stripping markdown fences
  - Supabase insert error → check RLS on document_suggestions

---

## Positioning Generation Agent

Entry point:  src/agents/positioning-generation-agent.ts
API route:    POST /api/agents/positioning
Prompt file:  docs/prompts/positioning-agent.md
Model:        claude-opus-4-6
Max tokens:   8192

Purpose: Generate the Positioning document using the April Dunford "Obviously Awesome" framework.

Dependencies: Active ICP document must exist (status = 'active' in strategy_documents).
              Throws with a specific error if missing or not active.

Inputs:
  - intake_responses for this organisation
  - Active ICP document (required, used as primary anchor)
  - Existing Positioning document (if is_refresh: true)
  - patterns table (cross-client, read-only)
  - 4 competitor-focused web research queries

Output (1 row in document_suggestions):
  field_path:      'full_document'
  suggested_value: JSON string — competitive_alternatives, unique_attributes, value_themes,
                   best_fit_characteristics, moore_statement, market_category, key_messages.

---

## Tone of Voice Generation Agent

Entry point:  src/agents/tov-generation-agent.ts
API route:    POST /api/agents/tov
Prompt file:  docs/prompts/tov-agent.md
Model:        claude-opus-4-6
Max tokens:   8192

Purpose: Extract and codify the client's genuine voice from writing samples.

Dependencies: None — runs independently of ICP and Positioning.

Inputs:
  - intake_responses for this organisation, particularly:
      voice_samples (critical — the primary input)
      voice_style (how they describe their own communication)
      voice_dislikes (phrases and styles they dislike)
  - Existing TOV document (if is_refresh: true)
  - patterns table (cross-client, read-only)
  - No web research — TOV is extracted from samples, not market data

Output (1 row in document_suggestions):
  field_path:      'full_document'
  suggested_value: JSON string — voice_characteristics, vocabulary_patterns, rhythm_markers,
                   do_dont_list, before_after_examples, contradiction_notes (if samples conflict
                   with voice_style self-description).

What to check if it fails:
  - voice_samples field is empty → agent warns but proceeds; quality will be lower
  - Thin samples (<100 words total) → agent flags in suggestion_reason

---

## Messaging Playbook Generation Agent

Entry point:  src/agents/messaging-generation-agent.ts
API route:    POST /api/agents/messaging
Prompt file:  docs/prompts/messaging-agent.md
Model:        claude-opus-4-6
Max tokens:   8192

Purpose: Generate a 4-email cold outreach sequence by synthesising ICP, Positioning, and TOV.

Dependencies: All three of the following must exist with status = 'active' in strategy_documents:
  - ICP document
  - Positioning document
  - Tone of Voice guide
  Throws with a specific message naming each missing or unapproved document.

Pre-flight checks (run before any generation work):
  - organisation name (from organisations table) — used in email context
  - sender first name (from display_name of operator user) — used on sign-off line
  - company_name (from intake_responses) — required for email copy
  If any of these are missing, the agent aborts with a plain English error listing each problem.

Inputs:
  - intake_responses for this organisation
  - Active ICP, Positioning, and TOV documents (all three in full)
  - Existing Messaging document (if is_refresh: true)
  - patterns table (cross-client, read-only)
  - No web research — market intelligence was incorporated at ICP and Positioning stages

Output (1 row in document_suggestions):
  field_path:      'full_document'
  suggested_value: JSON string — { emails: [ EmailRecord, EmailRecord, EmailRecord, EmailRecord ] }
                   Each EmailRecord: { sequence_position, subject_line (nullable), subject_char_count,
                   body, word_count }

  All four emails are stored together in one suggestion row, not as four separate rows.
  This matches the full_document pattern of every other document generation agent.
  The approval handler reads emails[0..3] from suggested_value to construct the strategy_documents row.

What to check if it fails:
  - Pre-flight check failure → 422 response with plain English list of missing fields
  - Missing dependency documents → 422 response naming each problem
  - Claude returns non-array JSON or wrong count → agent throws before writing anything

---

## Reply Draft Orchestrator (Group 4, May 2026)
Entry point: src/lib/reply-handling/draft-orchestrator.ts
Not an agent — deterministic code per ADR-018.

Purpose:
  Called by process-reply.ts for every reply that is not Tier 1 auto-actioned.
  Runs the routing decision, loads org context, checks failure state, calls the
  reply-draft-agent, and writes the result to reply_drafts. Writing to DB is
  the orchestrator's responsibility — the reply-draft-agent does not write.

Inputs (OrchestratorInput):
  signal           — full signal row (includes original_outbound_body captured at polling time)
  classification   — { intent, confidence, reasoning } from reply-classifier
  prospectId       — for reply_drafts and agent_runs logging (may be null)
  supabase         — authenticated Supabase client

Outputs (OrchestratorResult — discriminated union):
  { kind: 'drafted'; reply_draft_id; tier: 2 | 3 }             — draft written, pending operator review
  { kind: 'manual_required'; reply_draft_id; reason }           — placeholder row, no draft
  { kind: 'draft_failed'; reply_draft_id; failure_count }       — circuit breaker placeholder
  { kind: 'log_only' }                                           — intent has no draft value (unknown intent)

Steps (in order):
  1. FAQ matching via findFaqMatches() — errors propagate (no catch per ADR-018)
  2. routeIntent() — pure deterministic routing function
  3. Tier 1 guard — throws if Tier 1 intent reaches orchestrator (caller error)
  4. log_only guard — returns immediately without DB writes
  5. Idempotency check — returns existing reply_drafts row if one exists for this signal
  6. Circuit breaker — if ≥3 agent_runs failures in last 24h, writes draft_failed placeholder
  7. Org context — loadOrgContext(); if null, writes manual_required placeholder
  8. Outbound body check — if signal.original_outbound_body is null/empty, writes manual_required
  9. Drafter call — draftReply() from reply-draft-agent
  10. Null drafter result — returns log_only (signal marked processed, no draft written)
  11. Success — writes reply_drafts row with status='pending'

Manual required reasons:
  org_context_missing               — active TOV or Positioning doc absent or too thin (< 50 non-whitespace chars)
  original_outbound_not_captured    — signal.original_outbound_body was null/empty at polling time

What to check if it breaks:
  - draft_failed appearing frequently → check agent_runs for reply-draft-agent failures in 24h
  - manual_required (org_context_missing) → check strategy_documents for active TOV + Positioning rows
  - manual_required (original_outbound_not_captured) → outbound body fetch failed at polling time;
    check signals.original_outbound_body for recent reply signals; check Instantly API logs
  - Throws on Tier 1 intent → check process-reply.ts routing block; must not call orchestrator on opt_out/ooo/positive ≥0.90

Supporting modules:
  src/lib/reply-handling/load-org-context.ts  — loads TOV, Positioning, org name, sender first name
  src/lib/reply-handling/route-intent.ts      — pure routing function with KNOWN_INTENTS guard
  See ADR-019 Appendix for full intent-to-tier mapping table.

---

## Reply Draft Agent
Entry point: src/lib/agents/reply-draft-agent.ts
Model: claude-sonnet-4-6
Prompt: docs/prompts/reply-draft-agent.md (version tracked via PROMPT_VERSION constant)

Purpose:
  Given a classified prospect reply, generates a draft response for the operator to review.
  Operates in two tiers:
    Tier 2 — send-ready draft the operator may approve without changes
    Tier 3 — starting point requiring operator rewrite before sending

  The agent does NOT write to reply_drafts or agent_runs — that is the caller's responsibility
  (Group 4 reply handler). The agent returns a typed result or null.

Inputs (ReplyDrafterInput):
  organisationId        — required for agent isolation
  organisationName      — used in voice framing
  senderFirstName       — operator's first name (signs the email)
  prospectReplyBody     — the reply to respond to
  originalOutboundBody  — the email the prospect is replying to
  classification        — { intent, confidence, reasoning } from classifier
  tierHint              — tier routing decision from Group 4 caller (2 or 3)
  orgContext            — { tovDocument, positioningDocument } pre-loaded by caller
  faqMatches            — top-N FAQ candidates already scored by findFaqMatches()
  includeCalendlyHint   — whether to weave a soft CTA toward booking
  signalId              — used for idempotency check and agent_runs logging
  prospectId            — for agent_runs logging (may be null)
  supabase              — authenticated Supabase client

Outputs (ReplyDrafterOutput — discriminated union on tier):
  Tier 2: { tier:2, draft_body, faq_ids_used, confidence_at_draft, prompt_version }
  Tier 3: { tier:3, draft_body, ambiguity_note, alternative_directions, downgraded_from_tier, prompt_version }
  null   — API error, parse failure, or tier mismatch (see tier mismatch rule below)

Tier downgrade rules (agent may downgrade Tier 2 → Tier 3, never upgrade):
  - Reply contradicts itself (opt-in AND opt-out in same message)
  - Reply is one word or minimal (insufficient signal to draft well)
  - Reply is in a non-English language
  - Reply appears sarcastic (words positive, tone hostile)
  - Commercial question (pricing, contracts) — Tier 3 regardless of FAQ match
  - Prospect references context the agent cannot verify (e.g. "case study you sent")

Tier mismatch rule:
  If tierHint=3 and the model returns tier=2, draftReply() returns null and logs the
  mismatch. Tier 3 routing is a deliberate fitness decision made upstream — the agent
  cannot override it.

FAQ usage:
  FAQs scoring ≥0.65 (FAQ_USE_THRESHOLD) are treated as authoritative source material.
  Their IDs are listed in faq_ids_used. FAQs below the threshold are ignored even if
  passed in. The threshold constant lives in reply-draft-agent.ts.

Idempotency:
  On entry, checks reply_drafts for an existing row with the same signal_id.
  If found, returns null immediately (does not regenerate). The caller logs this as
  skipped_idempotent in agent_runs.

What to check if it breaks:
  - Returns null → check agent_runs for status and error_message for that signal_id
  - Tier always 3 on Tier 2 inputs → inspect coherence check or FAQ threshold
  - Draft body contains em dashes or AI tells → scrubAITells() should have caught them;
    check that the import from customer-facing-style-rules.ts is still correct
  - API timeout → check TIMEOUT_MS constant (30000ms); Sonnet is usually fast for short drafts
  - Tier 3 missing faq_ids_used field: defaults to [], logs warning.
    Not treated as a hard failure. Commercial drafts should always
    have this populated; check warnings in agent_runs if commercial
    audit trail looks thin.
  - Minimum word count is 10 (deliberately low). Drafts shorter than 10
    words return null. Some legitimate replies are correctly short
    (booking confirmations, minimal Tier 3 starting points) — the floor
    is set to allow these while still catching malformed/stub outputs.

---

## FAQ Extraction Agent

Entry point:  src/lib/agents/faq-extraction-agent.ts
Prompt file:  docs/prompts/faq-extraction-agent.md
Model:        claude-haiku-4-5-20251001
Max tokens:   1024

Purpose: Extract FAQ candidates from sent Tier 3 replies. Captures the prospect's
question and the operator's actual sent answer as a candidate FAQ entry. Operator
curates in Group 7's curation UI before any candidate becomes a canonical FAQ.

Dependencies:
  - src/lib/faq/filler-detection.ts (deterministic skip gate — runs before Haiku)
  - src/lib/faq/name-detection.ts (deterministic name flagging in post-processing)
  - src/lib/faq/matcher.ts (similarity check with includePendingExtractions=true)
  - Caller (Group 4) provides the reply_drafts row data and the positioning document.

Inputs (FaqExtractionInput):
  organisationId            — required for isolation
  organisationName          — used in prompt context
  replyDraftId              — for idempotency check and agent_runs logging
  prospectQuestionContext   — the prospect's full reply text
  originalOutboundBody      — the email the prospect was replying to
  operatorAnswer            — the final_sent_body from reply_drafts
  aiDraftBody               — the ai_draft_body from reply_drafts (for unedited-draft gate)
  orgPositioningDocument    — for niche-language scrubbing in the prompt
  supabase                  — authenticated Supabase client

Outputs: FaqExtractionResult[]. Empty array is valid (skip case or no extraction warranted).
  Each result: { extracted_question, captured_answer, similar_faq_id,
                 similar_pending_extraction_id, similarity_score,
                 potential_names_flagged, prompt_version }

DB column note: captured_answer in FaqExtractionResult maps to suggested_answer in
faq_extractions. The caller (Group 4) maps captured_answer → suggested_answer on insert.

The agent does NOT write to faq_extractions. Caller writes.

Idempotency: checks agent_runs before any work. If a previous successful run exists
for the same replyDraftId (found via LIKE on output_summary), returns [] immediately.

Similarity flagging: after Haiku extracts a Q&A pair, findFaqMatches() runs with
includePendingExtractions=true. If the top match scores >= 0.45:
  - approved FAQ match → similar_faq_id populated
  - pending extraction match → similar_pending_extraction_id populated
  Scores below 0.45 → all three null. Operator reviews these signals in the curation UI.

Multi-tenant defensive check: for every similarity match, the agent verifies the
matched row's organisation_id equals the input organisationId before returning it.
Mismatch triggers a critical error log and returns []. Defence in depth per ADR-003.

Skip cases (returns [] without calling Haiku):
  - Filler-detection gate: answer < 20 words, filler prefix, question-dominated,
    calendly-only, operator-did-not-edit-AI-draft (Jaccard similarity > 0.95).
  - Idempotency hit: previous successful run found for this replyDraftId.
  - Haiku decided no extraction: vague prospect question, hostile reply,
    operator pivoted away from the question, invented context referenced.

Failure modes (returns []):
  - Pre-flight check failure → agent_runs status='failed'.
  - Gate skip → status='skipped' with reason in output_summary.
  - Idempotency hit → status='skipped_idempotent'.
  - ANTHROPIC_API_KEY not set → status='failed'.
  - LLM API error or timeout (15s) → status='failed'.
  - Malformed JSON or schema violation → status='failed'.
  - Multi-tenant safety check failure → status='failed' (critical error logged).

Testing: run `npm run test-extractor` for end-to-end fixture review.
Run `npm run test-filler-detection` for unit-style checks on the gate.

---

## Send Orchestrator

Not strictly an agent (no LLM call) — a deterministic orchestrator that executes the
send of an operator-approved reply draft.

Entry point: src/lib/reply-handling/send-approved-draft.ts
Called by: POST /api/reply-drafts/[id]/approve immediately after draft status is set to 'approved'.

**Purpose:** Translate an approved reply_draft row into a sent Instantly thread reply,
with idempotency, validation, sign-off, and post-send extraction.

**Inputs:**
- replyDraftId — UUID of the reply_drafts row
- supabase — service-role client (passed from the API route)

**10-step flow:**
1. Load draft + idempotency check (already sent/failed → skip)
2. Validate status === 'approved' and final_sent_body non-empty
3. Load org context (name, founder_first_name, calendly_url)
4. Calendly substitution — replace {calendly_link} or fail if placeholder present but URL null
5. Sign-off insertion — append founder first name per ADR-020 (idempotent: no double sign-off)
6. Load thread context from signal (raw_data.id, raw_data.eaccount, raw_data.subject)
7. Load Instantly API key from env
8. Send via Instantly sendThreadReply with 20s AbortController ceiling
9. Atomic DB update (UPDATE WHERE status='approved' — concurrent call guard)
10. Tier 3 only: post-send FAQ extraction via extractFaq (best-effort, never blocks send result)

**Result types:**
- `{ kind: 'sent', instantly_message_id: string | null }`
- `{ kind: 'send_failed', error: string, reason: SendFailedReason }`
- `{ kind: 'idempotent_skip', reason: string }`

**SendFailedReason values:**
- `founder_first_name_required_but_missing` — organisations.founder_first_name not set
- `calendly_link_required_but_missing` — {calendly_link} in body but org has no calendly_url
- `final_sent_body_empty` — final_sent_body is blank after trim
- `thread_context_missing` — signal row missing or raw_data lacks id/eaccount
- `instantly_api_error` — Instantly API returned non-2xx or threw
- `instantly_timeout` — 20s AbortController fired
- `unexpected_state` — draft not found, or unexpected status at entry
- `db_update_failed_after_send` — CRITICAL: email sent but DB row not updated

**Failure invariant:** The function never returns while the draft is in status='approved'.
Every exit path either transitions to 'sent' or 'send_failed'.

**db_update_failed_after_send:** The most critical failure mode. The email IS in the
prospect's inbox but the row is inconsistent. A CRITICAL log entry triggers the
db-update-failed-after-send-CRITICAL Sentry alert rule for manual reconciliation.

**Isolation:** Multi-tenant safe — all queries are scoped to the draft's organisation_id.
Cross-org access is blocked at the API layer (the approve endpoint), not here.

**Testing:** `npm run test-send-approved-draft` — 17 integration tests using mock Supabase stubs.
Covers: not-found, idempotent (sent/failed), wrong status, empty body, missing founder name,
missing calendly, missing thread context, network failure, no-double sign-off variants.

---

## Agents not yet built (phase two and beyond)

Prospect Research Agent   — entry point: prospect-research-agent.ts
                            Model: claude-haiku-4-5-20251001
                            Finds one Trigger-Bridge-Value personalisation trigger per prospect.

Signal Processing Agent   — entry point: signal-processing-agent.ts
                            Model: claude-haiku-4-5-20251001
                            Logs and categorises incoming campaign signals. Phase one: no threshold logic.

Pattern Aggregation Agent — entry point: pattern-aggregation-agent.ts
                            Model: claude-haiku-4-5-20251001
                            The only agent that may write to the patterns table. Runs on a schedule.

Reply Handling Agent      — entry point: reply-handling-agent.ts
                            Model: claude-haiku-4-5-20251001
                            Classifies replies and executes positive reply auto-response.
                            Phase one: positive replies only.
