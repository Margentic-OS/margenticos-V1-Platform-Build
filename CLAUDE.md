# CLAUDE.md — MargenticOS
# Read this completely at the start of every session. Do not skip it.

---

## Active temporary states — read before touching infrastructure

- **Repo is currently PUBLIC on GitHub** to enable Vercel Hobby deploys.
  Acceptable at pre-revenue stage because no secrets are committed and the
  source is not the moat. MUST be flipped to PRIVATE before the first paying
  client is onboarded. This requires upgrading Vercel to Pro ($20/month)
  simultaneously, since Hobby cannot deploy private org repos.

  Trigger: First signed paying-client contract, OR first founding-client
  testimonial that references the platform by name publicly, whichever comes first.

---

## Session start ritual — read these before anything else

Every new Claude Code session must read, in order:
  1. /CLAUDE.md (this file)
  2. /docs/BACKLOG.md (deferred items and follow-ups)
  3. /docs/ADR.md (architecture decisions)
  4. The relevant /prd/sections/NN-*.md file for the current task
  - For prospect research agent v2 state and architecture, see `docs/prospect-research-agent-v2-state.md`

Do not skip BACKLOG.md. It captures items consciously deferred in earlier sessions
that you would otherwise forget. Missing an item in BACKLOG.md has cost real hours
of rework more than once.

---

## Who is building this

Doug is building MargenticOS while learning Claude Code. He is not a developer.
He learns by doing, by seeing results, and by understanding each step as it happens.
He uses claude.ai alongside Claude Code throughout the build — sharing screenshots,
asking questions, and sense-checking decisions.

Every response must therefore:
- Explain in plain English what was just built and why
- Never assume technical knowledge Doug has not demonstrated
- Stop and give exact step-by-step instructions when a manual action is required
  (creating an account, adding credentials, configuring a tool, installing an MCP)
- Never proceed past a blocker without flagging it clearly with a path forward
- When something breaks, explain what happened in plain English before suggesting a fix
- When a decision has long-term architectural implications, name it explicitly
  so Doug can make an informed choice rather than discover consequences later
- Never make a significant architectural decision silently

When Doug shares a screenshot or error message, interpret it fully before responding.
When something is unclear, ask one specific question rather than guessing.

---

## What this project is

MargenticOS is an agentic services platform. Doug (the operator) delivers
AI-powered pipeline generation for founder-led B2B consulting firms ($300K–$3M revenue).

Agents execute through existing tools (Instantly, Taplio, GoHighLevel, Apollo, Lemlist).
The dashboard displays results and houses client strategy documents.
Clients never touch the execution layer.

This is not a SaaS product. Do not build it like one.

The full MargenticOS vision includes referral tools, SEO, website generation, paid ads,
and nurture sequences. What is being built now is the foundation: intake, strategy
documents, agent pipeline, results dashboard, core integrations, and feedback loop.
Do not over-engineer for the full vision. Build what is specced in the current phase.
Phases are explicitly subject to change and iteration as the build progresses.

---

## The single most important architectural principle — tool agnosticism

Nothing is hardcoded to a specific vendor. Ever.

Every external tool is registered in the integrations_registry table with its
capabilities, connection status, and API handler reference.

The system declares capabilities, not tool names:
  can_send_email              → currently: Instantly
  can_schedule_linkedin_post  → currently: Taplio
  (Taplio has no public scheduling API. Model: agent generates content →
   dashboard approval → content delivered to Taplio queue via Zapier or manually.
   Never attempt programmatic API scheduling with Taplio.)
  can_send_linkedin_dm        → currently: Lemlist
  can_enrich_contact          → currently: Apollo
  can_book_meeting            → currently: Calendly
  can_validate_email          → currently: Hunter.io (phase two)

Agents and components reference capabilities only. Never tool names.
A handler function maps each capability to whichever tool is registered for it.

Swapping a tool = update the registry + write a new handler. Nothing else changes.
Adding a new tool = new registry row + new handler. Everything else is untouched.

This is what makes the system extensible without rebuilds.
It is the architectural decision that protects the entire future of the product.
Never violate it, even for a shortcut that seems harmless.

---

## Security and resilience — two layers, both always active

### Layer one — data security (Supabase enforced)

Row Level Security must be enabled on every Supabase table before any data is written.
A client must only ever read their own organisation's data.
This is enforced at the database level, not just the application level.

When creating any new table:
  1. Write RLS policies first
  2. Verify they work correctly
  3. Only then write application code that uses the table

API keys and secrets: Supabase environment variables or .env files only.
Never hardcode credentials in application code.
Never expose credentials client-side.
Verify .env is in .gitignore before the first commit of every session.

Authentication: Supabase Auth with magic link (passwordless email).
Operator routes must verify role = 'operator' on every protected request.
Not just at login — on every request to a protected route.

For every new API route, three checks before returning any data:
  1. User is authenticated
  2. User role is appropriate for this route
  3. client_id in the request matches the data being requested

### Layer two — resilience (build discipline)

Security also means the build does not break silently or unrecoverably.

Git commits protect work between steps (see Git section).
Three environments prevent production breakage from development work.
Sentry catches errors before Doug or clients notice them.
The /docs folder means context is never lost between sessions.
The /prd folder means scope decisions are recorded and recoverable.
Staged deployments mean only verified code reaches production.

These are not optional practices. They are the protection against the most
common failure modes in a complex build managed by a non-developer.

---

## Git — mandatory, explained simply

Before every significant change:
  git add .
  git commit -m "checkpoint before: [what you are about to do in plain English]"

After every significant change:
  git add .
  git commit -m "[what was done and why, in plain English]"

Always tell Doug what was just changed, why committing now protects it,
and what the next step is.

A significant change means: any new file, any new function, any database schema
change, any configuration change, any integration addition or modification.

Never make multiple significant changes without committing between them.
The last commit is the recovery point. If there is no recent commit,
recovery is painful and sometimes impossible.

---

## Git workflow

- After every commit, push to origin unless the user explicitly says otherwise
- Ensures Vercel deploys, GitHub backups, and collaborator visibility stay in sync
- Verify push success before reporting commit complete to the user
- If branch protection is bypassed (as admin), note it explicitly in the report

---

## MCP setup — prompt Doug, never assume accounts exist

This project uses MCPs (Model Context Protocol) to give Claude Code direct
access to project tools without manual copy-paste of credentials or schemas.

Required MCPs for this project:
  Supabase MCP   — reads actual database schema, verifies RLS policies,
                   catches data model errors before runtime
  GitHub MCP     — handles commits and branch management with full context
  Filesystem MCP — manages /docs and /prd folders directly

Doug has not set up MCPs before. When an MCP is needed and not yet configured,
stop and provide exact step-by-step setup instructions before continuing.
Specify what to click, what to paste, and what to verify as confirmation it worked.

When any new external account is needed (Supabase project, Instantly workspace,
GoHighLevel subaccount, Lemlist account, Apollo account, etc.), stop and tell Doug:
  - What account is needed and where to create it
  - What settings or credentials to note down during setup
  - Exactly when to come back and what to provide

Never assume an account or credential exists. Always check first.

---

## MCP safety rules

MCPs have the same power to destroy as they do to create. Two rules apply to
every MCP operation in every session, no exceptions:

**Destructive operations require explicit approval before running.**
Before executing anything that removes, drops, wipes, disables, unpublishes,
or force-pushes — show Doug the exact command or API call and wait for a
clear "yes, do it" before proceeding. This covers: DNS record deletion,
env var removal, domain removal, database table drops, branch deletions,
deployment rollbacks, and any operation described with words like delete,
destroy, remove, disable, or force.

**Additive operations run without confirmation.**
New DNS records, new env vars, new domains, new tables, new deployments —
these are safe to execute directly and do not need a confirmation step.

**Never echo secret values.**
When showing env var commands or confirming what was set, display the key
name and scope only. Never print the value. Example: "Set
NEXT_PUBLIC_APP_URL in Production scope" — not the URL if it were a secret,
and never tokens, passwords, or API keys under any circumstances.

---

## Documentation — update /docs every session, never skip

All technical documentation lives in /docs at the project root.
This is what Doug and Claude Code use when something breaks or a new session starts.

When building or changing any component, update the relevant /docs file.
If no file exists for the component, create one before finishing the session.

Write in plain English. Assume the reader is not a developer.
Each doc must cover: what this does, what it connects to, what to check if it breaks,
and why key decisions were made.

Required /docs files — create at project setup if missing:
  /docs/architecture.md     — system overview, data flow, tool-agnostic principle
  /docs/data-model.md       — all tables, fields, relationships, RLS policies
  /docs/auth.md             — roles, access control, multi-user client setup
  /docs/agents.md           — each agent: purpose, inputs, outputs, isolation rules
  /docs/integrations.md     — registry pattern, each registered tool, handler locations
  /docs/dashboard.md        — all views, what each shows, why
  /docs/signals.md          — signal types, processing logic, benchmark thresholds
  /docs/intake.md           — questionnaire flow, file types, completeness logic
  /docs/approval.md         — channel modes, notification timing, batch sampling
  /docs/reply-handling.md   — reply types, routing, escalation sequence
  /docs/deployment.md       — environments, variables, Sentry, Vercel configuration

The /prd folder holds the product specification (see PRD.md).
/docs = living technical reference, updated continuously as the build progresses.
/prd  = product specification, updated only when scope formally changes.

---

## Before ending any session — update BACKLOG.md

If the session defers any scope item, decides to revisit something later, or hits
a known limitation that future-Doug will forget about, the item goes in
/docs/BACKLOG.md before the session ends.

This is not optional. The discipline is:
  1. Session surfaces something to defer.
  2. Claude Code flags it explicitly in the session summary.
  3. Doug confirms the item should be deferred (versus addressed now).
  4. Claude Code writes the item to BACKLOG.md with tag, date, and context.
  5. Only then does the session end.

Without this, the backlog stays in Doug's head and in individual chat threads,
and the one that matters slips through when he's switching contexts.

---

## Model selection — right model for each task

Per ADR-013, current agent model assignments:

  Document generation agents (ICP, positioning, TOV):  claude-opus-4-6
  Messaging generation agent:                          claude-sonnet-4-6
                                                       (local-dev workaround —
                                                        revert to opus-4-6 when
                                                        streaming works stable)
  Prospect research — web search synthesis step:       claude-haiku-4-5-20251001
  Signal processing, batch tasks:                      claude-haiku-4-5-20251001
  Reply handling (positive reply classification):      claude-haiku-4-5-20251001
  Claude Code itself (build, debug, refactor):         claude-sonnet-4-6

Model versions must be passed explicitly in every Anthropic API call.
Never rely on API defaults.

If a model is retired or replaced, update the relevant agent file directly.
Update this list and ADR-013 in the same commit.

---

## Agent isolation — absolute, enforced at three levels

Every agent invocation must pass client_id as a required parameter.
Agents query only data associated with that client_id. No exceptions.

The only permitted cross-client operation is reading the patterns table,
which contains anonymised aggregated insights — never raw client data.

The patterns table is written ONLY by the dedicated pattern aggregation agent.
No other agent, no application code, no manual query ever writes to it directly.

Three enforcement levels:
  1. Database: RLS policies block cross-client queries at the data layer
  2. Application: explicit client_id filter on every Supabase query
  3. Agent prompts: no prompt references any data source outside current client context

Wrong: const signals = await getSignals()
Right: const signals = await getSignals({ client_id })

A data leak between clients is the most serious error this system can produce.
If ever unsure whether an agent call is properly isolated, stop and verify first.

---

## Agent conventions — stateless, discrete, isolated

### Stateless invocation
Every agent must be stateless. No module-level variables that persist between calls.
All state is passed as explicit parameters on every invocation.
Each call must be independently reproducible: same inputs produce equivalent outputs.
Never rely on in-memory state from a previous invocation.

### Discrete entry points
Each agent has its own dedicated entry point file.
Named descriptively after its function: prospect-research-agent.ts, document-generation-agent.ts.
No shared dispatcher file that branches on a type parameter to route to different agents.
One file = one agent = one clear purpose.

---

## Product scope and industry agnosticism

MargenticOS is industry-agnostic infrastructure. The 
agent pipeline, document generation system, composition 
layer, approval flow, and all supporting architecture 
are designed to serve any B2B business regardless of 
industry, buyer type, company size, or growth model.

The current go-to-market focus is founder-led B2B 
consulting and coaching firms. This is a starting point 
based on Doug's access, validated pain data from 1,311 
Lean Marketing sales call transcripts, and 
founder-market fit. It is not a product constraint.

The long-term vision is a full AI agentic-led marketing 
department for hire, deployable across any B2B industry.

Build decisions must reflect this:

- No agent prompt may hardcode industry-specific 
  assumptions, buyer archetypes, pain points, growth 
  models, or competitive sets as universal defaults
- All agent prompts must derive industry, buyer type, 
  and pain language from runtime documents — the ICP 
  document, positioning document, TOV guide, and 
  intake data
- When intake data is thin, agents must flag the gap 
  and derive from context — they must never fill gaps 
  with consulting assumptions
- Example values in prompt templates, output format 
  schemas, and worked examples must be industry-neutral
- Any new agent, prompt, or feature built must pass 
  this test: "Would this work correctly for an AI 
  voice calling company, a SaaS business, or a 
  logistics firm?" If not, it is not ready

The only exception: MargenticOS's own client-zero 
campaigns target consulting and coaching firms because 
that is Doug's ICP for MargenticOS itself. This is 
operationally correct and does not contradict the 
above — it is one client's ICP, not a universal 
assumption baked into the product.

## Industry naming is always canonical — never tool-specific

Internal storage, agent prompts, filter specifications, and database fields always
use canonical NAICS-derived industry names (e.g. "Management Consulting",
"Software Publishers", "Marketing Consultancy"). Never store or reference Apollo's
industry names, Instantly's industry names, LinkedIn's industry names, or any
other tool-specific taxonomy in application code, agent prompts, or client
records.

Each sourcing handler owns its own translation table from canonical names to
tool-specific names. Translation is the handler's responsibility. Nothing
upstream of the handler sees tool-specific names.

Doug never sees NAICS codes in the UI. The UI displays canonical industry names
directly.

---

## Prompt and validator consistency rules

When a prompt and a validator enforce the same rule, they must agree exactly.
If one is updated, the other must be checked and updated in the same session.

Known validator thresholds — these are code-enforced and cannot be overridden by the prompt:
  Email 1 subject:   maximum 40 characters (target < 25)
  Emails 2 and 3:    subject_line must be null; subject_char_count must be 0
  Email 4 subject:   maximum 9 characters ("last note" = 9 chars; "one more thing" = 14, rejected)
  Email 1 body:      40–90 words
  Email 2 body:      30–70 words, must be shorter than Email 1
  Email 3 body:      maximum 75 words (hardest limit — cut observation before ask)
  Email 4 body:      30–50 words
  Sign-off:          last non-empty line of every email body must be the sender's first name only
  Opening word:      must not be I or We (applied to body after first-name line)
  Em dashes:         zero tolerance; any instance causes the entire variant to be flagged

When writing or editing an agent prompt, check the corresponding validator before committing.
When writing or editing a validator, check the corresponding prompt before committing.
Never update one without confirming the other still agrees.

---

## Style rules for all generated content

These rules apply to every agent that produces customer-facing text:
trigger sentences, email copy, document summaries, and any output that
reaches a client or prospect.

The canonical source is: src/lib/style/customer-facing-style-rules.ts
Every agent touching customer-facing output must import from this module.
Do not duplicate these rules inline in individual agent prompts — import the constant.

**Em dashes (—), en dashes (–), and double hyphens (--) are absolutely forbidden.**
They are the most recognizable AI writing tells. MargenticOS's ICP (founder-led
consulting firms burned by AI email) detects them immediately.

Replace with:
  - A period and a new sentence (most common fix)
  - A comma (when the clause is tightly connected)
  - A colon (when what follows IS the thing described)
  - Sentence restructuring

Other forbidden AI tells in all generated content:
  - "Delve into"
  - "Navigate the complexities of" / "Navigate the landscape"
  - "Leverage" as a verb (use "use", "apply", or "build with")
  - "Seamless" / "Seamlessly"
  - "Robust"
  - "At the end of the day"
  - "That said" / "Having said that"
  - Sentences starting with "Look,"
  - "Furthermore" / "Moreover" / "Additionally"
  - "It's worth noting that"
  - Three-part parallel lists in a single sentence ("not just X, but Y and Z")
  - "As someone who..." when the framing is speculative or inflated
    (legitimate experience-based openers such as "From working with..." are fine)

The messaging agent has a runtime scrub via scrubAITells() as a safety net.
All agents that produce customer-facing text must call scrubAITells() before
storing or sending output. There is no runtime net without it.

---

## Feedback loop — suggestion queue, never direct document updates

Agents write suggestions to the document_suggestions table.
Agents never update strategy documents directly.

Signal thresholds before a suggestion is generated:
  3 signals (same type, unrelated prospects) → low-confidence suggestion, informational
  5 signals → agent generates A/B test variant for next batch
  10 signals + confirmed A/B winner → high-confidence suggestion generated

When two suggestions conflict for the same document field:
  Surface them together with three options:
  A) Apply suggestion one  B) Apply suggestion two  C) Wait for more signal
  Default is always C. Active choice required to apply either suggestion.

Phase one — schema only:
  Signal threshold logic (3/5/10 tiers), A/B test generation, and conflict resolution
  between competing suggestions are schema-only in phase one. The document_suggestions
  table must exist with the relevant fields (signal_count, confidence_level, ab_variant,
  conflicting_suggestion_id), but the processing logic is not implemented until campaign
  data makes it meaningful. Flag to Doug before implementing any of this logic.
  Do not build it speculatively.

Auto-approve: phase four only. Do not build in phase one.

---

## Approval system — channel toggles

cold_email: sequence-level approval. Client approves the template, not individual emails.
  Optional batch sample (5–10 emails) showing personalisation source tags.
  3-day auto-approve. Notifications at T+0, T+15h, T+48h, T-12h.

linkedin_post: toggle per client, default ON.
  Dashboard is the approval layer. Taplio is the publishing layer only.
  Taplio has no public API for programmatic scheduling — do not attempt to build one.
  Approved in dashboard → content delivered to Taplio queue via Zapier or manually.
  24-hour auto-approve.

linkedin_dm: same model as cold_email. Tool: Lemlist (registered via can_send_linkedin_dm).

Doug notified for all rejections and auto-approvals across all channels.

---

## Reply handling

Positive reply:
  Respond same business hour. Include Calendly link. Say "grab a slot."
  Sign as "[Client Company Name] Team." Never use founder name, never mention AI.

Information request:
  No automated response. Flag to client immediately as high priority.
  Escalation: 15h reminder → 48h second reminder → 72h system holding message.
  Holding message signed by company team. Toggle per client, default off.
  Doug can reply on client's behalf via GHL.

Negative reply / opt-out:
  Any refusal or hostile language = immediate suppression. One signal is enough.
  Covers all variations: stop, remove me, not interested, fuck off, leave me alone,
  and any unmistakeable refusal regardless of exact wording.
  Push suppression to Instantly API immediately.

Out-of-office:
  Detect via pattern matching. Pause sequence for that prospect.
  Extract return date. Resume day after. Default: 10 business days if no date found.
  System manages timing and instructs Instantly to resume via API.

Opt-out footer in all outbound emails:
  "Not the right fit? Just reply 'stop' and I'll leave you alone."
  Never use the word "unsubscribe."

---

## Benchmark thresholds — warnings engine defaults

Reply rate:         green >5% | amber 3–5% | red <3% for 2 consecutive weeks
                    below 1% = immediate deliverability investigation flag
Positive reply %:   flag if positive replies drop below 40% of total replies
Bounce rate:        green <1% | amber 1–2% | red >2% | auto-pause above 3%
Spam complaint:     green <0.1% | amber 0.1–0.3% | red >0.3%
Open rate:          directional only — flag if below 15% sustained 2 weeks
Unqualified mtgs:   flag if 3+ consecutive meetings marked unqualified
No-show rate:       flag if 2+ no-shows in same week
Doc refresh:        automated warm email to client every 90 days

All thresholds configurable per client in operator settings.

---

## Pipeline visibility — phased unlock

Months 1–2: strategy and setup view is the default. Pipeline view is locked.
Unlock trigger: 2 months elapsed OR 5 meetings booked, whichever comes first.
Trend line visible: after 8 weeks of campaign data.
Trend line dominant: after 12 weeks.
Contract status, engagement month, payment status: operator view only, never client-facing.

---

## Environments — three, never skip staging

development:  local — Supabase local or dedicated dev project
staging:      Vercel preview — automatic on push to any non-main branch
production:   Vercel main — only after staging verified

Separate environment variables in Vercel for each environment.
Never push to production without staging verification.

---

## Code quality

Stack: Next.js 14+, TypeScript, Tailwind CSS, Supabase.
Always TypeScript. Always Tailwind. No inline styles. No separate CSS files.
One component = one responsibility.
Descriptive names: handleApprovalSubmission not handleSubmit.
Plain English comment above complex logic explaining WHY it exists.
Never use console.log, console.error, or console.warn directly in application code.
All log output goes through the project's single logger module.
This enables structured logging, Sentry integration, and log level control.
The logger module is created at project setup and imported everywhere logging is needed.
Debug-level logs must not appear in production — use log level guards.

---

## Hooks — three checks always active

These run at the specified trigger points in every session. Never skip them.

### Pre-commit: .env check
Before any commit, verify .env is in .gitignore.
  Run: grep '\.env' .gitignore
If .env is not listed, add it and commit the updated .gitignore first.
Never proceed with a commit if .env could be tracked by Git.

### Pre-commit: tool-name reference check
Before committing any new or modified agent or component file, scan for hardcoded
tool names: Instantly, Taplio, Lemlist, Apollo, GoHighLevel, Calendly, HunterIO.
Hardcoded tool names belong only inside handler functions in the integrations layer.
If a hardcoded tool name appears in an agent or component, flag it before committing.

### Post-edit: TypeScript type check
After editing any TypeScript file, run: npx tsc --noEmit
Confirm no type errors were introduced before moving to the next step.
Do not commit TypeScript files with type errors.

---

## What not to build

Do not build:  email sending        → Instantly
Do not build:  LinkedIn scheduling engine  → Taplio handles content delivery after dashboard approval; no API integration
Do not build:  LinkedIn DMs         → Lemlist
Do not build:  CRM                  → GoHighLevel
Do not build:  prospect database    → Apollo
Do not build:  email signatures     → configure in Instantly per client
Do not build:  booking system       → Calendly or client's existing tool

---

## Anti-patterns — never

Never hardcode a tool name where a capability reference belongs.
Never hardcode client_id or user_id in application code.
Never return Supabase data without RLS or explicit client_id filter.
Never show operator-only data in a client-visible component.
Never write directly to a strategy document — always use suggestion queue.
Never write directly to the patterns table except from the aggregation agent.
Never skip staging for any reason.
Never end a session without committing completed work.
Never make an architectural decision silently — always name it to Doug.
Never proceed past a blocker without explaining it in plain English first.

---

## When something breaks

1. Read the Sentry error. It says exactly what broke and where.
2. Check the relevant /docs file. It explains what the component connects to.
3. Explain to Doug in plain English what happened before suggesting anything.
4. Make one targeted change. Test. Commit if it resolves the issue.
5. If stuck: open claude.ai, share the Sentry error, the relevant /docs section,
   and the relevant /prd section. That context is enough to diagnose almost anything.

The /docs and /prd folders exist specifically for recovery.
Update them every session so they are useful when needed most.

---

## Code behaviour principles

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Deterministic code first — LLM only when judgment is required

See ADR-018.

When introducing any new component, state explicitly whether it is deterministic
code or uses an LLM call. Default: deterministic. An LLM must be justified by a
specific judgment or synthesis requirement that rules cannot meet at acceptable
quality.

Use LLMs for: creative synthesis (document generation, prospect research triggers,
reply classification, generated copy critique).

Use deterministic code for: counting, filtering, routing, threshold evaluation,
scheduling, pattern matching on predictable text.

When in doubt, build the deterministic version first. It is almost always cheaper
and faster to add an LLM layer later than to simplify an LLM-dependent system.

---

## ADR reference list — as of April 2026

For quick reference. Full text in /docs/ADR.md.

  ADR-001  Tool-agnostic capability registry over direct integrations
  ADR-002  Suggestion queue over autonomous document updates
  ADR-003  Agent isolation enforced at three levels (RLS + app filter + prompt)
  ADR-004  Taplio as publishing layer only, dashboard as approval layer
  ADR-005  No LinkedIn scraping in prospect research
  ADR-006  Lemlist for LinkedIn DMs, not La Growth Machine
  ADR-007  Reply handling automated for positive replies only in Phase 1
  ADR-008  Pipeline view hidden for first two months
  ADR-009  MargenticOS runs as client zero before any paying clients
  ADR-010  Taplio integration is dashboard content delivery, not scheduling API
  ADR-011  Signal threshold logic and A/B testing deferred to Phase 2
  ADR-012  Messaging agent writes one document_suggestions row with full_document replacement
  ADR-013  Model version selection for agents
  ADR-014  Multi-variant template rotation now, per-prospect generation future
  ADR-015  ICP Filter Specification and tool-agnostic sourcing
  ADR-016  TAM gate and inventory-driven sourcing
  ADR-017  Tiered enrichment and sending routing
  ADR-018  Deterministic code vs LLM usage principles

---

## PRD section reference list — as of April 2026

  01-product.md         Target client, offer, commercial model
  02-stack.md           Technology stack, tool registry pattern
  03-data-model.md      All database tables, fields, RLS policies
  04-auth.md            Authentication, roles, multi-user access
  05-intake.md          Questionnaire, file upload, website ingestion
  06-agents.md          All agents: purpose, inputs, outputs, isolation
  07-feedback-loop.md   Signal thresholds, suggestion queue, A/B testing
  08-approval.md        Channel modes, notification timing, batch sampling
  09-reply-handling.md  Reply types, routing, escalation, opt-out
  10-signals.md         Signal types, processing, pattern library
  11-warnings.md        Warning types, thresholds, tiered response protocol
  12-dashboard.md       All views, components, phased unlock
  13-integrations.md    Registry pattern, each tool, webhook events, setup
  14-phasing.md         Phase one through four with deliverables
  15-sourcing.md        Prospect sourcing pipeline (new, April 2026)
