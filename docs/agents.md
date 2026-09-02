# agents.md — Agent Documentation
# Last updated: August 2026
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

## Input pattern — the note that comes with a regeneration

All four document generation agents accept an optional `regeneration_notes` parameter:

    regeneration_notes?: {
      operator_note?: string | null   // why the previous suggestion was rejected
      client_note?: string | null     // the client's original change request
    }

It is set only when the run was started by rejecting a suggestion through
`POST /api/suggestions/regenerate`. A first generation, or a refresh with no rejection
behind it, leaves it undefined and the prompt is byte-identical to what it was before this
existed.

Two shared functions in `src/lib/agents/regeneration-notes.ts` do the work, so the wording
is identical across all four agents and cannot drift:

  buildRegenerationNotesBlock()   the prompt section, appended after the context blocks
  buildRegenerationNotesReason()  the sentence added to suggestion_reason

Why the second one matters: without it, an operator has no way to tell a regeneration that
honoured their note from one that ignored it. That is how the original defect stayed
invisible for as long as it did. See ADR-038 and docs/approval.md.

**Messaging carries the note into retries too.** `regeneration_notes` lives on
`VariantGenerationContext`, which the retry and fallback paths reuse, so a variant that
fails validation and gets rewritten still sees the note. A retry that regenerated without
it would silently undo the fix for that variant only.

**Adding a fifth generation agent** means accepting `regeneration_notes` and calling both
builders, or failing `src/agents/__tests__/regeneration-notes-wiring.test.ts`.

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
  - intake_website_pages for this organisation, via fetchWebsiteContext. Every page with
    fetch_status 'complete' and non-empty text, in display_order, with no cap and no row
    limit. It lands in the prompt after the intake answers and the uploaded documents and
    before the research block. Note the upstream limit: each page was cut at 3,000
    characters when it was FETCHED (src/lib/intake/fetch-website.ts), so the agent sees
    everything that was stored, and what was stored may already be short.
  - 4 web research queries derived from intake data (buyer pain, trigger events, buyer
    profile, competitive landscape) — OR NONE AT ALL. See the skip path below.

How the research queries are built (buildResearchPlan, rewritten 2026-08-29, ADR-043):

  THE BUYER DESCRIPTOR is resolved by `resolveBuyerDescriptor`, in this order, and its
  source is recorded on the plan because the operator needs to know which one was used:
    1. `ideal_client`      — `clients_clone`, when `usableDescriptor` accepts it. This is
                             the field that actually asks who the buyer is.
    2. `service_recipient` — the RECIPIENT named inside `company_what_you_do`, extracted by
                             `recipientFromServiceDescription`. A service description names
                             who it is for after a recipient marker ("... to founder-led
                             businesses", "... into hospitals, care homes", "help B2B
                             consultants ..."). Prepositions are tried before beneficiary
                             verbs, because "We sell mattresses into hospitals" matches
                             "sell" earlier and that returns the product, not the buyer.
    3. `none`              — nothing named a population. Research is SKIPPED.

  WHY NOT THE SERVICE DESCRIPTION ITSELF. Until 2026-08-29 the fallback was the whole of
  `company_what_you_do`, which describes what the client SELLS, not who BUYS it. The live
  query read "<service description> typical company size revenue headcount profile 2025",
  which is not a searchable population, and three consecutive ICP generations reported
  research returning nothing.

  THE SKIP PATH is the point of the rewrite. With no buyer descriptor the agent sends
  NOTHING to the provider and `suggestion_reason` says research was skipped and why.
  "Research was skipped because intake never named a buyer" and "research ran and found
  nothing" are different facts about a document and only the first tells the operator what
  to do. The prompt is told the difference too, and is instructed not to claim research
  ran — the model was previously reporting a search that never happened.

  THE TRIGGER gets the same usability check as the descriptors, added 2026-08-29. Before
  that it was condensed but never checked, so all five live organisations sent a query 2
  opening with narrative prose ("They were dealing with feast and famine cycles. Their
  revenue was all buying trigger why now").

  DESCRIPTOR PROVENANCE IS REPORTED. When the descriptor came from `service_recipient`,
  `suggestion_reason` names the population that was researched. A service delivered to one
  party and bought by another yields a real population and the wrong one, and no
  category-level rule separates those without world knowledge. See BACKLOG for the intake
  field that would fix it properly.

  GEOGRAPHY comes from the ccTLD of the client's own domain (company_url, else
  assets_website) and from nothing else. It used to come from currency, which put a whole
  currency zone into a single-country client's queries. A generic TLD yields no geographic
  hint rather than a wrong one.

  TO SEE WHAT ANY ORGANISATION'S QUERIES ACTUALLY ARE, before and after:
      npx dotenv -e .env.local -- npx tsx scripts/prove-research-queries.ts
  The "before" column is sliced out of origin/main by
  scripts/regen-before-research-queries.ts, not retyped, so it is the code that shipped.

  THE POSITIONING AGENT NOW SHARES THESE RULES. Ported 2026-08-29 (ADR-045); the descriptor
  and geography helpers moved to src/lib/agents/research-descriptors.ts so the two builders
  cannot diverge again.

Output gates (run after the JSON parses, before anything is written):
  - scrubAITellsDeep + assertNoDashes, as before.
  - assertNoUnsourcedVendorNames (src/lib/agents/vendor-name-gate.ts), added 2026-08-28.
    Finds a vendor name anywhere in the generated document and marks it sourced or
    unsourced against the input message the model was given. Unsourced means the model
    introduced it, which is our execution stack leaking into a client's document. Sourced
    means the client's own intake, uploads, website or research named it, which is their
    market vocabulary and is allowed.
    REPORT-ONLY until reviewed after 2026-09-04: it logs and does not throw. See BACKLOG
    for the flip to blocking and for the known incidental-mention hole.
    Also wired into the positioning and TOV agents. Not messaging: see BACKLOG.

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
  - 4 competitor-focused web research queries — OR NONE. See below.

How the research queries are built (buildResearchPlan, ported 2026-08-29, ADR-045):
  The descriptor, geography and query-assembly rules are SHARED with the ICP agent and live
  in src/lib/agents/research-descriptors.ts. Read that module's header first: it explains
  why they are shared rather than copied, which is that they were copied and diverged.

  WHAT DIFFERS FROM THE ICP AGENT. Three of these four queries are about the CLIENT'S OWN
  SERVICE (who else sells this, what do their case studies say, what do buyers complain
  about), so `company_what_you_do` is the correct input here and was never the bug. Only
  query 2 is about the buyer, and it uses the same resolveBuyerDescriptor the ICP agent
  uses. All four needed the geography fix.

  THE SKIP PATH. With no usable service descriptor the agent sends nothing and
  suggestion_reason says research was skipped and why. It previously substituted the
  literal "B2B service providers" and searched anyway, which returns generic results
  grounded in nothing about this client and reads exactly like research that worked.

  offer_deliverables IS NO LONGER A FALLBACK for the service descriptor. Measured across
  all five live organisations it is an OUTCOME every time ("A qualified meeting in the
  diary that flows into pipeline and drives", "contractual obligation"), so it searched
  the result rather than the category.

  TO SEE THE QUERIES, before and after the port:
      npx dotenv -e .env.local -- npx tsx scripts/prove-positioning-queries.ts

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

**Testing:** Contract tests via `test-send.test.ts` verify signature and error handling.
The standalone test script was removed (commit 37e9e1e) as part of hardening against
accidental production calls — all Instantly API calls now route through the flag-driven URL resolver.

---

## Pipeline entry points — sourcing and research (August 2026)

Not agents. These are the deterministic callers that let an operator start sourcing and
research from the dashboard, and they are where every decision about cost, size and safety
is made before an agent runs.

**Why they exist:** until August 2026 neither pipeline stage had a production caller.
`runSourcing` was reachable only from three `scripts/phase4-*.ts` files, each hardcoded to
one organisation and one batch size. `runProspectResearchAgentV2Batch` had a single caller,
a script hardcoded to a stale organisation and eleven prospect ids. A search of the
application returned nothing for either. Two consequences: the live 15-prospect batch could
not be reproduced from the repository, and a paying client could not be onboarded without
someone hand-running scripts. The habit of writing a throwaway script per batch cost 22 USD
in redundant research on 2026-08-20.

### Where they live

| Thing | File |
|---|---|
| Sourcing entry | `src/lib/operator/sourcing-entry.ts` |
| Research entry | `src/lib/operator/research-batch-entry.ts` |
| Sourcing route | `POST /api/operator/organisations/[id]/source-prospects` |
| Research route | `POST /api/operator/organisations/[id]/research-prospects` |
| Dashboard controls | `/dashboard/operator/sourcing-review` |
| Sourcing CLI | `scripts/run-sourcing.ts` |
| Research CLI | `scripts/run-research.ts` |

The dashboard and the CLI both call the same entry point, so a run from a terminal and a
click in a browser make identical decisions. There is no second implementation to drift.

### Auth

Both routes use the ADR-027 two-client pattern through `requireOperator`: an SSR session
client reads the cookie to identify the user, a service-role client reads the role. Not
operator means 403. This is copied from the send path, which is the half of the pipeline
that already worked.

### There is no job queue

Each batch runs inside one request. The routes set `maxDuration = 300`, which is the Hobby
ceiling and this repository's convention. The entry points hold back 60 seconds for cold
start and a slow tail, leaving a 240 second budget, and refuse anything that would not
finish inside it. A refusal is an explicit error naming the real limit, never a silent
truncation of the batch.

Measured on production `agent_runs`, 2026-08-20:

| Work | Rate | Where it runs out of time |
|---|---|---|
| Sourcing | about 12s fixed plus 0.22s per prospect written | around 900 prospects |
| Research, findings reused | about 5.1s per prospect at concurrency 5 | around 47 prospects |
| Research, every source fetched | about 47s per prospect at concurrency 5 | around 5 prospects |

Caps enforced: sourcing 500, research 40 absolute.

Research does not use a flat cap. `use_stored_findings: true` does **not** guarantee a
prospect skips its sources: one with nothing usable on file falls back to a full fetching
run. So the entry point counts how many selected prospects actually have findings within the
30 day window and sizes the batch from that real mix. The count fails pessimistic: if the
lookup errors, every prospect is treated as a fetching run, so a database fault produces a
refusal rather than an admitted batch that times out.

The durable queue is a separate build. See BACKLOG.

### The guard on finished copy

`updateProspect` writes `personalisation_trigger`, `personalisation_question` and
`personalisation_subject` on **every** run. It is not an append and it is not conditional:

```
personalisation_trigger: opening.written_won ? opening.opening : null
```

On a SEND verdict the stored opening is replaced with new wording. On a HOLD verdict it is
set to NULL, destroying the existing one. The judge holds often enough for this to matter:
of the 15 researched prospects in the client-zero organisation on 2026-08-20, 12 held a
trigger and 3 held NULL.

`personalisation_subject` is CLEARED with the trigger but not always SET with it. The subject
has its own gate, and that gate fails soft: an opening can win the judge while its subject was
discarded, in which case the column stays NULL and the variant's authored subject ships above
the researched body. The two states are indistinguishable downstream and are meant to be:
composition reads NULL as "use the authored subject" either way.

So the research entry point **refuses** to run on any prospect that already holds a trigger,
unless the caller passes `allow_overwrite_trigger: true`. The dashboard route never passes
it and never reads it from the request body, so no request can set it. Only the CLI can,
behind `--allow-overwrite-trigger`. If the copy has already been sent, overwriting it means
the stored record no longer matches what the prospect received.

`src/lib/agents/rerun-three-prospects.ts` calls the agent directly and has no such guard.
It is a diagnostic. Do not point it at prospects whose copy has shipped.

### The gates on the writer's opening (research agent)

`checkOpeningGates` in `src/lib/agents/research/write-opening.ts` runs deterministic checks
on what the writer hands back, before any judge sees it. Length, third person, untraceable
claims, firmographics, question marks, client-base claims, and an echo of the approved
offer line.

**Added 2026-08-28: the sentence-initial name check**
(`src/lib/style/sentence-initial-names.ts`).

WHAT IT DOES, in plain English. One of the older checks says "every capitalised word must
appear in the research findings, because a capital letter means it is the name of
something". That check has to skip the first word of a sentence, because the first word of
any sentence is capitalised whether or not it is a name. Skipping it is correct on its own.

It is a hole because of where that check runs. It sees the observation and the bridge as
one block, and the observation always ends in a full stop, so **the first word of the
bridge is always in the skipped position**. Every time. The bridge is exactly where the
writer prompt's worked examples land, and twelve of the sixteen named entities in those
examples pass straight through when placed there.

Nothing has leaked. All 24 stored openings were checked and every name in them belongs to
the prospect it was written for. The risk grows with volume.

HOW IT TELLS A NAME FROM AN ORDINARY WORD, given that capitalisation is useless here. A
word is only reported when it is absent from the findings AND looks like a name, where
looking like a name means either odd spelling (an internal capital, all caps, or a digit:
`HydrospherIQ`, `DTCC`, `Web3`) or not being ordinary English at all (`Taffet`, `Sovern`,
and any company the model invents tomorrow). The ordinary-English vocabulary lives in
`src/lib/style/ordinary-words.ts`.

It is deliberately NOT a list of the names we are afraid of. Such a list would protect
against exactly those spellings and would rot the moment an example changed.

**REPORT-ONLY UNTIL FLIPPED BY HAND.** `SENTENCE_INITIAL_GATE_MODE = 'report'` means it
logs what it would have rejected and rejects nothing. Review after 2026-09-04. See
BACKLOG for what to look for in the logs and how to flip it.

WHAT TO CHECK IF IT BREAKS. If good copy starts getting rejected after the flip, read the
log line `sentence-initial-gate: ...`. It names the prospect, the word, and the sentence.
If the word is ordinary English, add it to `ordinary-words.ts`. Adding a word can only make
the gate more permissive, so it is always the safe fix.

### The safe default

`use_stored_findings` defaults to **true** everywhere: in the agent, in the entry point, and
in the route, which only turns it off on an explicit `false` and ignores a missing or
malformed value. Re-fetching all four sources is the expensive half of a run and must be a
deliberate choice. The default was false until 2026-08-20, no caller ever opted in, and that
one default turned 13 prospects into 176 research runs in a day.

### Concurrent runs

Both entry points refuse to start when a run for the same organisation is already in flight,
checked against an `agent_runs` row with `status='running'` inside a 10 minute window that
matches the reaper cron. This is a soft guard, not a database lock, and it closes the case
that actually happens: an operator clicking twice.

What it prevents:

- **Sourcing.** There is a unique index on `(organisation_id, source_person_key)`. Dedupe
  reads the database before either run writes, so both pass, and the second then hits a
  unique violation partway through its sequential insert loop and aborts part-written, after
  Apollo credits have been spent.
- **Research.** Both runs research the same prospects at full price. Worse, `FrameRegistry`
  and `BatchUniquenessRegistry`, which guarantee that no two prospects ship the same bridge
  or the same closing question, are per-batch and in-process. Two concurrent batches cannot
  see each other, so duplicate wording ships with no collision reported.

A real database lock (`SELECT FOR UPDATE SKIP LOCKED`) is phase 2 in BACKLOG.

### Two behaviours worth knowing

- **`runSourcing` never throws.** Every failure path returns a zero-count result carrying an
  error string. A caller that only watches for an exception reads a total failure, such as
  a missing client-approved ICP, as a successful run that found nobody. The entry point
  checks the error field, which is what stops that.
- **`runProspectResearchAgentV2Batch` does throw**, a `FatalApiError`, when a provider credit
  balance runs out. That aborts the remaining prospects rather than writing a proxy over
  good data on each one, and it must never be reported as a completed batch.

### What to check if it breaks

1. `agent_runs` for this organisation. `sourcing_entry` and `research_batch_entry` rows carry
   the entry point's own view of the run, including refusals recorded as failures.
2. A run stuck at `status='running'` blocks the next attempt for up to 10 minutes, then the
   reaper cron clears it.
3. Sourcing needs an ICP with `status='active'` and `client_approval_status='approved'`, a
   non-null `icp_filter_spec`, and an active `can_source_prospects` row in
   `integrations_registry`. All three produce distinct error messages.
4. Both routes reject an archived organisation. Archived organisations also do not appear on
   the sourcing review page at all.

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

---

## Buyer Criterion Agent — entry point: src/agents/buyer-criterion-agent.ts

**Model:** claude-opus-4-6

**What it does, in plain English.** It reads a client's own approved strategy documents and
their intake answers, and works out who that client should actually be emailing. Not "senior
people" in general: the specific person who owns the problem that client solves, who can
authorise the money, and who can get the decision made.

**Why it exists.** Until now this was a fixed list of twelve job-title fragments applied to
every client identically, written for consulting firms. Any client in another market was
being judged by consulting vocabulary. It also ran after we had already paid to enrich each
prospect, so people we were always going to reject cost money first.

**What it produces.**
  1. Fragments the system matches against a prospect's job title, ranked primary or secondary.
  2. Fragments that disqualify, for roles named after the person they support.
  3. A plain-English statement of who the buyer is and why, plus the evidence from the
     client's documents. This is meant to be read aloud on an onboarding call. It is how you
     check the system's judgement before it starts filtering real prospects.

**Where it is stored.** Inside the existing ICP filter spec, as `buyer_criterion`. It is
approved with the ICP and re-derived whenever a new ICP is approved. There is no separate
document and no extra approval step.

**What connects to it.** `persistIcpFilterSpec` calls it after an ICP is promoted.
`gateProspectsBeforeEnrichment` applies the result before any enrichment spend, and
`classifyTier` applies the same rule again after enrichment.

**What to check if it breaks.**
  - If enrichment is spending on people it should reject, check whether the client's spec has
    a `buyer_criterion` at all, and what its `status` is. Only `derived` filters anything.
  - If a client's pipeline suddenly has no prospects, check the `sanity` note on the
    criterion. A criterion that rejects nearly everything is supposed to be caught and
    switched off before it does that, but read the note to confirm.
  - Three statuses mean "do not filter": `unsettled` (the documents do not say who decides),
    `out_of_band` (it accepts or rejects almost everything), and simply missing. All three
    enrich everyone and raise a warning to the operator, which is deliberate: a broken filter
    must not quietly stop a client's pipeline.

**The rule that matters most.** The prompt must never contain an example job title, industry,
or buyer type. An example gets copied into every client's answer, including clients in
markets where it makes no sense. There is a test that fails the build if one appears.
