# ADR.md — Architecture Decision Record
# MargenticOS | Started April 2026
#
# Purpose: A running log of significant architectural decisions, why they were made,
# and what was considered but rejected. Updated as new decisions are made.
# When something feels wrong mid-build, check here first — it may already be resolved.
#
# Format per entry:
#   ## ADR-NNN — Decision title
#   Date | Status: Accepted / Superseded / Under review
#   Context: why a decision was needed
#   Decision: what was chosen
#   Reasoning: why
#   Rejected alternatives: what else was considered and why it lost
#   Consequences: what this means for the build going forward

---

## ADR-001 — Tool-agnostic capability registry over direct tool integrations
Date: April 2026 | Status: Accepted

Context:
The product depends on multiple external tools (Instantly, Taplio, Lemlist, Apollo,
GoHighLevel, Calendly). These tools will change over time — better alternatives will
emerge, pricing will shift, APIs will break. Building direct integrations to each tool
creates a codebase where every tool swap requires significant refactoring.

Decision:
All external tools are registered in an integrations_registry table. The system
references capabilities (can_send_email, can_schedule_linkedin_post) not tool names.
A handler function maps each capability to whichever tool is currently registered.

Reasoning:
Swapping a tool becomes: update the registry + write a new handler. Nothing else changes.
Adding a new tool becomes: new registry row + new handler. Zero impact on existing code.
This is the decision that makes the entire product extensible without rebuilds.

Rejected alternatives:
- Direct tool integrations (e.g. import Instantly directly into agents): rejected
  because every tool swap becomes a codebase refactor. At 5+ tools, this is unmanageable.
- Abstraction layer per tool category: considered but adds unnecessary complexity
  when the registry pattern is simpler and achieves the same goal.

Consequences:
Every new integration must register in integrations_registry first.
No agent or component may reference a tool name directly in code.
Handler functions are the only place where tool-specific code lives.

---

## ADR-002 — Suggestion queue over autonomous document updates
Date: April 2026 | Status: Accepted

Context:
The feedback loop (agents learning from campaign signals and updating strategy documents)
is the core intelligence layer. The question is whether agents update documents directly
(autonomous) or write suggestions for Doug to review (queued).

Decision:
Agents write to document_suggestions. Doug reviews and approves.
Documents never update directly from agent output.

Reasoning:
Autonomous updates at launch create undetectable quality failures — an agent making
a bad update based on thin signal produces a document the client trusts, and it's wrong.
The suggestion queue keeps a human in the loop as quality gate during the period
when signal volume is low and agent judgment is unproven.

The architecture to full autonomy is additive: add a confidence_threshold field,
add one condition to the queue processor. Nothing gets rebuilt.
The suggestion queue IS the autonomous update system, minus one condition.

Rejected alternatives:
- Full autonomy from day one: rejected because the risk of a bad document update
  reaching a client before enough signal history exists is too high.
- Manual-only updates forever: rejected because the whole value proposition of
  MargenticOS is that it learns and self-improves.

Consequences:
document_suggestions table must exist before any feedback loop agents are built.
The rule "agents never modify documents directly" must be enforced in code review
and in every agent's system prompt.
Auto-approve (phase four) adds one field and one condition — same architecture.

---

## ADR-003 — Agent isolation enforced at three levels
Date: April 2026 | Status: Accepted

Context:
Multiple clients run through the same agent pipeline. The risk is that an agent
processing Client A's signals accidentally reads or writes Client B's data —
either through a missing filter or through the pattern library cross-contamination.

Decision:
Three-level enforcement:
1. Database: RLS policies on all tables prevent cross-client queries at data level
2. Application: explicit client_id filter on every Supabase query
3. Agent prompts: no prompt references any data source outside current client context

The patterns table is the only cross-client data store.
It is written ONLY by the dedicated pattern aggregation agent.
It contains anonymised aggregated insights — never raw client data.

Reasoning:
A data leak between clients is the most serious possible error in this system.
Client A's ICP data appearing in Client B's outbound is a catastrophic trust failure.
Three levels of enforcement is not overkill — it is proportionate to the severity.

Rejected alternatives:
- RLS only: rejected because application bugs can still bypass RLS in edge cases.
- Application-level only: rejected because RLS is the last line of defence if
  application code has a bug.
- Single enforcement level: rejected — defence in depth is correct here.

Consequences:
Every agent invocation must pass client_id as a required parameter.
Every query must include explicit client_id filter even when RLS would catch it.
The pattern aggregation agent is the only writer to the patterns table, ever.

---

## ADR-004 — Taplio as publishing layer only, dashboard as approval layer
Date: April 2026 | Status: Accepted

Context:
Taplio is the chosen LinkedIn content scheduling tool. The question is whether
MargenticOS should programmatically push posts to Taplio, or use Taplio as the
final publishing step after dashboard approval.

Decision:
MargenticOS dashboard is the approval layer. Taplio is the publishing layer.
Agent generates post → client approves in dashboard → approved post pushed to Taplio queue
manually or via Zapier. No direct programmatic API calls to schedule posts in Taplio.

Reasoning:
Taplio has no public API for programmatic post scheduling. This was verified directly.
Additionally, Taplio had its own LinkedIn page temporarily restricted in 2024 due to
cookie-based automation — the platform risk is real.
The semi-manual Zapier approach works reliably without violating any terms.

Rejected alternatives:
- Direct Taplio API integration: rejected — the API does not exist for scheduling.
- Building a custom LinkedIn posting tool: rejected — scope creep, platform risk,
  and the tool-agnostic architecture means Taplio can be swapped if needed.

Consequences:
The handler for can_schedule_linkedin_post manages the Zapier/manual flow.
If Taplio is replaced in future, the handler is rewritten — the dashboard approval
flow and approval UI remain unchanged.

---

## ADR-005 — LinkedIn scraping is not used in the prospect research agent
Date: April 2026 | Status: Accepted

Context:
The prospect research agent needs to find business-relevant personalisation triggers
for each prospect. LinkedIn profiles are the obvious source. The question is whether
to scrape them.

Decision:
No LinkedIn scraping. The research agent uses:
1. Apollo enrichment API (primary)
2. Targeted web search for Google-indexed public content (secondary)
3. Direct company website fetch (tertiary)
If no trigger found after three steps, fall back to role-based pain proxy.

Reasoning:
LinkedIn actively detects and blocks automated scraping. Their ToS explicitly prohibits it.
Playwright-based scrapers get blocked. Cookie-based approaches get flagged.
A production dependency on scraping creates campaigns that break unpredictably
for paying clients when LinkedIn tightens enforcement.
Apollo plus web search is sufficient for business-relevant personalisation.

Rejected alternatives:
- Playwright-based LinkedIn scraping: rejected — ToS violation, actively blocked.
- PhantomBuster: rejected — operates in the same grey zone, same risk.
- LinkedIn Sales Navigator API: rejected — requires Enterprise contract and LinkedIn
  partnership approval, not accessible at current stage.

Consequences:
The prospect research agent must never make direct LinkedIn API or scraping calls.
Google-indexed LinkedIn post content is acceptable as a byproduct of web search.
Token budget: 3 API calls maximum per prospect (Apollo + web search + website fetch).

---

## ADR-006 — Lemlist for LinkedIn DMs, not La Growth Machine
Date: April 2026 | Status: Accepted

Context:
LinkedIn DM outreach requires a tool with a proper API, safe sending limits,
and reasonable cost. Two leading options were evaluated: Lemlist and La Growth Machine.

Decision:
Lemlist. Registered via can_send_linkedin_dm capability in the tool registry.

Reasoning:
Lemlist has a well-documented REST API and multichannel support including LinkedIn.
La Growth Machine is more powerful but more complex and significantly more expensive.
Since the tool-agnostic architecture makes swapping trivial (one new handler),
starting with the simpler and cheaper option is correct.

Rejected alternatives:
- La Growth Machine: rejected at this stage due to higher cost and complexity.
  Remains a valid future option if Lemlist proves limiting.
- Taplio Outreach: rejected — Taplio has no reliable API for DM automation.
- Building custom LinkedIn DM tooling: rejected — scope creep and platform risk.

Consequences:
Lemlist API capabilities must be verified before phase two build begins.
Daily sending limits must be configured: ~20–30 connection requests/day,
~50–80 DMs/day per account to protect client LinkedIn accounts from restriction.
If Lemlist proves insufficient, swap via tool registry — no other code changes.

---

## ADR-007 — Reply handling is automated for positive replies in phase one only
Date: April 2026 | Status: Accepted

Context:
Multiple reply types need handling: positive (wants to book), information requests,
negative replies, opt-outs, and out-of-office. The question is which to automate
at launch and which to keep manual.

Decision:
Phase one automates positive replies only.
Information requests: notify client and Doug, no automated response.
Negative replies and opt-outs: automated suppression via Instantly API.
Out-of-office: automated pause and resume via Instantly API.

Reasoning:
Positive replies are the most commercially time-sensitive — a prospect who expressed
interest and waits 24 hours for a response is a lost meeting. Full automation is safe
here: just include the booking link and a warm sign-off.
Information requests require nuanced human judgment about the specific offer —
the wrong automated response can kill a warm lead. Keep human.
Suppression and OOO management are mechanical and safe to automate immediately.

Rejected alternatives:
- Fully manual reply handling: rejected because positive replies will be missed
  when Doug is not actively monitoring, losing meetings for clients.
- Fully automated including information requests: rejected because early-stage
  agents lack the context and judgment to handle complex offer questions reliably.

Consequences:
AI reply agent for positive replies is a phase one build.
Information request escalation (15h, 48h, 72h) is a phase one build.
Suppression and OOO handling are phase one builds.
More sophisticated reply automation is a phase three addition.

---

## ADR-008 — Pipeline view hidden for first two months
Date: April 2026 | Status: Accepted

Context:
New clients in months 1–2 will see low pipeline numbers as campaigns warm up.
If the pipeline view is the default, early low numbers create anxiety and doubt
about the service before it has had time to generate results.

Decision:
Default view for months 1–2 is the setup and strategy view.
Pipeline view unlocks after 2 months elapsed OR 5 meetings booked, whichever first.

Reasoning:
The strategy documents are complete and impressive from day one.
Keeping focus on the documents (the IP the client owns permanently) during the
warming period keeps the client confident rather than anxious.
When the pipeline view unlocks, it has enough data to be meaningful.

Rejected alternatives:
- Always show pipeline view: rejected because low early numbers undermine
  client confidence before the system has had time to work.
- Never show empty states: rejected because the client needs to know the system
  is working and campaigns are being set up.

Consequences:
The empty state view (setup steps, launch countdown, strategy panel) must be
designed and built as a first-class view, not an afterthought.
The unlock trigger (2 months OR 5 meetings) must be implemented in phase one.

---

## ADR-009 — MargenticOS runs as client zero before any paying clients
Date: April 2026 | Status: Accepted

Context:
The system needs to be proven before Doug puts a paying client through it.
This requires a real test with real campaigns, real signals, and real data.

Decision:
MargenticOS itself is client zero. Doug fills out the intake questionnaire,
generates the four strategy documents for MargenticOS, connects all integrations,
runs live cold email and LinkedIn campaigns for MargenticOS's own pipeline generation,
and monitors the full system end-to-end before onboarding a paying client.

Reasoning:
Every integration gets tested against real data.
Every webhook gets verified against live campaign events.
The dashboard shows real metrics, not synthetic test data.
The case study produced from client zero (results for MargenticOS itself)
becomes the primary sales asset for acquiring founding clients.

Rejected alternatives:
- Synthetic test data only: rejected because synthetic data cannot reveal real
  integration failures, webhook timing issues, or agent quality problems.
- First paying client as the test: rejected because client trust is at stake.

Consequences:
All phase one integrations must be connected and tested against MargenticOS data.
The MargenticOS organisation record is the first row in the organisations table.
Phase two cannot be considered complete until MargenticOS has run live campaigns.

---

## ADR-010 — Taplio integration model is dashboard content delivery, not scheduling API
Date: April 2026 | Status: Accepted

Context:
As the build moved from planning to implementation, the Taplio integration required
a precise definition: exactly what does "integrating with Taplio" mean in practice?
There was a risk that developers would attempt to build a programmatic scheduling
integration (auto-pushing posts via API), which does not exist and cannot work.

Decision:
The Taplio integration in phase one is a content delivery model, not a scheduling
integration. The dashboard is the approval and queueing layer. Once a LinkedIn post
is approved in the MargenticOS dashboard, the operator (Doug) delivers that content
to Taplio manually or via a Zapier workflow. No programmatic API call to Taplio is
built, attempted, or referenced in the codebase.

The can_schedule_linkedin_post capability handler reflects this: it marks content
as approved and ready-to-deliver, then signals the operator — it does not push
to an external API.

Reasoning:
Taplio has no public API for programmatic post scheduling (verified directly, April 2026).
Taplio also had its own LinkedIn page temporarily restricted in 2024 due to cookie-based
automation — there is genuine platform risk in attempting unofficial API access.
The dashboard-first, operator-delivered model is safe, reliable, and works today.
If a proper API or safer integration becomes available, the handler is the only
change required — the approval flow and dashboard UI are unchanged.

This ADR supersedes any reference to "Taplio scheduling integration" in earlier
planning documents or prompts. All references should be read as "Taplio content
delivery after dashboard approval."

Rejected alternatives:
- Programmatic Taplio API scheduling: rejected — the API does not exist.
- Cookie-based or session-based automation: rejected — platform risk, ToS violation.
- Building a custom LinkedIn posting tool: rejected — scope creep and platform risk.

Consequences:
No agent or component may attempt a direct API call to Taplio for post scheduling.
The Taplio section in sections/13-integrations.md reflects the content delivery model.
Phase one build scope for LinkedIn posts: generate → dashboard approval → operator delivery.
Future API availability would require only a handler rewrite — no architectural change.

---

## ADR-011 — Signal threshold logic and A/B testing deferred to phase two
Date: April 2026 | Status: Accepted

Context:
The feedback loop specification includes a tiered signal threshold system
(3 signals → informational, 5 signals → A/B test, 10 signals + winner → high-confidence
suggestion), an A/B testing framework (OVAT, 200 prospects per variant, 15–30% lift),
and conflict resolution logic for competing suggestions. The question is whether to
build this processing logic in phase one alongside the suggestion queue infrastructure.

Decision:
Signal threshold processing logic, A/B test generation, and conflict resolution
between competing suggestions are deferred to phase two.

Phase one delivers:
- The document_suggestions table with all required fields, including signal_count,
  confidence_level, ab_variant, and conflicting_suggestion_id
- The schema is complete and forward-compatible with phase two processing logic
- No threshold evaluation, A/B variant generation, or conflict surfacing is implemented

Phase two delivers:
- The signal threshold processing logic (3/5/10 tier evaluation)
- A/B variant generation when the 5-signal threshold is crossed
- Conflict resolution UI and logic when competing suggestions exist for the same field
- This work begins when there is sufficient real campaign data to make it meaningful

Reasoning:
With 3–5 founding clients in phase one, signal volume will be thin for weeks or months.
Building complex threshold and A/B logic against sparse data produces no value and
adds maintenance surface area before it can be validated.
The schema-first approach means the phase two build is additive — processing logic
is layered onto a table that already has the right shape.
Flagging to Doug when campaign data reaches meaningful volume ensures the logic
is built at the right time, not speculatively.

Rejected alternatives:
- Build full threshold logic in phase one: rejected because there will be insufficient
  signal volume for months, making the logic untestable and unvalidatable at launch.
- Defer schema as well as logic: rejected because retrofitting the schema later
  is a migration risk. Schema is cheap to build now; logic is not.

Consequences:
document_suggestions table must include signal_count, confidence_level, ab_variant,
and conflicting_suggestion_id fields from day one, even though they are not yet used.
Any developer or agent working on the feedback loop must not implement threshold
evaluation or A/B generation unless Doug has explicitly approved it for the current phase.
Flag to Doug when founding client campaign data reaches a volume where this logic
becomes meaningful — this is the trigger to begin phase two feedback loop work.

---

## ADR-012 — Messaging agent writes one document_suggestions row with full_document replacement
Date: April 2026 | Status: Accepted
Note: supersedes the four-row approach described in an earlier draft of this entry (refactored in commit fb5b5af).

Context:
The messaging agent generates a cold outbound email sequence. An earlier implementation
wrote four separate rows to document_suggestions — one per email, tagged with
sequence_position. This was refactored because it diverged from the pattern used by
all other document generation agents and complicated the approval handler.

Decision:
The messaging agent writes one row to document_suggestions per run.
- field_path: 'full_document'
- suggested_value: a structured JSON object containing { emails: [...] }, where each
  element in the array is one email with its subject line, body, and position
- document_type: 'messaging'

This matches the full-document replacement pattern used by the ICP, positioning, and
tone of voice agents. All four agents write one row; all four use field_path 'full_document'.

The array length is not hardcoded. A sequence of 4 emails is the current default,
but changing to 5, 6, or more emails requires only a prompt change — no schema
migration and no handler change.

Reasoning:
All other document agents write a single full-document suggestion row. The four-row
approach created a special case in the approval handler — the handler had to detect
messaging suggestions, group them by position, and treat them differently from every
other document type. That conditional complexity is eliminated by using the same pattern.
The full sequence must be generated as a coherent unit regardless of how it is stored —
angle progression, threading, and word count relationships are enforced in the prompt,
not by the storage model. There is no functional reason to split storage.

Rejected alternatives:
- Four separate rows (previous implementation): rejected because it required special
  approval handler logic and diverged from the full-document pattern without benefit.
- Separate agent runs per email: rejected because coherence across the sequence
  (angle progression, threading) requires all emails to be generated together.

Consequences:
The approval handler treats messaging suggestions identically to all other document types
at the API layer: one pending row, one approval action, one approved row written to
strategy_documents. However, the approve_document_suggestion Postgres function contains
a messaging-specific branch that unwraps the { emails: [...] } wrapper object before
writing to strategy_documents.content — storing the bare JSON array rather than the
envelope object. All other document types (ICP, positioning, TOV) store the full JSON
object as content. This means messaging content in strategy_documents is a JSON array
while all other document types are JSON objects. Any future messaging renderer must
handle Array.isArray(content) as the primary format check before any object-based
key lookups. Sequence length changes require only prompt edits.

Follow-ups:
- Consider normalising messaging storage to { emails: [...] } object shape to match
  ICP/positioning/TOV pattern. Would require a database migration for existing rows
  and an update to the approve_document_suggestion function. Defer until post-client-zero.

---

## ADR-013 — Model version selection for agents
Date: April 2026 | Status: Accepted (updated April 2026 — messaging agent switched to Sonnet)

Context:
CLAUDE.md specifies model versions for each task category. As the agents were built,
actual model selections diverged from the CLAUDE.md references — the agents are
implemented and the spec document was not kept in sync. This ADR records the settled
decisions so the agents remain the authoritative source of truth.

Decision:
Document generation agents (ICP, positioning, tone of voice): claude-opus-4-6
Messaging generation agent: claude-sonnet-4-6 (see update note below)
Reply drafting (reply-draft-agent): claude-sonnet-4-6
Web search utility (lightweight synthesis in prospect research agent): claude-haiku-4-5-20251001
Building, debugging, refactoring (Claude Code tasks): claude-sonnet-4-6
Signal processing and batch tasks: claude-haiku-4-5-20251001

Model versions must be passed explicitly in every Anthropic API call.
Never rely on API defaults. If a model is retired or replaced, update the relevant
agent file directly — CLAUDE.md is a human reference, not the source of truth.

Update — April 2026 (messaging agent model change):
The messaging agent was switched from claude-opus-4-6 to claude-sonnet-4-6 after
Opus API calls consistently timed out at approximately 180 seconds during local
development. The root cause is the local network (router/macOS TCP stack) dropping
connections that appear idle — Opus takes longer to begin streaming tokens, which
triggers the idle-connection timeout before the first byte arrives.
Switching the API call to streaming mode (client.messages.stream) resolved the
issue for Sonnet, which begins returning tokens faster. Opus with streaming was not
fully tested because the connection dropped before the first token arrived.
Action required before production: test the messaging agent with claude-opus-4-6
and streaming mode on a stable connection (production server or wired connection).
If the timeout no longer occurs, revert MESSAGING_MODEL in the agent file and
update this entry.

Reasoning:
claude-opus-4-6 is the intended model for all document generation — highest-value,
most context-intensive task in the system. The Sonnet switch is a pragmatic
local-dev workaround, not a quality decision. Sonnet output for the messaging agent
was reviewed and judged acceptable for the client-zero test run.
claude-haiku-4-5-20251001 is appropriate for the web search synthesis step, which
requires lightweight summarisation of fetched content, not deep reasoning.

Rejected alternatives:
- claude-opus-4-5 for document generation: superseded by claude-opus-4-6.
- Relying on API defaults: rejected because defaults change without notice.

Consequences:
ICP, positioning, and tone of voice agent files specify claude-opus-4-6 explicitly.
Messaging agent file specifies claude-sonnet-4-6 until Opus connection issue resolved.
Reply-draft-agent specifies claude-sonnet-4-6. Rationale: reply drafts are short-form
conversational text, not deep synthesis. Sonnet is appropriate here. Opus is not needed.
The web search utility specifies claude-haiku-4-5-20251001 explicitly.
CLAUDE.md model selection table reflects current state (Sonnet for messaging).
When Anthropic releases a new model family, update agent files directly and record
the change here — do not rely on CLAUDE.md as a change trigger.

---

## ADR-014 — Sequence composition approach: multi-variant template rotation with generated mode planned
Date: April 2026 | Status: Accepted

Context:
The prospect research agent produces a personalisation trigger per prospect using the
Trigger-Bridge-Value framework. A decision was needed on how that trigger is used to
compose the outbound email sequence for each prospect. Three original options were
evaluated (trigger replaces opener, trigger injected as sentence, per-prospect
generation), then refined through analysis into two viable approaches.

Decision:
Implement Option E — multi-variant template rotation — as the default composition mode
for all clients. Option D — per-prospect generated sequences — is specced as a named
future mode, togglable per client, with explicit prerequisites before it can be enabled.

Option E — what gets built now:
The messaging agent generates four distinct sequence variants at document generation
time, not one. Each variant covers the same ICP and offer but uses a different angle,
opening approach, or CTA structure. All four variants go through the existing approval
flow — the operator reviews and approves all four sequences before any prospect
receives them.

At send time, the composition handler assigns a variant to each prospect (round-robin
rotation initially, performance-weighted rotation once signal data exists). The prospect
research agent's trigger is applied to email 1's opener of the assigned variant. Emails
2–4 are fixed within the variant.

A variant_id field is added to the prospects table to track which variant each prospect
received. Reply rate and meeting conversion are tracked per variant via the existing
signals table. Variant performance surfaces in the operator view signals log.

Option D — specced for future use:
Option D is a second composition mode where the sequence is generated fresh per prospect
at send time, using the trigger and the approved variant as structural constraints.
Every prospect receives unique copy across all four emails.

Option D is not built now. The risks that preclude it at this stage are:
The quality gate is insufficient. The post-processor catches formatting issues, not copy
quality. Per-prospect generated sequences cannot be reviewed before sending at volume.
Without a strong automated quality gate, slop reaches prospects' inboxes undetected.
The Haiku critic pass is not yet built. This is the prerequisite quality gate for
Option D — a structured evaluation of generated sequences against TOV compliance,
messaging rules, and quality standards before sequences are approved to send. It is
currently in the pre-client-zero gates and must be built and validated before Option D
is enabled for any client.

When Option D is ready to test, it is enabled via a per-client toggle in the operator
settings view: "Sequence generation: Template / Generated." Default for all clients is
Template. The toggle is only switched for a designated test client. All other clients
remain on Option E.

Prerequisites before Option D can be enabled for any client:
- Haiku critic pass built and validated against client zero output
- Post-processor extended to evaluate generated sequences, not just template sequences
- Generation prompt validated against minimum quality bar (defined by variant
  performance data from Option E)
- Operator approval flow confirmed to surface generated sequences before send

Reasoning:
Option E deploys AI-generated copy that has been reviewed and approved before any
prospect sees it. The quality floor is whatever passes the approval flow. The ceiling
is limited by variant rigidity in emails 2–4, but that is a known and manageable
limitation at founding client volumes.

Option D's quality floor is whatever the model produces at send time, gated only by
the post-processor. That gate is not strong enough yet. The risk is not AI-generated
copy — it is ungated AI-generated copy reaching prospects before a sufficient quality
gate exists. That risk is not mitigated by time or by having more clients — it is
mitigated by building the Haiku critic pass and validating it against real output.

The per-client toggle means Option D can be tested on one client without exposing all
clients. The architectural cost of adding the toggle later is minimal — the composition
handler already exists, the settings UI already exists.

Rejected alternatives:
- Option A (trigger replaces email 1 opener, single template): rejected because
  identical emails 2–4 across all prospects on a single sequence is a domain reputation
  risk at scale and provides no directional performance signal.
- Option B (trigger injected as sentence): rejected as a subset of Option A's
  limitations with an additional structural awkwardness at the seam.
- Option C (per-prospect generation of email 1 only): rejected as the worst of both
  worlds — pays the generation cost but only personalises one email.

Consequences:
The messaging agent prompt must be updated to generate four variant sequences instead
of one. The approval UI must handle four variants per client. The prospects table
requires a variant_id field. The composition handler reads the assigned variant and
applies the trigger to email 1. Variant performance is tracked via the existing signals
infrastructure. The operator settings view gets a "Sequence generation" toggle,
defaulting to Template for all clients.

---

## ADR-015 — ICP Filter Specification and tool-agnostic sourcing
Date: April 2026 | Status: Accepted

Context:
The product needs to source prospects at scale (~400–1,300 qualified prospects per
client per month at planning-to-pessimistic volume) and the sourcing tool must remain
swappable per ADR-001. Without a structured specification layer between the ICP
document and the sourcing tool, every tool swap would require re-deriving filter
criteria from the unstructured ICP document. That makes the tool-agnostic pattern
break down exactly where it matters most.

The additional risk: if every client's ICP is translated ad-hoc into Apollo filters
at onboarding time, there is no persistent record of what filters are actually being
applied, no way to audit or refresh them, and no way to ensure consistency across
sourcing runs.

Decision:
The ICP generation agent produces two artefacts per run, not one:
  1. The ICP strategy document (unchanged, human-readable, stored in strategy_documents)
  2. An ICP filter specification (new, machine-readable, structured JSON)

The filter specification is stored alongside the ICP document and approved by Doug
via the same approval flow — one review, one approval, both artefacts activate together.

The filter specification is tool-agnostic. Each sourcing handler declares which fields
it supports. The sourcing orchestrator refuses to execute a run if the active handler
cannot support every field the client's spec uses.

Filter specification v1 schema (13 filter fields + 1 meta field):
  Universal fields (every tier-1 B2B data provider supports these):
    job_titles                  array of strings
    job_titles_excluded         array of strings
    seniority_levels            array: c_suite, vp, director, manager, senior, entry
    departments                 array of strings (sales, marketing, engineering, etc.)
    person_countries            array of ISO-3166 alpha-2 codes
    company_countries           array of ISO-3166 alpha-2 codes
    company_headcount_min       integer
    company_headcount_max       integer
    industries                  array of canonical NAICS-derived names
    industries_excluded         array of canonical NAICS-derived names
    keywords                    array of free-text company keywords
    keywords_excluded           array of free-text company keywords

  Extended fields (supported by most tier-1 providers, occasional gaps):
    company_revenue_min         integer, optional
    company_revenue_max         integer, optional
    company_age_min_years       integer, optional
    company_age_max_years       integer, optional
    technologies_used           array, optional
    funding_stage               array, optional
    funded_since                ISO date, optional

  Meta field:
    notes                       freetext — operator-only, strategic rationale

Canonical industry taxonomy:
  Internal storage uses NAICS-derived canonical names (e.g. "Management Consulting",
  not Apollo's "Business Services" or Instantly's "Consulting"). Each handler owns
  its own translation table from canonical names to tool-specific names.
  NAICS is the standard reference taxonomy for B2B data providers; most publish
  mappings to it. Doug never sees NAICS codes directly — the UI shows canonical
  names only.

Handler capability declaration:
  Each sourcing handler exports a supported_fields manifest listing which fields
  from the spec it can apply as filters. The sourcing orchestrator checks the
  active handler's manifest against the client's approved spec before running.
  If a client's spec uses fields the active handler cannot support, the run fails
  with a specific warning to the operator ("Active handler X cannot filter on
  field Y used in this client's ICP. Options: switch handler, remove field from spec").

Signal-based fields (intent data, hiring signals, recent tech changes) are NOT
included in v1. They are tool-specific in how they work, and modelling them in a
tool-agnostic way requires per-handler design that is not worth doing until the
need is real. They are deferred to a future version of the spec.

Reasoning:
The spec is forward-compatible with every major B2B data provider (Apollo, Clay,
ZoomInfo, Cognism, Lusha, Instantly B2B Lead Finder, UpLead, Prospeo). All 13 fields
are standard dimensions in the industry. Storing them as structured data rather than
free-text in the ICP document means sourcing runs are deterministic and auditable.

Handler-declared capabilities let the system detect fidelity loss at swap time
rather than silently producing lower-quality results. If Instantly B2B Lead Finder
replaces Apollo for a specific client and cannot support the `funding_stage` filter
in that client's ICP, the operator sees a warning and decides how to proceed.

NAICS as the canonical taxonomy was chosen because it is a government standard,
comprehensively covers B2B industry categories, and is either used directly or
mapped to by every serious B2B data provider. Custom taxonomies were considered
and rejected because the per-provider translation cost would be higher, not lower.

Rejected alternatives:
- Lowest-common-denominator schema (only fields every tool supports): rejected
  because it loses filtering capability Apollo genuinely provides, forcing low-quality
  sourcing at launch.
- Per-client custom filter formats: rejected because it eliminates the auditability
  benefit and makes sourcing non-portable across handlers.
- Letting the sourcing handler parse the ICP document text directly: rejected because
  it produces non-deterministic results and breaks the tool-agnostic principle.
- Including signal-based fields (intent, hiring signals) in v1: rejected because
  modelling them in a tool-agnostic way requires design work not yet justified.

Consequences:
The ICP generation agent must be extended to produce the structured filter spec
alongside the human-readable document, in a single run.
A new column icp_filter_spec (jsonb) is added to strategy_documents, populated
when document_type = 'icp'.
The approval UI must surface the filter spec as a secondary panel so Doug can
sanity-check filter translations before approving.
Each sourcing handler must export a supported_fields manifest.
The sourcing orchestrator must verify handler support before executing a run.
Signal-based fields (intent, hiring, technographic change) are backlog items,
to be addressed when a client need justifies them.

Follow-ups (tracked in /docs/BACKLOG.md):
- Monitor whether v1's 13 fields prove sufficient across the first 3 founding clients
- Add signal-based fields when the first client's ICP genuinely requires them
- Build the approval UI's filter spec panel (secondary to the document renderer)

---

## ADR-016 — TAM gate and inventory-driven sourcing
Date: April 2026 | Status: Accepted

Context:
Two related problems need to be solved before the sourcing pipeline runs live:

1. Total Addressable Market (TAM) gate: some prospects will have ICPs so narrow
   that the service cannot deliver the promised meeting volume at pessimistic
   conversion rates. Detecting this before taking their money, or at latest before
   campaigns begin, is a quality-of-service and commercial integrity issue.

2. Sourcing cadence: a calendar-based sourcing schedule ("source every Monday")
   produces either stale prospects (data decay ~30% over 6 months) or empty
   inventory (client runs out mid-week and campaigns stall). Neither is acceptable.

Both problems share a root cause: sourcing must be driven by actual client state
(inventory level, addressable universe size) rather than a fixed schedule.

Decision:

Part A — TAM report as a three-state gate:

A TAM query runs at two points in the client lifecycle:

  Pre-sale (operator tool, during discovery call):
    Doug inputs rough ICP criteria in the dashboard operator view.
    The tool calls Apollo's People API Search with per_page=1 and reads
    pagination.total_entries. This endpoint does not consume credits.
    Response time ~2–3 seconds — fast enough for live use on a call.
    Output: estimated addressable universe size, with a classification.

  Post-intake (precise):
    After the client's ICP is formally approved and the filter spec is locked,
    the TAM query re-runs against the exact spec. This either confirms or
    re-classifies the pre-sale estimate.

Three classifications, based on months of coverage at pessimistic volume
(pessimistic = ~1,300 qualified prospects per client per month):

  GREEN — 6+ months of coverage (~7,800+ addressable prospects)
    Strict tiering active, Tier 3 disabled.
    No operator action required.

  AMBER — 4–6 months of coverage (~5,200–7,800 addressable prospects)
    Tier 3 sourcing enabled with loosening rules defined at onboarding.
    Flagged to operator at onboarding and re-flagged when Tier 1+2 inventory depletes.
    Meeting quality per tier monitored to catch Tier 3 degradation.

  RED — below 4 months of coverage (~5,200 or fewer addressable prospects)
    Do not proceed. Commercial conversation required.
    Options: decline, restructure the offer (lower meeting target, higher price
    per meeting), or explicitly agree multi-source strategy with the client.
    Red state blocks automatic activation of the client's sourcing pipeline.

The 4-month red threshold is deliberate: below this, even Tier 3 loosening cannot
maintain the promised volume for a sensible campaign duration. Taking the client
means under-delivering. Operator must consciously override with a recorded reason
if proceeding anyway.

Part B — Inventory-driven sourcing:

A daily Inventory Monitor (deterministic scheduled job, no LLM) runs per client:

  1. Count unused qualified prospects (prospects table, not yet added to a campaign)
  2. Read current send velocity from client config (sends/day across all active
     campaigns and mailboxes)
  3. Calculate business days of sending capacity in current inventory
  4. Evaluate against thresholds:

  FLOOR: 10 business days of send capacity remaining
    → trigger sourcing run automatically
    → sourcing run targets replenishment to ceiling (40 business days)
    → prevents run-dry before sourcing completes and validates

  CEILING: 40 business days of send capacity already in inventory
    → do not source more even if other triggers apply
    → prevents stale inventory (Apollo data decay ~30% within 6 months)

The Monitor does not decide how many prospects to source — it sets a target.
The Sourcing Orchestrator (also deterministic) calculates the actual batch size
needed to replenish to ceiling, applies the client's ICPFilterSpec, routes to the
active sourcing handler, and writes qualified prospects to the prospects table.

Both components are deterministic code. No LLM calls. Low cost, low latency,
predictable failure modes.

Reasoning:

On the TAM gate: pessimistic volume is the right planning basis (see session
architecture work). Four months is the minimum sensible campaign duration before
a client would start questioning results. Below this, the commercial promise
("7–10 qualified meetings per month") cannot be honoured even with Tier 3
loosening. The red state forces an explicit commercial decision rather than a
silent under-delivery.

On inventory-driven sourcing: calendar schedules are what you build when you
don't know what the right trigger is. The right trigger is "client is about to
run out." A 10-day floor gives enough time for sourcing to complete and for
qualified prospects to be verified before campaigns would actually run dry.
A 40-day ceiling prevents stockpiling stale data.

On making the TAM tool work pre-sale: Apollo's People API Search does not consume
credits, runs in seconds, and requires only rough ICP parameters that emerge
naturally in a discovery call. This makes the tool usable as a live sales aid,
which is a commercial win on top of the quality-gate function.

Rejected alternatives:

- Running the TAM check only post-intake: rejected because it means taking money
  from a client who cannot be served. Pre-sale check is a commercial integrity
  requirement.
- Calendar-based sourcing (weekly, per client, fixed day): rejected because it
  produces stale or empty inventory unpredictably, and load-spikes sourcing
  infrastructure on the same day across all clients.
- No ceiling on inventory: rejected because data decay makes stockpiled prospects
  materially worse over time; sourcing extra "just in case" degrades campaign quality.
- Two-state gate (acceptable / unacceptable): rejected because amber is a real
  category — workable with operator awareness and tier loosening rules in place.
  Collapsing it into either green or red produces either false rejections or
  silent under-delivery.
- Relying on operator to manually trigger sourcing: rejected because it requires
  Doug to remember to check inventory per client, which does not scale past ~5 clients.

Consequences:

A new operator dashboard page — TAM Tool — runs Apollo People API Search queries
from operator-entered ICP inputs. Single-purpose, minimal UI, optimised for speed.

The sourcing orchestrator component is built as deterministic code (not an agent).
It reads the approved ICPFilterSpec, the tier configuration for the client, and
the active handler from integrations_registry.

A new field tam_status (text: green / amber / red / override) is added to the
organisations table, set at post-intake TAM report and updated if the ICP changes.

A new field tier_3_enabled (boolean, default false) is added to the organisations
table. Green = false always. Amber = true with loosening rules in client config.
Red with manual override = true with loosening rules and recorded operator reason.

A new field send_velocity_per_day (integer) is added to the organisations table,
calculated from active campaign send limits across mailboxes.

A new Inventory Monitor scheduled job runs daily. Deterministic, no LLM. Logs
execution to agent_runs for observability.

The Sourcing Orchestrator runs when triggered by the Inventory Monitor, or when
manually triggered by the operator. Deterministic, no LLM. Logs execution.

Per-tier meeting quality tracking is added to the signals infrastructure:
prospects carry their tier classification, meetings reference prospects, and the
warnings engine evaluates qualified-meeting-rate per tier. If Tier 3 qualified
rate drops below 40% while Tier 1 is above 70%, a warning surfaces recommending
Tier 3 pause or criteria review.

Follow-ups (tracked in /docs/BACKLOG.md):
- If pessimistic assumptions prove wrong in either direction after client zero,
  recalibrate the green/amber/red thresholds with real conversion data.
- TAM tool caching: if operator runs the same query multiple times during a sales
  call, cache the last N minutes to avoid rate limit issues.
- Consider adding an operator "re-run TAM report" action on the client settings
  page for cases where the client's ICP has meaningfully evolved mid-engagement.

---

## ADR-017 — Tiered enrichment and sending routing
Date: April 2026 | Status: Accepted

Context:
The tier system established in ADR-016 (Tier 1 ideal, Tier 2 good, Tier 3 loosened
for narrow-TAM clients) raises two downstream questions:

1. Enrichment budget: running the full prospect research agent (Apollo enrichment
   + web search + website fetch + LLM trigger synthesis) on every sourced prospect
   is expensive and produces diminishing returns at Tier 3 where conversion is
   naturally lower. Equal research spend across tiers is inefficient.

2. Sending infrastructure risk: Tier 3 templated outreach at volume is inherently
   more spam-sensitive than Tier 1 hyper-personalised emails. If Tier 3 sends
   burn a sending domain's reputation, it cannot be allowed to contaminate the
   Tier 1/2 sends that drive the majority of the client's pipeline.

Both issues have the same shape: tier-based routing decisions affect cost, quality,
and risk in materially different ways, and need to be formalised architecturally.

Decision:

Tiered enrichment — three levels, matching the three tiers:

  Tier 1 — Full research
    Apollo enrichment API (full profile + company data)
    Targeted web search for Google-indexed content
    Direct company website fetch
    LLM trigger synthesis (Trigger-Bridge-Value framework)
    Email 1 opener personalised with the synthesised trigger
    Emails 2–4 follow variant-specific templates
    Cost: ~1–2 Apollo credits per prospect + 1 LLM call per prospect

  Tier 2 — Light research
    Apollo enrichment API only (to verify email and basic firmographic data)
    No web search, no LLM trigger synthesis
    Email 1 opener uses role-based pain proxy (from Messaging Playbook templates)
    Emails 2–4 follow variant-specific templates (same as Tier 1)
    Cost: ~1 Apollo credit per prospect, zero LLM calls

  Tier 3 — Verification only
    Email verification (0.25 Apollo credits per prospect or via Hunter.io once active)
    No enrichment beyond what the sourcing tool returned at list build
    Fully templated sequence with segment-level personalisation only
    (industry + role level, no individual-level touches)
    Cost: minimal per prospect

The composition handler reads the prospect's tier (stored on the prospects table
as sourced_tier) and routes to the appropriate enrichment path. The existing
prospect research agent runs only for Tier 1 and Tier 2 prospects. Tier 3
prospects skip the research step entirely.

Sending routing — separate sending identities per tier:

  Tier 1/2 prospects are sent from the client's primary sending domains.
  These are the reputational assets that carry most of the pipeline value.

  Tier 3 prospects are sent from separate sending domains (a "Tier 3 pool")
  provisioned per client during onboarding only if Tier 3 is enabled
  (i.e. amber TAM status or red with override).

  This isolation is achieved via Instantly's sequence/mailbox assignment, not
  via MargenticOS's own routing. When configuring campaigns in Instantly, the
  operator assigns Tier 1/2 campaigns to the primary mailbox pool and Tier 3
  campaigns to the Tier 3 pool. MargenticOS respects whichever mailbox pool
  Instantly returns on webhook events.

  Domain/mailbox provisioning is covered in /docs/runbooks/sending-setup.md.
  Green-state clients never need a Tier 3 pool (Tier 3 is disabled). Amber
  clients need the pool from onboarding. Red-with-override clients need the
  pool and explicit operator acknowledgement of the quality tradeoff.

Per-tier performance tracking:

  Prospects carry their sourced_tier through the signals pipeline.
  Signals are filterable by tier in the operator view signals log.
  Campaign metrics (reply rate, positive reply rate, meeting rate, qualified
  rate) are calculated both overall and per-tier.
  Warnings engine includes per-tier thresholds: if Tier 3 qualified meeting
  rate falls below 40% while Tier 1 is above 70%, a warning surfaces recommending
  Tier 3 pause or criteria review.

Reasoning:

On enrichment: Tier 1 prospects are where personalisation genuinely moves reply
rate from ~3% to ~6–8%. The research spend justifies itself. Tier 3 prospects,
by definition, are borderline fit — their reply rate will be lower regardless of
personalisation, and the marginal lift from trigger research is small. Spending
equal research dollars across tiers is inefficient. The tier system exists to
let low-TAM clients reach volume; tiered enrichment lets them do so cost-effectively.

On sending isolation: if Tier 3 burns a mailbox (spam complaint rate spikes,
bounce rate climbs), that mailbox goes into quarantine or is rebuilt. If that
mailbox was also sending Tier 1/2 email, the client's best prospects start
landing in spam. The blast radius of Tier 3 mistakes must be bounded.
Per-tier domain pools are the cleanest way to ensure this.

On per-tier quality tracking: without it, a silent Tier 3 quality collapse would
drag down overall metrics without making the cause visible. With it, the operator
sees exactly which tier is struggling and can act.

Rejected alternatives:

- Single enrichment level across all tiers: rejected because it wastes money on
  Tier 3 prospects where research lift is small, and makes Tier 3 campaigns
  economically unviable at pessimistic volume.
- No sending isolation, all tiers on same mailboxes: rejected because it creates
  a systemic risk where a Tier 3 spam incident damages Tier 1/2 pipeline.
- Building a dedicated Tier 3 agent: rejected as scope creep. Tier 3 doesn't need
  an agent — it needs deterministic templated composition. Reuse the existing
  composition handler with a tier-aware branch.
- Tracking all metrics only as an overall average: rejected because it hides
  tier-level quality issues and prevents targeted warnings.

Consequences:

A sourced_tier field (text: tier_1 / tier_2 / tier_3) is added to the prospects table.
Set by the Sourcing Orchestrator at the point of writing qualified prospects.

The prospect research agent entry point is extended to check sourced_tier and exit
early (with a "tier_skipped" status in agent_runs) for Tier 3 prospects.

The composition handler branches on sourced_tier:
  Tier 1: use trigger (from prospect research agent) for email 1
  Tier 2: use role-based pain proxy from the Messaging Playbook templates
  Tier 3: use fully-templated variant with segment-level placeholders only

The signals infrastructure indexes signals by sourced_tier (via prospect_id → tier).
The warnings engine gets a per-tier variant of the qualified_meeting_rate warning.
The operator view signals log gets a tier filter.

The sending-setup runbook (docs/runbooks/sending-setup.md) covers provisioning
rules for the Tier 3 pool — only created if Tier 3 is enabled for that client.

Tier 2 clients may not need per-prospect Apollo enrichment if the sourcing tool
already returned verified email + firmographic data. The composition handler
should check what's already present before calling Apollo again. Apollo is only
called for Tier 2 if data is missing.

Follow-ups (tracked in /docs/BACKLOG.md):
- Monitor per-tier economics once client zero has ~200 prospects in each tier
- Revisit Tier 2 enrichment scope if data from sourcing tool proves sufficient
  without an additional Apollo call
- Consider a "Tier 3 pause" toggle in the operator view for quick deactivation
  during quality incidents

---

## ADR-018 — Deterministic code vs LLM usage principles
Date: April 2026 | Status: Accepted

Context:
As the build progresses, there is a temptation to reach for an LLM whenever a
decision needs to be made. Every LLM call adds cost, latency, and a non-deterministic
failure surface. Used where rules would suffice, LLMs increase operational risk
without increasing quality. Used where judgment is genuinely required, LLMs are
what makes the product work.

Without an explicit principle, future Claude Code sessions will drift toward
"use an LLM" by default because it is the more flexible-feeling option in the
moment. This degrades the system over time.

Decision:

LLMs are used where judgment or synthesis is genuinely required.
Deterministic code is used where the decision is rule-based or thresholded.

Default: deterministic code. An LLM must be justified by a specific judgment or
synthesis requirement that rules cannot meet at acceptable quality.

LLM is appropriate when:
  - The input is unstructured (free text, web content, varied writing samples)
    and must be turned into structured output
  - The decision involves tone, voice, persuasion, or other qualities that cannot
    be specified as rules without producing low-quality output
  - The task is creative synthesis (generating a strategy document from an intake,
    composing email copy, researching a prospect trigger)
  - Nuanced classification is required where pattern matching fails (reply intent:
    positive vs information request vs hostile)
  - Quality judgment is required on other LLM output (critic pass on generated copy)

Deterministic code is appropriate when:
  - Inputs are structured (database fields, API responses, numeric thresholds)
  - The decision can be expressed as rules, conditions, or thresholds
  - The task is counting, filtering, routing, or aggregating
  - The task is pattern matching on predictable text (OOO detection, unsubscribe
    keywords, email format validation)
  - The task is scheduling, monitoring, or alerting based on measurable conditions

Current implementation map (Phase 1):

  LLM-driven (judgment):
    ICP / Positioning / TOV / Messaging generation agents
    Prospect research agent (trigger synthesis)
    Reply handling agent (classification and response generation)
    Future: Haiku critic pass on generated copy

  Deterministic (rules):
    Inventory Monitor (count, compare, trigger)
    Sourcing Orchestrator (read spec, call handler, route results)
    TAM Handler (translate UI input to API call, return count)
    Tier Classification (rule-based on filter spec match)
    Deliverability Monitor (threshold evaluation on metrics)
    Signal Processing Agent (logging and categorisation — Phase 1 scope only)
    OOO pattern matching in replies
    Suppression keyword detection

Borderline cases — decide consciously:
  Some qualification tasks may seem to need judgment but actually resolve with
  rules. Before building an agent for borderline cases, first write out the
  rules that would apply. If the rules produce acceptable quality, use them.
  Only if rules genuinely fail should an LLM be introduced, and it should be
  scoped narrowly (e.g. "LLM evaluates only this one ambiguity, everything else
  is rules").

When introducing an LLM call:
  - Specify the model version explicitly (no defaults) per ADR-013
  - Log the run to agent_runs for observability
  - Define the failure mode (what happens if the call fails or returns bad output)
  - Cost-estimate at the volumes the system will actually run at

When introducing deterministic logic that might later need LLM judgment:
  - Build the rule-based version first
  - Log inputs and outcomes so the rule's failure cases can be identified
  - If failure cases accumulate, revisit with an LLM layer that handles only
    those cases (not the whole task)

Reasoning:

Every LLM call has three costs: the API cost (non-trivial at pessimistic volume
across 10+ clients), the latency (seconds vs milliseconds for rules), and the
non-deterministic failure surface (retries, hallucinations, prompt drift).
These costs are justified when the task genuinely requires judgment or synthesis.
They are waste when the task is mechanical.

Deterministic code is faster, cheaper, predictable, testable, and auditable.
Every time a rule can replace an LLM call with no quality loss, it should.

At the same time, under-using LLMs where they add value is equally wrong.
A reply classification done by keyword matching would miss half the nuance of
real replies. A messaging document composed by template filling would be the
AI slop the product exists to avoid. LLMs are the product's strategic edge
where they genuinely apply.

The discipline is to distinguish correctly, session by session, and to default
to the cheaper option when the boundary is unclear.

Rejected alternatives:

- LLM-first default: rejected because it increases cost, latency, and failure
  surface without proportional quality gain on most tasks.
- Rules-only approach: rejected because it cannot produce the document generation
  and personalisation quality the product requires.
- Per-agent decision with no principle: rejected because it produces drift over
  time as different sessions make different calls.

Consequences:

Every Claude Code session that introduces a new component must state explicitly
whether the component is deterministic or LLM-driven, and justify the choice
against this principle.

Reviews (manual or assisted) should flag any LLM call that could plausibly be
a deterministic rule, and any rule that is producing quality issues an LLM
could solve.

When in doubt, build the deterministic version first. It is almost always
cheaper and faster to add an LLM layer later than to simplify an LLM-dependent
system.

Follow-ups (tracked in /docs/BACKLOG.md):
- Review Phase 1 implementation against this principle after client zero goes live
- Identify any agents currently using LLMs that could be downgraded to rules
- Identify any rules that are producing edge-case failures that justify LLM layers

---

## ADR-019 — Phase 2 reply handling tier model
Date: May 2026 | Status: Accepted (supersedes part of ADR-007's Phase 3 deferral)

Context:
ADR-007 deferred sophisticated reply automation to Phase 3, delivering Phase 1 as:
  - Auto-action on opt_out (suppress), out_of_office (log), positive_direct_booking ≥0.90 (send Calendly reply)
  - log_only for all other intents

With Phase 1 shipped and client zero running, the most immediate operational pain is the
log_only pile — replies that need human handling but currently get no starting point. A
founding client receiving 20–30 replies per week would spend significant time composing
replies from scratch, many of which repeat the same questions. A draft starting point and
a compounding FAQ loop address this at exactly the right time.

Decision:
A fitness-driven tier model for non-auto-actioned replies:

  Tier 2 — AI drafts for operator approval:
    positive_passive
    objection_mild
    information_request_* WHEN a similar approved FAQ exists for the org
    positive_direct_booking with confidence in [0.70, 0.90)

  Tier 3 — starting-point only (always requires operator rewrite):
    information_request_commercial (always — pricing/contract sensitivity regardless of confidence)
    information_request_generic with no FAQ match
    unclear
    any other non-auto-actioned intent not fitting Tier 2

Routing is fitness-driven, not confidence-driven. The key distinction: high-confidence
commercial questions still route to Tier 3 because the sensitivity of the content
(pricing, contracts, integrations) requires human judgment regardless of classification
certainty. Tier assignment is based on the nature of what needs to be communicated, not
how confident the classifier is.

Compounding loop: when an operator sends a Tier 3 reply (i.e. modifies the draft and
sends it), the system extracts the question + the operator's sent answer as an FAQ
candidate. After operator curation into the canonical FAQ list, future similar questions
match the FAQ → route to Tier 2 instead of Tier 3. The loop compounds: more sent
replies → richer FAQ base → more questions shift to Tier 2 → less operator work per
reply over time.

Reasoning:
Positive replies were the most time-sensitive (Phase 1, ADR-007). The next pain after
Phase 1 ships is the log_only pile — the replies that exist but receive no automated
handling. Drafting saves minutes per reply multiplied across every non-trivial reply.

The tier split protects against AI sending pricing or commercial commitments without
human eyes, regardless of classifier confidence. This follows the same suggestion-queue
principle as ADR-002: human in the loop as the quality gate during the period when agent
judgment is unproven on high-stakes content.

FAQ extraction from sent Tier 3 replies (not Tier 2) is the compounding mechanism.
Using the operator's actual sent answer is higher-quality seed material than an
AI-generated suggested answer — it IS what the operator said to a real prospect,
which makes it immediately reliable as a future draft source.

The 15h/48h/72h escalation chain referenced in the BACKLOG (from ADR-007 Phase 1
consequence note) is superseded by this tier model. Escalation is immediate to the
operator triage queue — there is no time-tiered escalation. An unreviewed Tier 3 draft
remains visible in the queue until actioned; Sentry alert rules (already configured
for send_failed paths) cover anomalies.

Rejected alternatives:
  - Confidence-based routing alone: rejected because high-confidence commercial questions
    still need human judgment regardless of classification certainty. Fitness-based routing
    prevents the failure mode of an AI-generated pricing reply.
  - Auto-send on high-confidence Tier 2: rejected at this stage. ADR-002 precedent is
    the right default for client zero. Path to auto-approve is additive — one threshold
    field, one condition — same architecture. No rebuild required when the time comes.
  - FAQ extraction on every information-request reply (not just sent Tier 3): rejected
    because the system would need to generate a suggested answer from scratch, which is
    lower quality than the operator's actual sent text. Using the operator's sent body
    guarantees the extracted answer is real, not speculative.
  - Vector similarity for FAQ matching: rejected at this stage in favour of keyword
    normalisation. At founding-client volume (<50 FAQs per client), keyword matching is
    sufficient and far cheaper. Cheap to swap when matcher quality becomes a bottleneck
    — the matching logic is deterministic code in one function (ADR-018).
  - 15h/48h/72h escalation chain: superseded by this tier model. Tier 3 escalation is
    immediate to the operator queue, not time-tiered.

Consequences:
  Three new tables: faqs, faq_extractions, reply_drafts (migration: 20260501_reply_handling_phase2.sql).
  reply_handling_actions.faq_entry_id FK constraint added in the same migration, now pointing
    to faqs(id) (column was created in 20260429_reply_handling.sql with a deferred FK).
  Reply processor will be extended in Phase 2 Group 2 to fan out to the reply-draft-agent
    and faq-extraction-agent for non-auto-action intents. process-reply.ts is not modified
    in this group.
  New agent: reply-draft-agent.ts with Tier 2 and Tier 3 prompt branches (Phase 2 Group 2).
  New agent: faq-extraction-agent.ts triggered after Tier 3 draft is sent (Phase 2 Group 2).
  Deterministic FAQ matcher (keyword + normalisation), no LLM per ADR-018.
  Operator dashboard gains reply triage view and FAQ curation view (Phase 2 Group 3).
  The Phase 3 BACKLOG entry "AI reply handling for information requests (with human override)"
    closes — that work is this ADR, now Phase 2.
  The Phase 2 BACKLOG entry "Information request escalation (15h/48h/72h chain)" is
    superseded — replaced by the immediate-queue tier model.

