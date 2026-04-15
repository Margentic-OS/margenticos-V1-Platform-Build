# MargenticOS — New Session Handoff Prompt
# Paste this at the start of any new Claude Code or claude.ai session.
# This is the context and reasoning behind the build. The spec documents
# (CLAUDE.md and /prd) contain the what. This explains the critical why.

---

## What this project is

MargenticOS is an agentic services platform built by Doug Pettit (the operator).
It delivers AI-powered pipeline generation for founder-led B2B consulting firms.
Agents execute through existing tools. Clients see results and strategy documents.
This is not a SaaS product. Clients never touch the execution layer.

The build is structured as four phases. We are currently in phase one.
CLAUDE.md and /prd/PRD.md (with 14 section files) are the complete specification.
Read CLAUDE.md first at the start of every session. Then read the relevant PRD section.

---

## Who Doug is and how to work with him

Doug is a non-developer learning Claude Code while building this.
He uses claude.ai alongside Claude Code — sharing screenshots, asking questions,
checking decisions. Every session must include plain English explanations.
Never proceed past a blocker without flagging it clearly with step-by-step instructions.
Never make architectural decisions silently. Always name them so Doug can approve.
When something breaks, explain what happened before suggesting a fix.

---

## The five decisions that must never be reversed

These were made deliberately after significant analysis. If anything in the build
tempts you to shortcut around them, stop and flag it to Doug first.

### 1. Tool agnosticism — nothing hardcoded to a vendor

Every external tool is registered in the integrations_registry table.
Agents reference capabilities (can_send_email), not tool names (Instantly).
A handler function maps capabilities to whatever tool is registered.

Why this matters: The tool stack will change. Taplio may get replaced.
Lemlist may get replaced. If tools are hardcoded, every swap is a rebuild.
With the registry pattern, every swap is one new handler function.
This is the decision that makes the entire product extensible without rebuilds.

Risk of reversing: If you hardcode Instantly into an agent, you've created a
dependency that will cost 10x the time to untangle later than it saves now.

### 2. Agents never update documents directly — always the suggestion queue

Agents write to document_suggestions. Doug approves. Documents version.
Agents never modify strategy_documents directly, ever.

Why this matters: Autonomous document updates are fragile. An agent making a
bad update based on thin data produces a document the client trusts — and it's wrong.
The suggestion queue keeps Doug in the loop as a quality gate.
The path to full autonomy is additive: add a confidence threshold, add one condition.
Nothing gets rebuilt. The architecture already supports it.

Risk of reversing: Building autonomous updates in phase one creates a system
that can silently corrupt client IP based on insufficient signal.

### 3. Agent isolation is absolute

Every agent invocation passes client_id as a required parameter.
Agents never query data without filtering by client_id.
The patterns table is the only cross-client operation, and it contains
anonymised aggregated insights only — never raw client data.
The patterns table is written ONLY by the dedicated pattern aggregation agent.

Why this matters: A data leak between clients is the most serious possible error.
Client A's ICP data appearing in Client B's outreach is a catastrophic trust failure.
Three-level enforcement (RLS + application filter + agent prompt) is not overkill.

Risk of reversing: Any agent that queries without client_id is a data breach waiting
to happen. Enforce at all three levels every time.

### 4. Taplio has no public API — dashboard is the approval layer

Taplio does not have a public API for programmatic post scheduling.
It also had its own LinkedIn page temporarily restricted in 2024 due to
cookie-based automation. The risk is real.

The correct architecture: agent generates post content → client approves in
MargenticOS dashboard → approved post pushed to Taplio queue manually
or via Zapier. Taplio is the publishing layer. Dashboard is the approval layer.

Why this matters: Attempting to build a programmatic Taplio integration will fail.
The API does not exist. Do not attempt it.

Risk of reversing: Wasted sessions building an integration that cannot work.

### 5. LinkedIn scraping is not permitted

LinkedIn actively blocks automated scraping. Any Playwright or cookie-based
approach to reading LinkedIn profiles violates their ToS and gets blocked.

The prospect research agent uses: Apollo API (primary), web search for
Google-indexed content (secondary), direct company website fetch (tertiary).
If no trigger is found after three steps, use role-based pain proxy.
Never fabricate a trigger. Never scrape LinkedIn directly.

Risk of reversing: Production dependency on a scraping approach that LinkedIn
actively blocks means campaigns break unpredictably for paying clients.

---

## The three most important things to build correctly in phase one

1. RLS policies on every table before any data is written.
   This is enforced at database level, not just application level.
   A client must never be able to read another client's data.
   Test RLS before writing any application code that uses the table.

2. The integrations_registry table and capability handler pattern.
   This must be the first integration component built, before any specific tool.
   Every integration that follows — Instantly, Taplio, Lemlist, Apollo — plugs
   into this registry. If the registry isn't there first, integrations get hardcoded
   and the tool-agnostic principle is broken from day one.

3. The suggestion queue architecture (document_suggestions table).
   Even if the feedback loop agents aren't built in phase one, the table must exist
   and the rule must be established: documents are never updated directly.
   When feedback loop agents are added in phase three, the infrastructure is ready.

---

## Skills to read before specific build tasks

Before building any UI component or dashboard view:
  Read /mnt/skills/public/frontend-design/SKILL.md

Before building PDF export for strategy documents:
  Read /mnt/skills/public/pdf/SKILL.md

Before building Word document export (if needed):
  Read /mnt/skills/public/docx/SKILL.md

Before building file ingestion for intake uploads:
  Read /mnt/skills/public/file-reading/SKILL.md

Before building any Anthropic API calls (agent pipeline):
  Read /mnt/skills/public/product-self-knowledge/SKILL.md

There is also a user skill for copywriting:
  Read /mnt/skills/user/copywriting/SKILL.md
  Use this when writing any dashboard copy, empty states, notification text,
  or any user-facing string. MargenticOS copy must never sound like AI.

---

## Key context that is NOT in the spec documents

These are reasoning points that shaped decisions but aren't captured in CLAUDE.md or PRD.

**Why the feedback loop starts as a suggestion queue rather than autonomous updates:**
Simpler to build, safer to launch, and architecturally identical to the autonomous
version — just with one additional approval step. When Doug has enough signal confidence
to trust the agents, he raises the auto-approve threshold. Nothing gets rebuilt.

**Why Lemlist for LinkedIn DMs and not La Growth Machine:**
Simpler API, lower cost, sufficient for phase one volume. Tool-agnostic architecture
means it's swappable with one new handler function if something better emerges.

**Why reply handling automation is phase one for positive replies only:**
A positive reply waiting 24 hours loses a meeting. That's the most commercially
sensitive moment. Information requests and complex replies are manual in phase one
because they require nuanced human judgment that an early-stage agent can't reliably provide.

**Why the pipeline view is hidden in months 1–2:**
Early results are low. A client seeing "2 meetings" as the hero number in month one
will doubt the service. The setup and strategy view keeps focus on the IP they own
(the four documents) during the period when campaign results are still building.

**Why MargenticOS runs as client zero before any paying clients:**
Every integration, every webhook, every agent output gets tested against Doug's own
business before a paying client touches it. This is the proof of concept.
It also produces the case study and personal example that sells the service.

**Why the pattern library starts sparse and that's fine:**
With 3–5 founding clients the patterns table will have thin data for months.
Agents must handle empty pattern query results gracefully — default to per-client
signal history. The pattern library compounds in value over time. Don't force it early.

---

## Current build status

Phase: 1 — Foundation
Documents ready: CLAUDE.md, /prd/PRD.md, /prd/sections/01–14
Additional docs to create in first setup session:
  /docs/design.md — design system tokens, colours, typography, copy rules
  /docs/ADR.md — architecture decision record log
  /docs/prompts/ — folder for agent system prompt files

Next action: First Claude Code session — setup only, no application code.
  Create folder structure, initialise Next.js project, set up Git,
  walk Doug through Supabase MCP installation (step by step — he has not done this before),
  walk Doug through GitHub MCP installation,
  configure Supabase project (Doug creates account, Claude Code prompts for credentials),
  create all database tables with RLS policies,
  populate /docs with required stub files,
  populate /prd with all section files if not already present.

---

## How to handle uncertainty

If the spec is ambiguous on something, check in the relevant PRD section first.
If it's not there, ask Doug before proceeding.
Never invent a solution to an architectural question and implement it silently.
Doug would rather pause for five minutes than spend a session untangling a wrong turn.
