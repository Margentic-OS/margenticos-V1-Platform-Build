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

The approval handler (not yet built) reads the suggestion and creates the strategy_documents row.

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

Dependencies: All three of the following must exist with status = 'approved' in strategy_documents:
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
