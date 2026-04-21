# sections/06-agents.md — All Agents: Purpose, Inputs, Outputs, Isolation
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when building or modifying any agent.

---

## Agent isolation rules — always active

Every agent invocation must:
  1. Receive client_id as a required parameter
  2. Query only data filtered by that client_id
  3. Never reference any data source outside the current client's context
  4. Be stateless — no module-level variables, all state passed as parameters

The only permitted cross-client operation is reading the patterns table,
which contains anonymised aggregated insights — never raw client data.

Wrong: const intake = await getIntake()
Right: const intake = await getIntake({ client_id })

A data leak between clients is the most serious error this system can produce.
Enforce isolation at all three levels on every agent: RLS + application filter + prompt.

---

## Agent conventions

Each agent has its own dedicated entry point file.
Named descriptively: prospect-research-agent.ts, icp-generation-agent.ts.
No shared dispatcher that branches on a type parameter.
One file = one agent = one clear purpose.

Agent system prompts live in /docs/prompts/ — one file per agent.
Update the prompt file whenever the agent's instructions change.

---

## Document generation agents

These four agents run in sequence after intake is 80% complete.
They are the primary product — quality is paramount.
Model: claude-opus-4-5 (test vs Sonnet before locking in).

### ICP Generation Agent
Entry point: icp-generation-agent.ts
Prompt file: /docs/prompts/icp-agent.md

Purpose:
  Generate the Ideal Client Profile document for this organisation.

Framework:
  Jobs-to-be-Done (JTBD) — what job is the client hiring this firm to do?
  Four Forces of Progress — push (pain), pull (attraction), anxiety (risk), habit (inertia)
  Tier model — Tier 1 (ideal), Tier 2 (good), Tier 3 (acceptable but not targeted)

Inputs:
  - intake_responses for this client_id (all sections)
  - Existing ICP document if this is a refresh (for versioning context)
  - Pattern library (read-only cross-client signal — may be empty early on)

Outputs:
  - Structured ICP document written to strategy_documents
  - Version incremented if this is an update

Quality test:
  Would a sharp decision-maker say "this is exactly who I'm trying to reach"?
  Never produce demographic-only profiles. Motivations, triggers, and switching costs are required.

---

### Positioning Generation Agent
Entry point: positioning-generation-agent.ts
Prompt file: /docs/prompts/positioning-agent.md

Purpose:
  Generate the Positioning document for this organisation.

Framework:
  April Dunford "Obviously Awesome" — competitive alternatives, unique attributes,
  value for the right customers, best-fit customer characteristics, market category
  Geoffrey Moore compression — one clear category, one clear differentiation

Inputs:
  - intake_responses for this client_id
  - ICP document for this client (must be generated first)
  - Pattern library (read-only)

Outputs:
  - Structured Positioning document written to strategy_documents

Quality test:
  Can the client read the positioning and say in one sentence what makes them different?
  If it could apply to any firm in this client's market category, it has failed.

---

### Tone of Voice Generation Agent
Entry point: tov-generation-agent.ts
Prompt file: /docs/prompts/tov-agent.md

Purpose:
  Generate the Tone of Voice guide for this organisation.

Framework:
  Extraction-first principle — find their real voice from writing samples.
  Extract: vocabulary, rhythm, personality, sentence structure, natural warmth.
  Correct regardless of samples:
    - Never open with I/We
    - One question maximum per message
    - No feature listing before establishing relevance
    - No service-led language (don't lead with what you do)
    - First touch under 100 words

The agent must improve the voice even when the writing samples show these bad habits.
Extract the authentic personality; apply the corrections on top.

Inputs:
  - Writing samples from intake_responses (critical field)
  - intake_responses for style preferences and communication dislikes
  - File uploads (writing sample PDFs/docs if provided)

Outputs:
  - TOV guide written to strategy_documents
  - Includes: voice characteristics, writing rules, before/after examples, do/don't list

Quality test:
  Read the TOV guide and write one cold email using it. Does it sound like a specific human?
  Apply the "AI slop" test: would the founder cringe, or would they say "yes, that's me"?

---

### Messaging Playbook Agent
Entry point: messaging-generation-agent.ts
Prompt file: /docs/prompts/messaging-agent.md

Purpose:
  Generate the Messaging Playbook for this organisation.

Framework:
  Foundation layer: core message — one clear statement of who you help, with what outcome
  Layer architecture: cold email, LinkedIn, follow-up, objection handling
  StoryBrand influence: prospect is the hero, the firm is the guide

Inputs:
  - ICP document (must exist)
  - Positioning document (must exist)
  - TOV guide (must exist)
  - intake_responses

Outputs:
  - Messaging Playbook written to strategy_documents
  - Covers: subject lines, opening lines, CTAs, follow-up sequences, objection responses

Quality test:
  Take one message from the playbook. Would a sharp decision-maker feel comfortable sending it?
  Does it lead with the prospect's situation, not the firm's services?

---

## Prospect Research Agent
Entry point: prospect-research-agent.ts
Prompt file: /docs/prompts/prospect-research-agent.md
Model: claude-haiku-4-5-20251001

Purpose:
  Find one business-relevant personalisation trigger for each prospect
  using the Trigger-Bridge-Value framework.

Framework — Trigger-Bridge-Value:
  Trigger: one specific business-relevant observation about this prospect right now
  Bridge:  one sentence connecting that trigger to the problem the client solves
  Value:   outcome statement framed around the prospect, not the service

Business relevance filter (enforce strictly):
  ALLOWED: business pain signals, role pressures, company growth indicators, strategic
           shifts, hiring patterns, tech changes, funding events, published business content
  FORBIDDEN: personal interests, hobbies, sports, family, personal social media,
             conference attendance unless business topic, anything surveillance-like

Research sequence (3 steps maximum per prospect):
  1. Apollo enrichment API (primary)
  2. Targeted web search for Google-indexed public content (secondary)
  3. Direct company website fetch (tertiary)
  If no trigger found after three steps: use role-based pain proxy
  Never fabricate a trigger. Never use a generic compliment.

Token budget: 3 API calls maximum per prospect.
No LinkedIn scraping — see ADR-005.

Inputs:  prospect record (name, role, company, LinkedIn URL if available), client_id
Outputs: personalisation_trigger written to prospects record, research_source noted

---

## Signal Processing Agent
Entry point: signal-processing-agent.ts
Prompt file: /docs/prompts/signal-processing-agent.md
Model: claude-haiku-4-5-20251001

Purpose:
  Process incoming campaign signals and determine whether they meet the threshold
  to generate a document suggestion.

Phase one scope:
  In phase one, this agent logs and categorises signals.
  It writes them to the signals table with processed = true.
  It does NOT evaluate signal thresholds or generate suggestions.
  Signal threshold processing is phase two work — see ADR-011.

Inputs:  raw signal event (from webhook), client_id
Outputs: signal record written to signals table, processed = true

---

## Pattern Aggregation Agent
Entry point: pattern-aggregation-agent.ts
Prompt file: /docs/prompts/pattern-aggregation-agent.md
Model: claude-haiku-4-5-20251001

Purpose:
  Aggregate anonymised signal patterns across all clients and write to the patterns table.
  This is the ONLY agent that may write to the patterns table. Ever.

This agent reads signals across all client accounts (the only cross-client read operation).
It strips all identifying information before writing to patterns.
It runs on a schedule (frequency TBD in phase two when signal volume justifies it).

Phase one: this agent is built but runs infrequently. The patterns table will be sparse.
Agents must handle empty pattern query results gracefully — default to per-client history.

Inputs:  signals table (cross-client, read-only)
Outputs: rows written to patterns table

---

## Reply Handling Agent
Entry point: reply-handling-agent.ts
Prompt file: /docs/prompts/reply-handling-agent.md
Model: claude-haiku-4-5-20251001

Purpose:
  Classify incoming email replies and handle them according to reply type.
  Phase one: automates positive replies only.

Reply types and handling:
  Positive reply:   Respond same business hour. Include Calendly link. Say "grab a slot."
                    Sign as "[Client Company Name] Team." Never founder name. Never mention AI.

  Information request: No automated response. Flag to client immediately as high priority.
                    Escalation: 15h reminder → 48h second reminder → 72h holding message.
                    Holding message signed by company team, toggle per client, default off.

  Negative / opt-out: Immediate suppression — set suppressed = true on prospect.
                    Push suppression to Instantly API immediately.
                    One signal is enough. Any unmistakeable refusal triggers this.
                    Covers: stop, remove me, not interested, fuck off, leave me alone,
                    and any variation thereof.

  Out-of-office:    Detect via pattern matching. Pause sequence for this prospect.
                    Extract return date if present. Resume day after. Default: 10 business days.

Inputs:  raw reply text, prospect_id, campaign_id, client_id
Outputs: action executed (response sent / suppression set / escalation flagged)
