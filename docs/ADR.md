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
No LinkedIn scraping. The research agent queries all four sources in parallel via a
single concurrent pass:
1. Apollo enrichment API — full profile and firmographic data
2. Targeted web search — Google-indexed public content, posts, news mentions
3. Direct company website fetch — services page, about page, recent news
4. Role-based pain proxy — ICP document pain language, used when other sources
   return no usable trigger

All four sources are queried simultaneously. Each source degrades independently:
if Apollo returns 403, the agent continues with web search and website results.
If Apollo and web search both return nothing usable, the pain proxy guarantees a
trigger is always available for composition.

The synthesis step (Haiku LLM call) receives the combined output from whichever
sources succeeded and selects the best personalisation trigger. If no dateable
signal was found across any source, the composition layer uses the role-based
pain proxy from the Messaging Playbook.

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
All four sources run in parallel — the latency budget is the slowest source, not
their sum.
The pain proxy is the guaranteed floor: no prospect can reach composition without
a trigger available.
Each source failure is logged independently. Apollo returning 403 is a documented
failure mode, not an unhandled error. The remaining sources still run and the
synthesis step proceeds with whatever data is available.

### Note (May 2026) — Architectural divergence from original sequential design

The original ADR (April 2026) described a sequential fallthrough chain: Apollo →
web search → website fetch → pain proxy, where the agent stops at the first source
that yields a usable trigger.

The v2 research agent (`prospect-research-agent-v2.ts`) runs all four sources in
parallel via `Promise.all()`. This divergence was not a planned ADR update — it
emerged during implementation and is architecturally superior:

- **Latency:** parallel execution time equals the slowest source, not the sum of
  all sources. For a 15s Apollo timeout alongside an 8s web search, sequential
  would take 23s; parallel takes ~15s.
- **Data richness:** when multiple sources succeed, the synthesis step has more
  signal to work with and can produce a higher-quality personalisation trigger.
- **Resilience:** if one source is temporarily down or rate-limited, the others
  still run. No single source failure can block trigger synthesis.

The original sequential chain is preserved in the Decision section above for
historical context. The "primary / secondary / tertiary" labels remain as priority
guidance for the synthesis step (Apollo data is weighted more heavily when
available), but execution is always parallel.

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
Buyer criterion derivation (buyer-criterion-agent): claude-opus-4-6
  Added 2026-09-02 with ADR-046. Opus because it reads every approved document plus intake
  and answers a judgement question about who owns a problem, which is the same class of
  synthesis the document agents do. It runs ONCE PER ICP APPROVAL, not per prospect, so the
  per-run cost is irrelevant next to getting the answer right: a wrong criterion silently
  discards real buyers before anything is paid for.
ICP geography derivation (icp-geography-agent): claude-opus-4-6
  Added 2026-09-04. Opus for the same reason as the buyer criterion: the input is prose
  and the task is a reading, not a lookup. It runs ONCE PER ICP APPROVAL, alongside the
  criterion, so the promotion path now makes TWO model calls where it previously made one.

  THE ONE CLIENT IN THIS CODEBASE WITH AN EXPLICIT TIMEOUT AND RETRY LIMIT, and that is a
  deliberate exception rather than an oversight elsewhere. The Anthropic SDK defaults are a
  10 minute timeout and 2 retries, so a bare client can occupy 30 minutes. Every route on
  the promotion path has a 300 second budget, and nothing retries a failed spec
  derivation: a promotion that runs out of time leaves icp_filter_spec NULL until a human
  re-approves the document. This client is bounded so that its worst case fits inside the
  route. Every other Anthropic client in the codebase still inherits the SDK defaults, and
  that is a known gap rather than a decision.
Messaging generation agent: claude-sonnet-4-6 (see update note below)
Reply drafting (reply-draft-agent): claude-sonnet-4-6
Prospect research (synthesis, writer, floor judge, judge): claude-sonnet-4-6

  CORRECTED 2026-08-24. This entry previously read "Web search utility (lightweight
  synthesis in prospect research agent): claude-haiku-4-5-20251001". That was wrong from
  the moment the v2 research agent shipped. The code has always used claude-sonnet-4-6:
  synthesize.ts:22 (SYNTHESIS_MODEL) and write-opening.ts:23-24 (WRITER_MODEL, JUDGE_MODEL).

  Sonnet is roughly 3x Haiku, so every cost model built on the old figure understated
  research by about that factor.

  RESEARCH MAKES FOUR SONNET CALLS PER PROSPECT, not one:
    1. synthesis      synthesize.ts, ranks the observation candidates
    2. writer         write-opening.ts:1233, writes the opener
    3. floor judge    write-opening.ts:1261, the readability/quality floor
    4. judge          write-opening.ts:1278, the send-or-hold verdict
  Plus a RETRY PATH that re-runs the writer on weak material or a collision, so a retried
  prospect costs five or six calls.

  These four share large, highly cacheable prefixes: the synthesis prompt, the writer
  system prompt, the ICP and positioning context, the judge rubrics. This stage is where
  prompt caching pays. Composition is not: it makes ZERO model calls, because its only one
  was the bridge sentence and BRIDGE_ENABLED has been false since 5047e24 (2026-08-19).
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
SUPERSEDED 2026-08-24: see the correction above. The research synthesis step is not
lightweight and does not use Haiku.

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

Update — May 2026 (FAQ extraction agent added):
FAQ extraction (faq-extraction-agent): claude-haiku-4-5-20251001
  Same tier as reply classifier. Structured extraction from text, not prose generation.
  Cost-sensitive — runs synchronously after every Tier 3 send once Group 4 wires it in.
  LLM justified over deterministic rules: extracting Q&A pairs from unstructured prose
  requires judgment about what constitutes a question and whether the operator answered it.
  The deterministic filler-detection gate (src/lib/faq/filler-detection.ts) skips obvious
  non-extractable cases before any Haiku call is made.

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

The prospect research agent runs all sources on every prospect regardless of
sourcing origin or prospect quality. Within the composition layer
(`compose-sequence.ts`), the sequence is personalised based on two fields set
by the research agent on the `prospects` table:

  `has_dateable_signal` (boolean) — whether a time-anchored signal was found
  `signal_relevance`   (text)     — quality grade of the best signal found
                                    (`use_as_hook`, `mention_only`, `too_weak`,
                                    `no_signal`)

When `has_dateable_signal = true` AND `signal_relevance = 'use_as_hook'`, the
Haiku bridge call generates a personalised bridge sentence for Email 1. In all
other cases the composition falls back to the role-based pain proxy from the
Messaging Playbook.

This is a single composition path with an optional bridge sentence. There are no
separate composition templates per prospect tier, no separate sending domain
pools, and no per-tier sending routing.

Consequences:

`has_dateable_signal` and `signal_relevance` fields on the `prospects` table
govern composition branching. These are set by the v2 prospect research agent.

The composition layer uses these fields to make one decision: generate a bridge
sentence (personalised hook) or use the role-based pain proxy from the Messaging
Playbook. All other composition steps are identical regardless of this branch.

No `sourced_tier` field exists on `prospects`. The Sourcing Orchestrator (which
would be the natural write source for `sourced_tier`) has not been designed or
built.

No per-tier sending domain pools exist. Domain routing is handled at the Instantly
campaign level by the operator — MargenticOS does not programmatically route by
prospect tier.

No per-tier performance tracking is implemented in the signals pipeline or
warnings engine.

### Note (May 2026) — Original specification not implemented

The April 2026 specification for this ADR defined a three-tier enrichment and
sending routing model: full research for Tier 1, Apollo-only for Tier 2, and
verification-only for Tier 3. It also specified a `sourced_tier` column on
`prospects`, separate sending domain pools, and per-tier performance tracking in
the signals pipeline and warnings engine.

None of these behaviours were implemented. The actual build converged on the
simpler signal-quality-based branching described above. Two factors make the
original specification premature:

1. The Sourcing Orchestrator (which assigns `sourced_tier` at list-build time)
   has never been formally scoped or built. Without a write source for
   `sourced_tier`, the downstream routing cannot exist.

2. Whether tiered routing has commercial value is an empirical question. c0
   evidence (single composition path across all prospects) is needed before
   adding the complexity of separate templates, research budgets, and domain
   pools per tier.

Reconciling the implementation with the full original spec is tracked in
BACKLOG.md under "[pre-c1] Reconcile ADR-017 with implementation reality".

### Original April 2026 specification (preserved for historical context)

**Original Decision (April 2026):**

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

**Original Reasoning (April 2026):**

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

**Original Rejected alternatives (April 2026):**

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

**Original Consequences (April 2026):**

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

**Original Follow-ups (April 2026):**
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

ADR-019 Appendix — Intent-to-tier routing table (as implemented, Group 4, May 2026)
Implemented in: src/lib/reply-handling/route-intent.ts

  intent                          confidence        FAQ top score    → tier
  ────────────────────────────────────────────────────────────────────────────
  opt_out                         any               any              → tier_1_handled
  out_of_office                   any               any              → tier_1_handled
  positive_direct_booking         ≥ 0.90            any              → tier_1_handled
  positive_direct_booking         [0.70, 0.90)      any              → tier_2
  positive_passive                any               any              → tier_2
  objection_mild                  any               any              → tier_2
  information_request_generic     any               ≥ 0.65           → tier_2
  information_request_commercial  any               any              → tier_3
  information_request_generic     any               < 0.65 or null   → tier_3
  positive_direct_booking         < 0.70            any              → tier_3
  unclear                         any               any              → tier_3
  (any unknown intent)            any               any              → log_only

  Tier 1 intents that reach orchestrateDraft() throw — they should have been handled upstream.
  Routing constants (must stay in sync with process-reply.ts and reply-draft-agent.ts):
    POSITIVE_BOOKING_TIER1_THRESHOLD = 0.90
    POSITIVE_BOOKING_TIER2_MIN       = 0.70
    FAQ_TIER2_THRESHOLD              = 0.65

---

## ADR-020 — Reply sign-off: founder first name only (not company team)

Date: 2026-05-03
Status: Accepted
Implemented in: Group 5 (Phase 2 send-on-approval wiring)

### Decision

All sent replies — Phase 1 auto-Calendly responses and Phase 2 operator-approved Tier 2/3
drafts — sign off with the founder's first name only:

  \n\n${founderFirstName}

The previous pattern ("[Client Company Name] Team") is retired.

### Context

The company team sign-off was introduced in Phase 1 as a legally-clean, common-practice
attribution that avoids disclosing AI involvement. It was the right call at Phase 1
time-of-writing.

Phase 2 operator review changes the calculus: a human operator reviews and approves every
Tier 2/3 draft before it sends. That review constitutes a genuine human-in-the-loop step,
so signing as the founder — the person who did review and approve — is accurate, not
deceptive.

For Phase 1 auto-Calendly (positive_direct_booking ≥ 0.90, high-confidence direct
booking signal), the auto-send is tightly constrained and the body is purpose-built to
be brief, factual, and include only the Calendly link. Signing as the founder is
consistent with the founder personally responding to a booking request.

The company team attribution remains in use for holding messages (information request
escalation) and opt-out confirmations, which are genuinely system-generated and not
operator-reviewed. These are separate code paths and are not affected by this ADR.

### Enforcement

founder_first_name is a hard requirement at send time:
- Phase 1 (process-reply.ts): missing → log error, return 'error', signal gets no reply.
- Phase 2 (send-approved-draft.ts): missing → return send_failed
  reason='founder_first_name_required_but_missing'. Caller (approve endpoint) surfaces
  error to operator UI.

Populting organisations.founder_first_name is a mandatory pre-launch step for every
new client. It must be set before any campaigns go live.

### Mechanics

insert-signoff.ts (deterministic, no LLM):
  - Receives the assembled body text and founderFirstName.
  - If the last 100 chars already contain a recognised closer (Cheers, Best, Thanks,
    Regards, Kind regards, All the best) → no sign-off appended.
  - If the last non-empty line already equals founderFirstName → no sign-off appended.
  - Otherwise appends \n\n${founderFirstName}.
  - Throws if founderFirstName is empty or whitespace — fail loud, never send unsigned.

substitute-calendly.ts (deterministic, no LLM):
  - Replaces {calendly_link} placeholder with org.calendly_url.
  - No placeholder present → not a failure (passes through unchanged).
  - Placeholder present but calendly_url null → missing=true → caller returns send_failed.
  - Applied before sign-off insertion (Calendly substitution first, sign-off second).

### Consequences

- All clients require organisations.founder_first_name populated before first send.
- Operator onboarding checklist must include this field as a mandatory step.
- QA smoke test: verify sign-off appears correctly in a test send before going live
  with any new client.

---

## ADR-021 — Operator endpoints are cross-org; client endpoints scope by organisation_id

Date: 2026-05-04
Status: Accepted
Implemented in: Group 6 (Operator Triage UI)

### Decision

Operator-facing API endpoints do NOT filter by the operator's own organisation_id.
They read and act across all organisations.

Client-facing API endpoints continue to filter by the authenticated user's
organisation_id on every query.

### Context

When the reply-drafts list, detail, approve, and reject endpoints were first
written, they selected `organisation_id` from the users table and used it to
scope every query. This was a bug: the operator's row in the users table stores
the org they belong to as a user, not the set of client orgs they manage.
Filtering by `operatorOrgId` would return only drafts from the operator's own
organisation — it would never surface drafts belonging to client organisations.

The Phase 1 `suggestions/[id]/approve` and `suggestions/[id]/reject` endpoints
established the correct pattern: they select only `role` from the users table
and fetch resources by ID alone, with no organisation_id filter. The operator's
authority is granted by role, not by org membership.

### Enforcement

Operator endpoint auth pattern:
  1. User is authenticated
  2. User role is 'operator'
  (No organisation_id filter — the operator acts on behalf of all organisations.)

Client endpoint auth pattern:
  1. User is authenticated
  2. User role is appropriate for the route
  3. Resource belongs to user's organisation_id (explicit filter at query layer)

### Consequences

- All current and future operator endpoints must follow this pattern.
- The users table select in operator endpoints must be `select('role')` only.
  Reading `organisation_id` and using it to scope queries is the anti-pattern
  this ADR prohibits.
- Supabase service-role client bypasses RLS; the role check at the application
  layer is the only gate for operator endpoints.
- Cross-org visibility is intentional. An operator must see all client drafts,
  not just drafts from their own user record's organisation.

---

## ADR-022 — Operator view-as-client mechanism
Date: May 2026 | Status: Resolved — June 2026

**Resolution:** Operator-gated org resolver (`resolveViewingOrg`) scopes page data to the selected client; `appendClientParam` carries `?client=` through every nav link so the param persists across navigation; the amber banner and VIEWING label are extracted into client components that read `useSearchParams()` directly. The four prior server-side propagation attempts (custom header, cookies, cookie sync, header mutation) all failed because server layouts cannot read searchParams — the working path was a client component reading the URL, not server-side propagation at all.

### Context

The operator needs to navigate client-facing dashboard routes (/dashboard,
/dashboard/pipeline, etc.) scoped to a specific client's data — for QA, sales demos,
and client support. Page-level scoping via searchParams.client works correctly.
Layout-level scoping (sidebar VIEWING name, amber banner with client name) could not
be made to work.

### Decision

Deferred to post-client-zero. See BACKLOG.md for full investigation history.

### Implementation history

Multiple approaches attempted and verified via production diagnostic logs:

  1. Custom request header injection (x-view-as-client in requestHeaders) — arrived as
     null in layout's headers() call. x-pathname set via identical mechanism worked.
     Root cause of the asymmetry not identified.

  2. Cookie via response.cookies.set() — not visible to cookies() in layout. Response
     cookies go to browser; cookies() reads incoming request cookies.

  3. Cookie via request.cookies.set() + response.cookies.set() — same outcome. Intended
     to sync the in-memory cookie store, but cookies() in layout still returned undefined.

  4. Direct Cookie header mutation in requestHeaders before NextResponse.next() — same
     outcome. Diagnostic log confirmed clientParam: undefined in layout.

All four approaches were deployed to production and verified via Vercel serverless logs.
The diagnostic logs showed the layout consistently receiving null/undefined while
page-level resolution via searchParams worked correctly on every attempt.

### Consequences

- resolve-viewing-org.ts deleted in revert; will need recreating when deferred work resumes.
- Workaround: log in as test client user in incognito for QA. Use screenshots for demos.
- Page-level scoping is unaffected — pages correctly scope data via searchParams.client.
- ADR-003 RLS isolation is unaffected — all three client RLS gap fixes remain in place
  (d9268d3: strategy_documents, document_suggestions, prospects).


## ADR-023: Onboarding automation — operator-led with intake-completion handoff

**Status:** Accepted (May 2026)
**Supersedes:** Manual SQL onboarding process (no prior ADR — documented in BACKLOG.md only)
**Related:** ADR-001 (industry-agnostic), ADR-003 (multi-tenant isolation), ADR-005 (LinkedIn-scraping prohibition; defines research fallback chain), ADR-019 (FAQ compounding), ADR-020 (founder_first_name), ADR-021 (operator/client endpoint scope), ADR-022 (View-as-Client deferred)

### Context

Today, onboarding a new client requires ~6–9 hours of operator work spread across 10 days, executed almost entirely as manual SQL against Supabase. The May 2026 discovery pass (`/docs/discovery/2026-05-12-onboarding-automation.md`) confirmed that no completion-triggered automation exists: intake completion logs a warning and stops; org creation, user invite, agent triggering, and campaign registration are all manual SQL or local CLI scripts.

This is acceptable for client zero (the operator IS the client) but breaks immediately at client one. The build is sequenced pre-Costa Rica so the operator runs themselves through the automated flow as client zero — the inception play.

### Decision

Build operator-led onboarding automation in two prompts, sequenced pre-flight and post-flight. The build is operator-led, not self-serve: the operator initiates every step from an operator UI. Clients never see onboarding controls — they receive a magic link and complete intake.

**In scope:**

1. Operator UI: Create-organisation form (writes `organisations` row, including `founder_first_name`, `monthly_meetings_target`, currency, contract dates; triggers user invite via `supabase.auth.admin.inviteUserByEmail()` with `organisation_id` and intended `role` in user metadata)
2. Auto-trigger four strategy agents (ICP, TOV, Positioning, Messaging) on intake 80% threshold via a single completion handoff route
3. Operator notifications via Resend (four templates: intake-complete, all-docs-generated, multi-user-signup-attempt, client welcome with magic link)
4. Operator UI: Register Instantly campaign (operator pastes Instantly campaign UUID; system validates via `GET /api/v2/campaigns/{id}` against Instantly's live API; on success, inserts `campaigns` row linked to org)
5. Operator UI: Setup status panel (writes to existing `organisations.setup_status` jsonb column)
6. Instantly lead upload capability (registry slot `outreach.upload_leads`, handler for composed-sequence → Instantly leads)
7. Apollo graceful degradation in the research agent (current 403/401 behaviour formalised as a documented failure path; falls through the ADR-005 chain: Apollo → targeted web search → direct website fetch → role-based pain proxy; implementation discovery required to confirm current routing)
8. Instantly DFY mailbox ordering (registry slot `outreach.order_mailboxes`, two-click operator flow: `simulate: true` quote → operator confirms → `simulate: false` real order; supports `.com` and `.org` TLDs only per Instantly API constraints)

**Out of scope, parked in BACKLOG:**

- Multi-user client UI (per existing BACKLOG entry — defers until non-operator account exists)
- Operator audit logging (acceptable for c0 with one operator)
- FAQ seed agent (per existing BACKLOG entry — pre-c1, post-c0)
- Instantly webhook integration (requires Hypergrowth $97/mo+; polling architecture per existing ADRs is sufficient)

### Key design decisions

**Multi-user signup behaviour.** A new DB trigger on `auth.users` (`AFTER INSERT`) checks whether the incoming user's intended `organisation_id` (from `raw_user_meta_data`) already has a `users` row with `role='client'`. If yes: the trigger inserts a row into a new `users_pending_review` table (email, attempted_org_id, attempted_at) and raises a Postgres exception to abort the auth user creation. The operator receives a Resend notification. This is the documented Supabase pattern for blocking signups via trigger failure. Explicit in the migration — not left to runtime behaviour.

**Campaign registration UX.** Operator-first with validation: operator creates campaign in Instantly's dashboard (judgment-required step — schedule, mailboxes, send limits), then pastes the UUID into the MargenticOS operator UI. The system validates by calling Instantly's `GET /api/v2/campaigns/{id}` at paste time, displays the campaign name for operator confirmation, then writes the row on save. A 404 from Instantly blocks the save with a clear error. This kills the silent-failure mode where a typo in `external_id` causes signal polling to drop events.

**DFY mailbox ordering — simulate-then-confirm.** Mailbox orders are real money (~$73 first month per 4-mailbox order). The operator UI is a two-step flow: button 1 fires `POST /api/v2/dfy-email-account-orders` with `simulate: true` and displays the quote + the `order_is_valid` boolean from the response; button 2 fires the real order with `simulate: false`. No single-click order placement. Pre-warmed-up domain availability is checked first via `/dfy-email-account-orders/domains/pre-warmed-up-list`; if pre-warmed domains are unavailable, fresh DFY order is offered as fallback. TLD support is `.com` and `.org` only — any operator-entered domain outside these is blocked at the UI with a clear error.

**Apollo graceful degradation.** The research agent must function with Apollo inactive (401 no-key, 403 free-tier-blocked, or 5xx network errors all treated as documented failure modes, not unhandled errors). Fall-through proceeds per ADR-005: targeted web search (secondary), then direct company website fetch (tertiary), then role-based pain proxy if no trigger found. The exact current routing — whether Apollo failure already falls through correctly or propagates up — requires implementation discovery before the graceful-fail code is written (sub-pass in Prompt 3).

**Intake completion handoff.** The 80% threshold detection moves from a warning log in `icp-generation-agent.ts` to a single `/api/intake/complete` route that fires all four agents in parallel (they have no inter-dependencies). The operator receives one Resend email when all four complete (or when any fail). Individual agent failures do not block the others.

**Resend transactional fix prerequisite.** The first production caller of `sendTransactionalEmail()` triggers a pre-existing bug: `src/lib/email/send.ts:43` calls `Sentry.captureException()` with no `Sentry.flush()` before serverless return (BACKLOG lessons learned, May 2026). Prompt 2 must add `try { await Sentry.flush(2000) } catch {}` before any production path calls this function for the first time. This is non-optional and must land in the same commit as the first production caller.

**Industry-agnostic per ADR-001.** No consulting-specific or niche-specific language in any form copy, error message, prompt addition, or operator UI string. The create-org form captures `founder_first_name`, but no field named or framed around consulting.

### Build sequencing

Two Claude Code prompts, sequenced pre-flight and post-flight:

- **Prompt 2 (pre-flight):** Operator UI for create-org, intake-completion handoff route + auto-trigger four agents, four Resend templates, `users_pending_review` migration + trigger, Sentry flush fix. ~2–2.5 days.
- **Prompt 3 (post-flight, Costa Rica):** Register Instantly campaign UI, setup_status panel, Instantly lead upload capability, Instantly DFY mailbox ordering, Apollo graceful degradation. ~3–3.5 days.

Three operational checklists (manual onboarding fallback, daily/weekly monitoring, mid-engagement strategy refresh) are written between Prompt 2 and Prompt 3 — written in chat, not Claude Code — and must exist before any subscription is activated.

Total realistic estimate: 5–6 days build + 0.5 day buffer = 6 days. Subscriptions (Instantly Growth ~$30-47/mo, Apollo Basic $49/mo annual, DFY mailbox orders ~$73 first month) are deliberately deferred to Costa Rica activation; nothing in the build requires an active paid plan, but all integrations should be smoke-tested against real APIs once subscriptions are live.

### Consequences

**Positive:**
- Per-client operator time drops from 6–9 hours to ~3 hours of judgment work
- Silent failure #1 (missing `campaigns` row) eliminated at source
- `founder_first_name` enforcement moves upstream from send-time to org-creation-time
- Operator-as-client-zero validates the automation against real-world conditions before any paying client touches it
- Manual onboarding fallback checklist (written between prompts) provides a degradation path if automation breaks during c0
- Sentry flush bug fixed before any production email is sent (avoids a c0-discovered fire)

**Negative:**
- Two new Instantly capabilities (DFY mailbox, lead upload) are net-new integration surface — risk of API quirks discovered only during c0 dogfood
- Operator UI for create-org introduces a form that becomes part of every future client onboard — design carefully, ADR-001 compliance enforced
- DFY mailbox API spend is real money; simulate-then-confirm is a process safeguard, not a technical one
- DFY .com/.org TLD constraint will need an alternative path if a future client requires a different TLD — accepted limitation for c0 and c1
- Apollo graceful degradation expands the surface area of "what happens when X is off" — requires testing both with and without Apollo active during c0

**Risk: scope creep during build.** View-as-Client precedent (ADR-022) — a build of similar size expanded across 4 approaches and was ultimately reverted. Mitigation: each prompt has a defined cut line, edge cases default to `post-c0-polish` tag in BACKLOG rather than inline fixes, and the build pauses at Prompt 2 completion for checklist writing before Prompt 3 begins.


## ADR-024 — Prompt 3 build split: 3A (pre-subscriptions) and 3B (post-subscriptions)

**Status:** Accepted (May 2026)
**Related:** ADR-023 (onboarding automation), ADR-001 (tool-agnostic registry), ADR-017 (tiered enrichment — see implementation reality note)

### Context

ADR-023 scoped Prompt 3 as a single build covering: campaign registration UI, setup_status panel, Instantly lead upload, Instantly DFY mailbox ordering, and Apollo graceful degradation. Pre-scoping discovery (`/docs/discovery/2026-05-13-prompt-3-scoping.md`), an ADR spot-check (`/docs/discovery/2026-05-13-adr-spot-check.md`), and a live RLS verification pass (`/docs/discovery/2026-05-13-rls-verification.md`) established that these five items split along a natural dependency boundary:

**Group A — No paid subscription required:**
- Operator UI: Register Instantly campaign (validation via live API — requires API key only)
- Operator UI: Setup status panel
- Registry slots for lead upload and mailbox ordering capabilities
- Schema additions to `prospects` table (`instantly_lead_id`, `upload_status`, campaign mapping)
- Security fixes identified during the pre-build audit (P0 and P1 items from RLS verification)

**Group B — Requires active paid plan:**
- Instantly lead upload handler (POST `/api/v2/leads/add` — requires Instantly Growth ~$47/mo)
- Instantly DFY mailbox ordering handler (POST `/api/v2/dfy-email-account-orders` — Growth plan + real money)
- Apollo graceful degradation formalisation (requires Apollo API key for end-to-end testing)

### Decision

Split Prompt 3 into two sequenced prompts:

**Prompt 3A (pre-subscriptions):**
1. Campaign registration UI — operator pastes Instantly campaign UUID, system validates via `GET /api/v2/campaigns/{id}`, writes `campaigns` row on confirmation
2. Setup status panel — operator UI reads/writes `organisations.setup_status` jsonb column
3. Registry slots — `can_upload_leads` and `can_order_mailboxes` capability rows using the existing `can_<verb>_<noun>` Boolean flag convention. ADR-023's dotted-namespace specification was an error: per discovery, the registry is config-only (no runtime dispatcher), so introducing a parallel naming convention would only add confusion. The registry can evolve into a runtime layer later if a real dispatcher is built.
4. `validateInstantlyCampaign()` handler in `src/lib/integrations/handlers/instantly/`
5. `prospects` schema additions, using `outbound_` prefix instead of `instantly_` to keep the schema migration-friendly if a different cold-email platform replaces Instantly (ADR-001 tool-agnostic compliance): `outbound_lead_id` (text, nullable) — platform-specific lead ID after upload; `outbound_upload_status` (text with CHECK constraint, default `'pending'`) — values: `pending`, `uploading`, `uploaded`, `failed`; `outbound_upload_attempted_at` (timestamptz, nullable); `outbound_upload_error` (text, nullable); `campaign_id` (uuid, nullable, FK to `campaigns`) — set at sourcing time per OQ3 resolution
6. Shared `getInstantlyApiKey()` helper extracted from inline cron code and reused across all new Instantly handlers
7. Fix `signals_signal_type_check` constraint to include `reply_received` and any new signal types — a pre-existing blocker in the signal pipeline
8. P0 security fixes: REVOKE EXECUTE on `approve_document_suggestion` and `append_faq_variant` — SQL ready in `/docs/discovery/2026-05-13-rls-verification.md`
9. Security hygiene fixes (P1 items from RLS verification): explicit policies on `integration_credentials`, REVOKE EXECUTE on three exposed trigger functions (`handle_new_auth_user`, `handle_new_user`, `rls_auto_enable`)

### Key design decision: operator detail page at `/dashboard/operator/clients/[id]`

The setup_status panel and campaign registration form have no natural home in the current operator UI without creating a per-client detail page. Prompt 3A creates `/dashboard/operator/clients/[id]` as the per-client home. This adds ~1 day to Prompt 3A scope vs implementing both as inline modals on the main operator page. The trade-off is paid back many times by Prompt 3B+ work: lead upload UI, mailbox ordering UI, future operator actions all need a per-client home. Inline panels create UI debt that forces a refactor at Prompt 3B.

**Prompt 3B (post-subscriptions, Costa Rica activation window):**
1. Lead upload capability — `uploadLeads()` handler, operator UI trigger, upload tracking via `upload_status`
2. DFY mailbox ordering — `orderMailboxes()` handler with simulate:true → confirm → simulate:false two-step flow
   - DFY TLD allow-list implemented as a documented constant `INSTANTLY_DFY_ALLOWED_TLDS = ['.com', '.org']` at the top of the relevant file, with code comment linking to Instantly's docs. Single source of truth, easy to extend if Instantly adds TLDs. Dynamic derivation rejected: adds an API call per form load for a list that changes ~never.
3. Apollo graceful degradation formalisation — Doug going to Apollo Basic for c0 in Costa Rica narrows the original scope. The "free tier returns 403 for everything" state will not be the production reality. Prompt 3B's Apollo work is defensive coding for rate limits (429 with Retry-After handling), transient outages (5xx with backoff), and credential issues (401 alerting). Does NOT rebuild the parallel fallthrough chain — it works per ADR-005 update.
4. Smoke tests against live APIs (both Group A and Group B flows with active subscriptions)

### Prerequisites before Prompt 3A starts

1. Open Questions 3 and 4 from the scoping report resolved (campaign mapping model and `instantly_lead_id` placement) — answered by including the schema additions in Prompt 3A scope rather than leaving them unresolved.
2. BACKLOG entry [pre-c1] Reconcile ADR-017 with implementation reality — blocked on Sourcing Orchestrator existing, see BACKLOG.md for details.
3. Two P0 security fixes (REVOKE EXECUTE on `approve_document_suggestion` and `append_faq_variant`) bundled into Prompt 3A's first migration. SQL ready in `/docs/discovery/2026-05-13-rls-verification.md`.
4. Set six env vars in Vercel Preview environment (currently Production-only): `RESEND_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL`, `REPLY_TO_EMAIL`, `RESEND_OPERATOR_EMAIL`, `NEXT_INTERNAL_SECRET`, `SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET`. Without these, every Prompt 3A deploy-to-Preview branch will either silently fail email sends or link back to production URLs. ~10 minutes via Vercel CLI.
5. Confirm the Supabase Database Webhook for `users_pending_review` is active (configured manually in Prompt 2). 30 seconds in Supabase Dashboard → Integrations → Webhooks. Verify the webhook is enabled and pointing to the correct route.

### Reasoning

**Subscription timing.** The DFY mailbox endpoint and lead upload API both require Instantly Growth plan. Per ADR-023, subscriptions are deferred to Costa Rica activation. Building and reviewing Group A before subscription activation means schema and handlers are reviewed before real-money API surface is touched.

**Real-money risk.** DFY ordering involves real spend (~$73 first month per 4-mailbox order). Separating it into Prompt 3B means the simulate:true → confirm flow is reviewed in full before the Growth plan is activated. Accidental orders are not possible before Prompt 3B begins.

**Data model completeness.** The `prospects` table was missing `outbound_lead_id`, `outbound_upload_status`, and the campaign mapping model was undefined before the scoping pass. Prompt 3A resolves this: when Prompt 3B starts, the data model it writes into already exists with correct schema and RLS policies in place.

**Security sequencing.** The RLS verification pass found two P0 vulnerabilities (`approve_document_suggestion` and `append_faq_variant` callable by unauthenticated users). These must be fixed before any new client-touching surface is added. Bundling them into Prompt 3A's first migration is the correct sequencing — they fix existing gaps, not new ones.

### Consequences

Prompt 3A delivers: working campaign registration flow, setup visibility for the operator, correct schema for lead management, and security hygiene. No new paid API surface is introduced.

Prompt 3B delivers: the outreach pipeline activation — leads uploaded, mailboxes ordered, research agent formally resilient to Apollo being off.

The split adds a natural breakpoint for operational review between the two prompts — the same pattern as the Prompt 2 → checklist writing → Prompt 3 split in ADR-023.

Prompt 3B scope is deliberately narrow. The codebase state is well-mapped from two discovery passes completed before Prompt 3A; no additional re-discovery is needed before Prompt 3B begins.

---

### Watertight build strategy (May 2026 amendment)

This amendment records the four-pillar strategy for building and verifying Prompt 3B without active paid subscriptions. It extends ADR-024's core decision (the 3A/3B split) with the operational approach that makes 3B buildable, reviewable, and testable before Instantly Growth and Apollo Basic are activated in Costa Rica.

#### Pillar 1: Mock-first Instantly integration

Instantly hosts a public mock server at `https://developer.instantly.ai/_mock/api/v2/` that returns documented response shapes for every endpoint without requiring an API key.

All Prompt 3B Instantly handlers point at a configurable `INSTANTLY_API_BASE_URL` environment variable, extending the existing `INSTANTLY_API_BASE` constants pattern in `src/lib/integrations/handlers/instantly/constants.ts`.

- Default in development/test: mock URL (`https://developer.instantly.ai/_mock/api/v2/`)
- Default in production: production URL (`https://api.instantly.ai/`)
- A single env var flip switches from mock to production once subscription activates — no code changes required

**Honest limitation:** The mock returns 200 happy-path responses only. Error responses (401, 402, 404, 429) are NOT exercised by the mock. Error handling for Instantly is validated by the verification harness (see `/docs/prompts/subscription-activation-verification.md`) at subscription activation, not during build.

#### Pillar 2: Feature flags with mode awareness

Three flags govern integration behaviour during and after the build phase:

- `instantly_api_active` (boolean, default `false`) — controls whether real Instantly calls are permitted from the UI
- `apollo_api_active` (boolean, default `false`) — same for Apollo
- `instantly_api_mode` (text, `'mock' | 'production'`, default `'mock'`) — independent of the active flag; permits testing against the mock even when subscription is active

**UI behaviour:**
- When `instantly_api_active=false`: operator UIs render and call the mock; a clear mode indicator is displayed: "Testing against mock — Instantly subscription not active"
- When `instantly_api_active=true`: real calls, real data, real consequences; indicator removed
- DFY ordering with `instantly_api_active=true`: two-step confirm flow mandatory — `simulate:true` on first call, real order only on explicit operator confirm

**Flag placement:** Flags live in the `integrations_registry` table, extending the existing `can_<verb>_<noun>` capability pattern with a new `config` jsonb column or additional boolean columns — confirm in pre-build check based on current schema state. Default placement avoids introducing a new operator-settings table unless the registry schema cannot accommodate the three flags cleanly.

#### Pillar 3: Contract tests against the mock

For each Instantly endpoint Prompt 3B touches — `POST /api/v2/leads/add`, `POST /api/v2/dfy-email-account-orders`, `GET /api/v2/campaigns/{id}` — a contract test is written that:

1. Defines the expected request shape (URL, headers, body)
2. Defines the expected response shape (status, body schema)
3. Runs against the mock server during build
4. Runs unchanged against production at subscription activation (same tests, different `BASE_URL`)

Contract tests live in `src/lib/integrations/handlers/instantly/__tests__/` (or the equivalent test directory — confirm in pre-build check).

**Apollo (no mock server available):** Use stored response fixtures. Known-good Apollo response shapes are committed as JSON files under `src/lib/integrations/handlers/apollo/__fixtures__/`. Tests run against fixtures during build; run against the real API at subscription activation.

**Honest limitation:** Side-effect bugs (lead actually created, mailbox actually ordered) cannot be detected against the mock. The mock confirms the request/response wire protocol but cannot confirm real-world side effects. The verification harness covers this gap at activation.

#### Pillar 4: TypeScript types for three critical response shapes

The response shapes (not request shapes) for the three endpoints with real-money or real-state side effects are explicitly typed:

- `POST /api/v2/leads/add` response → `InstantlyLeadsAddResponse`
- `POST /api/v2/dfy-email-account-orders` response → `InstantlyDfyOrderResponse`
- `GET /api/v2/campaigns/{id}` response → `InstantlyCampaignResponse`

Types are derived from Instantly's OpenAPI spec at `developer.instantly.ai`. They are placed in `src/lib/integrations/handlers/instantly/types.ts`. The file includes a comment at the top referencing the source URL and the date the types were captured, so future drift between the types and the live API is traceable.

Other Instantly endpoints called by the system (campaign analytics, reply send, etc.) retain their existing untyped pattern — the cost of drift on those endpoints is lower.

Apollo response shapes are NOT typed at this stage. The graceful degradation pattern (ADR-005) handles Apollo responses loosely on purpose: a type mismatch on an enrichment response degrades to missing fields, not a runtime crash.

#### Honest limitations of this strategy

| What is covered | What is NOT covered |
|---|---|
| Request/response wire protocol (mock + contract tests) | Error responses 401/402/404/429 (mock is happy-path only) |
| Response shape matching (TypeScript types + contract tests) | Side-effect correctness (lead created, mailbox ordered) |
| Feature flag toggling | Rate limit behaviour (429 retry/backoff) |
| Apollo fixture shape matching | Apollo fixture staleness (if Apollo changes their schema) |

The verification harness (`/docs/prompts/subscription-activation-verification.md`) is the planned remediation for every item in the "NOT covered" column. It is designed to be run as a single self-contained session the day subscriptions activate.

---

## ADR-025 — is_default flag as the canonical "primary segment" marker
Date: June 2026 | Status: Accepted

Context:
Multiple places in the codebase needed to answer "which segment is this org's primary?"
The original fallbacks used inconsistent heuristics: agent routes used ORDER BY created_at
LIMIT 1, which is non-deterministic when two segments share the same timestamp. A slug
check (WHERE slug = 'default') works now but breaks the moment an org renames their
default segment. Both patterns were scattered across agent routes, composition, and the
research agent with no shared resolver.

Decision:
Add an `is_default boolean NOT NULL DEFAULT false` column to the segments table.
Enforce exactly one is_default=true per org at the database level using a partial unique
index: `CREATE UNIQUE INDEX segments_org_primary_idx ON segments(organisation_id) WHERE
is_default = true`. All "which segment is primary?" fallbacks route through a single
shared resolver: `resolveOrgPrimarySegment(supabase, orgId)` in
`src/lib/segments/resolve-primary-segment.ts`.

Reasoning:
The partial unique index makes an invariant (one primary per org) unbreakable by
application bugs or direct DB writes — the constraint fires at the Postgres level, not
just in application code. The shared resolver means there is one place to change if the
resolution logic ever needs to evolve. The flag survives segment renames and reordering,
unlike slug or ordering heuristics.

Rejected alternatives:
- slug = 'default' check: breaks if an org renames their segment; couples the code
  to a naming convention that must never change.
- ORDER BY created_at LIMIT 1: non-deterministic; picks whichever segment was created
  first, which may not be the segment the operator intends as primary.
- Application-layer enforcement only (no DB constraint): a race condition or a direct
  SQL write can silently create two "primary" segments; the partial unique index makes
  that impossible.

Consequences:
Every new org must have exactly one segment with is_default=true set at creation time.
The partial unique index will reject any attempt to set a second segment as primary
without first unsetting the current one. The intake flow and any future "create org"
path must be updated to set is_default=true on the first segment it creates.
resolveOrgPrimarySegment() is the only permitted way to answer "which segment is primary"
throughout the codebase — inline fallbacks should not be added.

---

## ADR-026 — Per-lead custom variables for sequence content delivery
Date: June 2026 | Status: Accepted

Context:
When wiring composeSequence into the upload path, two patterns were possible for
delivering per-prospect composed email content to the outbound provider:

Option A — Per-lead custom variables: Upload each lead with composed content as flat
key-value custom variables (m_subject_N, m_body_N). The campaign holds a generic shell
sequence where each step body is a template variable ({{m_subject_N}}, {{m_body_N}}).
The provider substitutes the per-lead values at send time.

Option B — Provider-side variant rotation: Create multiple campaign variants directly on
the outbound provider, one per Messaging doc variant (A, B, C, D). Assign each lead to
the appropriate campaign on upload. Content lives in the campaign template, not the lead.

Decision:
Option A — per-lead custom variables. Every lead receives its complete composed
sequence as custom variables (m_subject_1 through m_body_N) on the lead payload.
The campaign shell is a permanent generic template pushed once via syncSequenceShell.

Reasoning:
Per-lead variables give exact per-prospect control — every lead's subject and body are
deterministic and inspectable before send. This is essential for the ICP-trigger
personalisation and the bridge-sentence/CTA layer, which produce unique content per
prospect, not per variant batch. Provider-side variant rotation can only deliver a fixed
template per variant segment; it cannot accommodate per-prospect body composition.

Provider-side rotation also requires managing N campaign copies and keeping them in sync
when the Messaging doc is revised. Per-lead variables require only one campaign per
segment, and the shell only changes when the doc's step count or step delays change —
not when copy is revised (copy flows through the variables automatically on next upload).

Custom variables are flat key-value pairs spread onto the lead root at upload time.
Instantly does not support nested objects or arrays in custom variables. The variable
naming convention (m_subject_N / m_body_N) uses a generic m_ prefix consistent with
ADR-001 (tool names belong only inside handlers; the variable names are capability
identifiers, not tool names).

Rejected alternative:
Provider-side variant rotation (ADR-014 was written before the per-prospect composition
layer existed). ADR-014 Option E specified four Messaging variants rotated across
prospects at upload time — this model is superseded by per-lead variables, which achieve
the variant intent (different angles for different prospects) plus per-prospect
personalisation within each variant's template.

Consequences:
Each lead upload payload is larger (carries the full composed sequence as variables).
The upload handler must assert variable completeness (assertCompleteVariables) before
attaching variables to a lead; incomplete sets mark the lead failed rather than uploading
a partial sequence. The shell sync (syncSequenceShell) must be run before any upload and
must remain in sync with the Messaging doc's step count; a mismatch blocks upload.
Copy-only revisions to the Messaging doc do not require a shell re-sync — copy flows
through variables on next upload automatically. Structure changes (step count or delay
changes) require a re-sync, and are blocked if uploaded leads already exist for the
campaign (they have already received the old-structure sequence).


---

## ADR-027 — Two-client pattern for SSR routes
Date: June 2026 | Status: Accepted

Context:
`createServerClient` from `@supabase/ssr` was initialized with `SUPABASE_SERVICE_ROLE_KEY`
across 18 API routes. After `auth.getUser()` activates the session, the SSR client
replaces its Authorization header with `Bearer <user_access_token>` for all subsequent
PostgREST requests. Postgres receives `role = authenticated`, not `role = service_role`.
Any function or RLS policy requiring `service_role` silently fails with permission denied.
This caused the `approve_document_suggestion` RPC to deny every operator Approve click
for an extended period despite a correct GRANT on the DB side.

Decision:
Every API route that needs both session auth and privileged DB access uses two clients:

  1. `sessionClient` — `createServerClient` from `@supabase/ssr` with `ANON_KEY` + cookies.
     Used only for `auth.getUser()`. Never touches the database directly.

  2. `serviceClient` — plain `createClient` from `@supabase/supabase-js` with
     `SERVICE_ROLE_KEY`, no cookies. Used for all DB operations.

Auth check (user authenticated, role verified) runs before any data read.

Reasoning:
The SSR client is designed to bridge the browser session into server-side requests. Its
cookie integration is what enables session-aware auth. But this same mechanism overwrites
the service role key once the session loads. The only safe use of the SSR client is for
the single `auth.getUser()` call. All DB work must go through a plain service client that
has no session context and therefore maintains service_role throughout.

Rejected alternatives:
- Single SSR client with service role key: broken by design — see context above.
- Single service client for everything (no SSR): loses the ability to verify the user
  session cookie. auth.getUser() on a plain service client does not validate cookies.

Consequences:
Every new operator or authenticated route must follow the two-client pattern.
The shared helper `src/lib/supabase/require-operator.ts` encapsulates the auth +
role-check using the two-client pattern; import it instead of duplicating the logic.
Routes using only the session (no privileged DB operations) can continue to use a single
SSR client with ANON_KEY.

---

## ADR-028 — Code validators as hard gates on LLM output; prompt instructions are advisory only
Date: June 2026 | Status: Accepted

Context:
LLM-generated content passes through two layers of style enforcement:
  1. Prompt instructions: "Scan your output before returning. Never use em dashes."
  2. Runtime code validators: `scrubAITells()`, `assertNoDashes()`, messaging
     sequence validator (character limits, word counts, sign-off rules).

There is a standing temptation to rely on the prompt instructions as the primary
(or sole) enforcement mechanism, reasoning that the LLM follows instructions well
enough that a code gate is redundant. This reasoning is incorrect and dangerous.

The ICP/TOV/positioning/messaging agents target `claude-opus-4-6`, which generally
follows style instructions reliably. But "reliably" is not "deterministically."
LLM instruction-following degrades under: context length pressure, complex
structured-output constraints competing with prose-quality constraints, model
updates, and edge cases the prompt author did not anticipate. Prompt instructions
are not a testable contract. Code validators are.

The email sequence validator already demonstrates the correct pattern: every
character limit, word count, and format constraint is enforced by code that throws
before anything reaches the database, regardless of what the prompt requested.
The messaging agent prompt also specifies these constraints. The two must agree
(per CLAUDE.md: "When a prompt and a validator enforce the same rule, they must
agree exactly") — but the code is the authority.

Decision:
Prompt instructions for style and format rules are advisory guidance for the LLM.
Code validators are the enforcement gate. Both must exist. Neither replaces the other.

Enforcement hierarchy:
  Prompt instructions  → set the LLM's intent; produce higher-quality first-draft output
  scrubAITells()       → catch any em-dash / AI-tell slippage at runtime before DB write
  assertNoDashes()     → zero-tolerance hard throw; nothing with dashes reaches storage
  Sequence validator   → enforces all structural constraints (counts, nulls, sign-offs)

Any new LLM-generated output type that produces customer-facing content must have:
  1. Style rules in the prompt (specific, enumerated, not vague)
  2. A runtime code scrub/validator that enforces the same rules deterministically

Adding rules to only the prompt is incomplete. Adding rules to only the validator
without the prompt degrades output quality (the LLM doesn't know the constraint
until correction time). Both layers are required, and they must agree.

Reasoning:
A validator catches what the prompt missed. This is not a theoretical edge case —
the em-dash ban in the prompt does not prevent the model from emitting em-dashes
under novel phrasing or context pressure. `assertNoDashes()` is the guarantee,
not the prompt. The prompt is why the guarantee rarely fires.

The cost of the code validator is one parse pass over a string that has already
been generated. That cost is negligible compared to the cost of re-running the
full agent because an em-dash slipped through to a client-visible document.

Consequences:
New agents producing customer-facing text must call `scrubAITells()` before storage.
New structured output types with hard limits must have a validator enforcing them.
When a prompt rule and a validator rule conflict, the validator rule is authoritative
and the prompt must be updated to match in the same commit (per CLAUDE.md).
Prompt-only enforcement is a defect, not a design choice.

## ADR-031 — Two-pass email verification, with send eligibility resolved by one function

Date: 2026-08-25
Status: Accepted

Context.
MyEmailVerifier reports "Catch All" for domains that accept mail for every address. That is
honest: an SMTP probe cannot confirm a specific mailbox on such a domain. It is also a dead
end at current volume, because sending best practice caps accept-all addresses at 2-5% of a
campaign. Eight catch-alls carrying finished, paid-for copy would need a batch of 160-400
prospects to mail inside that cap, against 13 send-eligible prospects in total. The only route
to those eight is resolving them OUT of the bucket.

A sample of 10 live catch-alls through Bouncer on 2026-08-25 returned 8 deliverable, 2 risky,
0 undeliverable, with domain.acceptAll "yes" on all ten. The vendor agrees the domains are
catch-all and resolves the individual addresses anyway, via provider APIs rather than a better
probe. n=10, 95% interval roughly 44-97%, all inside the vendor's stated Google/Microsoft
sweet spot: a best case, not a forecast.

Decision.

1. TWO PASSES, NOT A VENDOR SWAP. The cheap verifier runs on the whole list. The paid one runs
   only on the segment the first could not confirm. MyEmailVerifier is not being replaced,
   because it is not wrong.

2. VERDICTS IN COLUMNS, PAID CALLS IN A LEDGER. second_pass_* columns on prospects hold the
   verdict; verification_calls holds one row per paid attempt, written BEFORE the call. These
   are two different needs. The verdict is read on the hot path at send and research time and
   wants to be a flat column. Counting paid calls cannot be done from verdicts at all, because
   a call that spends money and then fails writes no verdict, so counting verdicts undercounts
   spend by exactly the failures.

3. ONE FUNCTION MATERIALISES email_send_eligible. resolveSendEligibility is the only writer.
   The column stays materialised because the send gate is right to want one fast flat read,
   but with two passes writing it the obvious failure is that its value depends on which pass
   ran last. The rule: a confirmed-deliverable first pass is eligible; a confirmed-dead
   mailbox is never overturned by a second opinion and never spends a paid call; an
   unconfirmable address becomes eligible only if the second pass resolves it to deliverable;
   country exclusion is a hard AND that can only ever remove eligibility.

4. GATE ON THE VENDOR'S STATUS, NOT ITS SCORE. The sample scored 90 eight times, then 75 and
   15, which suggests a threshold near 80 and cannot support one: the entire range between 75
   and 90 is unobserved. The score is recorded on every prospect so a threshold can be derived
   later from real data.

5. EACH HANDLER OWNS ITS VENDOR'S VOCABULARY. verification-verdict.ts composes a registry from
   maps the handlers export and holds no vendor words itself. Adding a third vendor is a new
   handler plus one registry line. This closes leak L7 from the catch-all handover, which was
   correctly deferred until a second vocabulary existed.

Consequences.
- The catch-all bucket becomes recoverable at roughly $0.008 per address, against research
  already spent at $0.24 per prospect. The research money on these rows is sunk either way.
- A paid vendor introduces a budget that must be enforced, so the ledger is not optional. The
  daily cap fails CLOSED on an unreadable count.
- The research spend gate now reads both passes. Without that wiring a recovered catch-all
  would still be refused research and the money spent resolving it would buy nothing.
- Two gates deliberately disagree on an unreadable vendor word: send fails closed, research
  fails open. An unrecognised status almost always means a vendor renamed something, and
  halting all research platform-wide on a rename is far worse than researching a few
  addresses.

Rejected alternatives.
- OVERWRITING independent_email_status with the newer verdict. Cheapest, and it destroys the
  fact that justifies the send: "vendor two said deliverable on a domain vendor one called
  catch-all". It also makes policy unchangeable without paying to re-verify, which is the
  precise mistake send-eligibility-policy.ts already documents at length.
- A GENERIC verification_results TABLE, one row per prospect per provider per attempt. More
  correct in the abstract. It adds a join to every place eligibility is read, to buy
  flexibility for a third vendor that does not exist. The paid-call accounting it would also
  provide is met by the much smaller verification_calls ledger.
- A FOURTH QUEUE JOB TYPE. The verify-pending route said to revisit this "if verification ever
  becomes paid per address", and that trigger has fired. The answer is still no, for a
  different reason: the queue's mechanism is a spend stamp written when a call returns, and
  the ledger does the same job more directly by writing before the call. The queue would
  additionally buy retry orchestration and concurrency, neither of which applies, since a
  failed probe here should NOT be retried aggressively because each retry bills.
- ROUTING THROUGH THE CAPABILITY REGISTRY (leak L3). Deliberately not done, per the handover.
  src/lib/handlers/capability.ts has an empty handler map, zero callers, a signature that does
  not match the map, and all 14 integrations_registry rows read connection_status
  'disconnected'. Every integration in this repo bypasses it identically. Closing that gap is
  a deliberate repo-wide change, not a rider on this build.

## ADR-035: A four-state monitor collapsed onto the sweep's three, and why `insufficient_sends` reads OK

**Date:** 2026-08-27
**Status:** Accepted. Proposed during the MON-023 build, questioned by Doug against live
output, the alternative was costed, and Doug confirmed "keep the mapping as built."

### The thing that looks like a bug and is not

MON-023 reports **`state = OK`** while its verdict says **`insufficient_sends`**. On the
operator dashboard the same moment renders as five domains all reading "not enough sends".

That looks wrong at a glance, and the first instinct on reading it is to change it. This
ADR exists so that instinct meets an argument instead of an empty comment.

### The constraint

`monitor_events.state` accepts exactly three values: `OK`, `PROBLEM`, `UNKNOWN`. MON-023
has four answers, because two would lie:

    healthy             judged by both rules, clean
    insufficient_sends  nothing breached, but no domain cleared the 50-send floor, so the
                        rate rule judged NOTHING
    stale               the verdict is too old to trust, whatever it says
    failing             a domain breached

Four onto three needs a collapse. The only real question is where `insufficient_sends`
goes.

### The mapping, and the cost of each alternative

    failing            -> PROBLEM
    stale              -> PROBLEM
    no_data            -> UNKNOWN
    insufficient_sends -> OK          <- the decision
    healthy            -> OK

**`insufficient_sends -> UNKNOWN` is the intuitive answer and it makes the check DARK.**
The sweep writes an event only on a state CHANGE, and it treats "no prior event" as
`UNKNOWN`. A check whose natural resting state is `UNKNOWN` therefore never writes its
first row: `currentState === lastState`, so `shouldRecord` is false, forever. It renders
identically to MON-008 — registered, silent, and impossible to distinguish from a monitor
nothing queries. That is the exact defect the MON-019 incident was about, and the pair
registry was rebuilt to prevent. Choosing it here would reintroduce it by the front door.

**`insufficient_sends -> PROBLEM` is permanently red.** Trigger 2 cannot fire until
sending throughput rises, so MON-023 would alarm continuously for weeks about a condition
nobody can act on. A monitor that is always red is a monitor that gets ignored, and it
would drag the whole sweep's `ok` down with it.

**`OK` is honest, because the check IS passing.** The absolute rule (3 bounces on one
domain, any rate) runs at every volume, ran, and found nothing. Half the check genuinely
judged and genuinely passed. What did not run is the rate rule, and that fact is not
swallowed: it is stated in words in the `detail` line the operator reads, carried in
`sending_health_snapshot.overall_state`, and rendered per domain on the dashboard in grey
with the words "not enough sends", never in green.

### The distinction this preserves

**The traffic light answers "should you act". The detail answers "what is known".** They
are different questions and collapsing them is what forces the four-into-three problem in
the first place. Nothing that matters is lost, because nothing about
`insufficient_sends` requires action.

### Consequences

- Anything reading `monitor_events.state` alone cannot tell `healthy` from
  `insufficient_sends`. That is accepted. `sending_health_snapshot.overall_state` is the
  field to read when the difference matters, and the operator panel reads it.
- Any FUTURE monitor with more than three states inherits this problem. The rule to carry:
  a state whose resting value would be `UNKNOWN` must not be mapped there, or the check is
  born dark. Fixing that properly means changing the shared sweep to write an event on
  first sight regardless of state, which touches all 21 monitors and was not in scope.
- The mapping is locked by tests (`monitor-state.test.ts`) and covered by the mutation
  suite (`scripts/mutation-test-sending-health.sh`, cases S3 and S4), so changing it
  breaks something loudly rather than quietly.

### Verified live

2026-08-27, first production sweeps after the merge:

    16:00:03  PROBLEM  verdict 113 minutes old, past the 60-minute limit   (staleness guard)
    16:15:05  OK       "No domain reached 50 sends ... so the rate rule judged nothing.
                        The 3-bounce rule was applied and found nothing."

Both the guard and the mapping behaved as designed on real data.


## ADR-030 — Client reply view: org-scoping RLS-backed, intent-filtering chokepoint-enforced
<!-- Renumbered from ADR-026 on 2026-08-24. Two entries carried that number: this one and
     "Per-lead custom variables for sequence content delivery" earlier in this file. The
     earlier one keeps 026 because it is referenced by date in the composition docs; this
     one moved to the next free number. The only code reference was the describe() block in
     src/lib/metrics/get-client-visible-campaign-metrics.test.ts, updated in the same commit. -->

Date: June 2026 | Status: Accepted

### Context

The client reply view (new) exposes reply data to authenticated clients for the first time. Prior to this build, clients had no visibility into replies. The view must enforce two independent filters:

1. **Org-scoping**: a client from org A must NEVER see org B's replies (confidentiality boundary)
2. **Intent-filtering**: a client must see ONLY the 5 positive intents (positive_direct_booking, positive_passive, information_request_generic, information_request_commercial, objection_mild), never opt_out, out_of_office, or unclear

The two filters have different enforcement models. This asymmetry is worth recording.

### Decision

**Org-scoping: RLS-backed + query-level filter (defence-in-depth)**
- RLS policy: `clients_read_own_replies` on reply_handling_actions table, scoped by `organisation_id`
- Query-level filter: `WHERE organisation_id = $clientOrgId` in every client-facing query
- Consequence: if application code forgets the WHERE clause, RLS still blocks cross-org reads

**Intent-filtering: Chokepoint-enforced ONLY (no database backstop)**
- Single function: `getClientVisibleReplies()` in src/lib/reply-handling/get-client-visible-replies.ts
- ALL client-facing reply reads MUST go through this function; direct table queries are prohibited
- The function always applies: `WHERE classified_intent IN ('positive_direct_booking', 'positive_passive', ...)`
- Consequence: if a client-facing query ever bypasses the choicepoint, it has no database protection — the intent filter is ONLY application-level

WHY the asymmetry?
- Org-scoping is table-level: different rows have different `organisation_id` values; an RLS policy can filter rows by `organisation_id`
- Intent-filtering is value-level: all rows are from the same client, but some have hidden intent values; an RLS policy cannot filter rows based on column values within the same table (RLS works on org_id, not on fields within a client's data)
- The architectural consequence: org-scoping gets a database backstop; intent-filtering does not

### Enforcement

Single chokepoint: `getClientVisibleReplies(supabase, clientOrgId)`
- Takes supabase client and client's organisation_id
- Returns only rows where organisation_id == clientOrgId AND classified_intent IN (5 positive intents)
- This is the ONLY function client-facing code may call to read reply data

The client reply page (/dashboard/(client)/replies/page.tsx) calls this function.
No route in the client-auth area queries reply_handling_actions or signals directly.

### Tests

All passing; DRY RUN test org seeded at fixture creation, never deleted:

1. **Cross-org filtering**: org A's query returns zero org B rows (chokepoint enforces organisation_id filter)
2. **Intent filtering**: org A's query with all 8 intents present returns zero opt_out/out_of_office/unclear rows (chokepoint enforces intent filter at data layer, not UI-only)
3. **Operator view unfiltered**: getAllRepliesForOrg(orgId) returns all 8 intents for campaign health monitoring

### Consequences

1. `getClientVisibleReplies()` is a chokepoint. Any new client-facing reply read must use this function.
2. `getAllRepliesForOrg()` is the operator-only variant (no intent filtering, returns all 8 intents).
3. Do NOT scatter the org + intent filters across multiple queries. Do NOT add a "raw" query path for client data. The chokepoint enforces both together.
4. Intent-filtering has no database backstop. Showing a client a hidden intent (opt_out, out_of_office, unclear) is a relationship-damaging failure. The chokepoint's invariant (hardened by tests) prevents this.
5. RLS policy `clients_read_own_replies` is the last-line defence for org-scoping. If the chokepoint ever bypasses the WHERE clause, RLS catches it. This defence does not exist for intent-filtering.

### Rationale

Org-scoping needs defence-in-depth because a cross-org leak is a security failure. Showing org A one row from org B is a breach.

Intent-filtering is application-enforced only because the intent values all belong to the same client; an RLS policy works on rows/users, not on column values within a user's scope. The chokepoint pattern (one function, always called, always applies both filters) is simpler and sufficient.

### Follow-ups (tracked in BACKLOG.md)
- Authenticated-user RLS test deferred (JWT-minting limitation, pre-second-client item)
- Client-note feature deferred (fast-follow only if clients ask)

---

## ADR-029 — Durable job queue in its own table; agent_runs stays the history
Date: August 2026 | Status: Accepted

Context:
Three units of slow, money-spending work ran inside a single web request: Apollo
enrichment, prospect research (Apify plus Anthropic), and sequence composition
(Anthropic). Vercel terminates any request at 300s and this is the Hobby maximum,
not a configurable default. Research is measured at 46.8s of wall clock per prospect
(FRESH_SECONDS_PER_PROSPECT), so one request admitted about five prospects before the
admission check refused the rest. Onboarding a client with hundreds of never-seen
prospects therefore meant hundreds of manual clicks, or running the CLI from a
terminal in one long-lived process.

Enrichment additionally carries a money bug of a specific class. The Apollo re-spend
fixed in 3de0589 was a crash mid-job that left the work claimable and payable twice:
the money left at the START of a run and the outcome was written at the END, so every
failure path in between left a row that looked untouched. On 10 August 2026 that cost
141 credits for 29 prospects, 4.86 each, against Apollo's ceiling of one per contact.
A lease with a spend stamp is the structural fix for that class, not a patch for that
instance.

There was an obvious temptation to extend agent_runs rather than add a table. It
already has organisation_id, a status, timestamps and an error message, and it is
already written by every agent.

Decision:
A new table, job_queue, holding one row per prospect per job type. agent_runs is not
extended and does not change.

agent_runs is a HISTORY table, written after the fact to record that something ran.
Its columns are id, organisation_id, agent_name, status, started_at, completed_at,
duration_ms, output_summary, error_message. It has no claim state, no lease, no
attempt count and no spend record. Those four are the entire substance of a durable
queue. Adding them would give one table two meanings, "what happened" and "what is
happening", which is the failure class that has cost this build the most time.

Both are written during a job, and they answer different questions:
  agent_runs  what did we run, when, and how long did it take
  job_queue   what is owed, who holds it, what has it cost, and what happens next

Consequences:
- Claiming is a single UPDATE ... RETURNING with FOR UPDATE SKIP LOCKED, never a
  SELECT followed by an UPDATE. Two workers take disjoint sets by construction.
- A claim carries a lease, not a lock, so a dead worker's job is reclaimable. Reclaim
  must never re-spend: a job whose spend_recorded_at is set goes terminal instead of
  calling the paid API again.
- attempts increments at claim time, not at completion, so a job that reliably kills
  its worker still exhausts its attempts and terminates rather than looping forever.
- Failures are classified at the point of failure as transient or permanent. A 429 or
  529 backs off; a 400 or an auth failure is terminal. Treating both alike either
  loses work or burns money.
- Per-organisation round-robin rather than plain FIFO, so one client's large batch
  cannot starve another client's small one.
- Rollout is behind an explicit database flag per job type (system_flags), never
  inferred from environment shape. The inline paths stay until each type is proven.

What this ADR does NOT cover, added 2026-08-29:
  The Context above names three units of slow work: enrichment, research, and
  SEQUENCE COMPOSITION. The queue shipped for the first two only. src/lib/queue/
  enqueue/ holds exactly two files, enrich.ts and research.ts, and the live job_queue
  table holds exactly two job types.

  Lead upload and composition are still an inline Vercel SERVER ACTION.
  handleUploadLeads at src/app/dashboard/operator/clients/[id]/actions.ts:222 runs
  under a ~60s server-action timeout, composes in chunks of COMPOSE_CHUNK_SIZE=50
  (actions.ts:206) via Promise.all, and calls uploadLeads once per campaign with no
  batching, no timeout guard and no resume. There is no enqueue call in that file.

  So the 500-prospect upload ceiling is OPEN, not solved by this ADR. The first send
  of 24 was safe; 500 is not buildable on the current path. Tracked in Notion Backlog
  as "Move lead upload onto the job queue before the 500-prospect run", Pre-C0.

  This paragraph exists because the ADR previously read as though the whole problem
  had been solved, and an ADR that overstates its own scope stops the next person
  looking. Same failure class as a doc asserting a policy was dropped when it was not.

Rejected alternatives:
- Extending agent_runs. See above.
- Vercel Queues. Real and would work, but it is a second durable store alongside
  Postgres, with its own failure modes and no way to answer "what is queued for this
  organisation" in the same query as the prospect rows. Postgres already gives us
  atomicity, SKIP LOCKED, and partial unique indexes for idempotency.
- A worker-count concurrency dial paced against Anthropic rate limits. Measured live,
  this account allows 10,000 requests/minute and 10M input tokens/minute. Research
  uses about three Anthropic calls per prospect and compose one, so Anthropic is
  nowhere near the binding constraint at any volume this platform will reach. The
  real ceiling is Apify: 25 concurrent actor runs and a monthly spend cap. The dial
  is therefore a global in-flight cap sized off Apify concurrency. Anthropic response
  headers are still read and acted on, documented in code as insurance against a tier
  change, explicitly not load-bearing.

---

## ADR-032 — Sourcing filter hardcoded in the handler; both location axes constrained
Date: August 2026 | Status: Accepted, with the headcount value and the long-term shape
superseded by ADR-036 (2026-08-27). Read that one too: it narrows
organization_num_employees_ranges to ['5,20'] and records this hardcoded filter as
superseded in principle by spec-driven sourcing, which is not built yet. Everything
else below still describes what ships.

Context:
The Apollo sourcing query was built by translating each client's ICPFilterSpec into
API parameters. That translation shipped three defects, and the common property of
all three is what makes this decision worth recording: every one of them ran
successfully, returned plausible results, and reported nothing wrong.

  1. q_keywords was used for category sourcing. It is AND over free text, matched
     against person and company NAMES, so it only ever found firms with the literal
     word in their name. Measured on the final base: 4,924 against 72,458 for NAICS
     alone. q_organization_keyword_tags is the OR parameter and the correct one.
     The two names look interchangeable and are not.

  2. Seniority was set to owner and founder, on the reasoning that the ICP is
     founder-led firms. Apollo derives seniority from job TITLE, not from ownership,
     and in professional services the owner is usually titled Partner or Managing
     Partner. Measured on the final base: 29,139 against 72,458 once c_suite and
     partner were added. The filter was excluding most of the population it was
     written to target, and the first live sample row after the fix is a Lead Partner.

  3. Geography was constrained on organization_locations only. That removes German
     and Canadian FIRMS. It does not remove a person sitting in Toronto who works for
     a US-registered company, and there were 545 such people in Canada and 238 in
     Germany. CASL attaches to the RECIPIENT. Two German GmbHs had already been mailed
     against an exclusion that lived in convention and had nothing to read it.

A fourth property of the Apollo API turns any of these into a permanent hazard:
APOLLO SILENTLY IGNORES A PARAMETER IT DOES NOT RECOGNISE. It does not error and it
does not warn. While establishing which parameter carries NAICS, both naics_codes and
q_organization_naics_codes returned 770,753, the completely unfiltered count. Only
organization_naics_codes is read. A parameter-name typo here does not fail: it ships a
filter that filters nothing and looks healthy on every dashboard.

Decision:
The Apollo search filter is HARDCODED in src/lib/sourcing/handlers/adapter-apollo.ts.
The ICPFilterSpec no longer builds the query. The filter is:

  organization_naics_codes            ['5416']
  q_organization_keyword_tags         management / business / strategy consulting
  organization_num_employees_ranges   ['5,50']   <- narrowed to ['5,20'] by ADR-036
  organization_locations              united states, united kingdom, ireland
  person_locations                    united states, united kingdom, ireland
  person_seniorities                  owner, founder, c_suite, partner
  contact_email_status                ['verified']

Live total_entries 55,975, measured 2026-08-26.

Three parts of this are load-bearing and easy to undo by accident:

BOTH LOCATION AXES ARE CONSTRAINED, to the same three countries. Constraining only the
organization axis is what left the 545 Canadians reachable. Cost of closing it: 61,523
to 55,975, some 5,548 rows or about 9 percent of inventory. That trade was made
explicitly on the grounds that nine percent of inventory is affordable and a complaint
is not, and that Canada was removed on legal grounds rather than preference.

NAICS 5418 IS NOT EXCLUDED. Firms carry more than one NAICS code, so a consultancy
coded both 5416 and 5418 is in scope and an exclusion rule would drop it. Adding 5418
to the include list is a different thing and is not wanted: it measures 66,134.

EVERY PARAMETER IS PROVED BY MEASUREMENT, never by reading the docs and assuming,
because of the silent-ignore property above. The person_locations line was verified by
arithmetic rather than assertion: adding a country back to it returns precisely the
people it was excluding. +canada gives 56,520, which is 55,975 plus exactly the 545,
and +germany gives 56,213, which is 55,975 plus exactly the 238. An ignored parameter
would have left the total unchanged.

Consequences:

Accepted knowingly: THE ORCHESTRATOR'S MANIFEST CHECK NO LONGER DESCRIBES THE QUERY.
Step 4 of the sourcing orchestrator compares populated spec fields against
handler.supported_fields and still passes. It is now a check that runs, reports
success, and says nothing about what is actually sent, which is precisely the
silent-failure shape CLAUDE.md warns about. It was left in place deliberately:
narrowing supported_fields would make the orchestrator THROW for any client whose spec
populates a field the hardcoded filter ignores, which would stop sourcing rather than
improve it. The trade is recorded here and commented at the call site rather than left
to be rediscovered. Revisit when the config layer returns.

SUPERSEDED 2026-09-04, this paragraph only. The two spec defaults named below NO LONGER
EXIST: they were deleted, not adjusted, and each client's countries are now derived from
that client's own ICP document and then subtracted against the exclusion lists at one
point. The rest of this ADR still holds. The paragraph is kept rather than rewritten
because it records why the defaults were set to the filter's contents, which is the
reasoning the deletion replaces. Original text follows.

The ICP spec defaults were changed to match: DEFAULT_PERSON_COUNTRIES and
DEFAULT_COMPANY_COUNTRIES are now ['GB', 'IE', 'US']. Enforcement lives at the filter
and no spec value can widen it, but a default listing a country the filter refuses is
a document that lies, and it made the adapter log a divergence on every run. AU and NL
went in the same edit for the same reason. Widening that list alone now changes
nothing about who is sourced: both it and APOLLO_FILTER must change together.

This is deliberately NOT tool-agnostic in the usual sense, and that is the cost being
accepted. ADR-001 and ADR-015 put translation inside the handler, and that still holds:
the hardcoding is inside the Apollo handler, nothing upstream of it sees Apollo
parameter names, and swapping sourcing tools still means a new handler. What is given
up is per-client configurability of the filter, which existed and produced three
defects. One filter that has been measured beats a config layer that has not.

Alternatives rejected:

Keep the spec-driven translation and fix the three bugs. Rejected because the defects
were not arithmetic errors, they were wrong beliefs about what Apollo's parameters mean,
and the translation layer gave those beliefs somewhere to hide. With one hardcoded
filter the query is readable in one screen and every value carries its measurement.

Remove DE and CA from the spec defaults only, and leave the filter permissive.
Rejected: that is what was already in place. A convention with nothing enforcing it is
exactly what the two mailed GmbHs had to protect them.

Revisit when: client two needs a different filter. At that point restore the
ISO-3166-to-Apollo location table and the seniority map from git history at bc05658,
and reinstate the manifest check as a real gate in the same change.

---

<!-- Renumbered from ADR-032 to ADR-033 at merge on 2026-08-26. Two branches
     claimed 032 independently; the sourcing filter merged first and has inbound
     references from HANDOVER-sourcing-filter.md and BACKLOG.md. -->
## ADR-033: Research synthesis runs through the Batch API, split into two jobs

**Date:** 2026-08-26
**Status:** Accepted, rolling out behind a flag

### Context

Synthesis is one Anthropic call per prospect and roughly 78% of the Anthropic spend
per prospect (about $0.118 of $0.159, inside an all-in $0.192). The Batch API charges
50% of standard prices for identical bytes to an identical model, and the discount
stacks with prompt caching. So the saving is available with no quality trade.

The cost is time. A batch may take up to 24 hours. Nothing in this system can hold a
lease that long: research's lease is 360 seconds and reap-agent-runs marks any
agent_runs row still 'running' after 600 seconds as failed.

### Decision

Research splits into two queue job types with a wait between them.

- `research_sources` fetches the four sources, snapshots everything the second half
  needs, and submits the synthesis calls. Records spend. Completes.
- A pg_cron sweep polls batch status. Nothing holds a lease.
- `research_collect` reads the synthesis out of the batch result, runs writer, floor
  and judge as today, and writes ONE complete prospect_research_results row.

The existing single-job `research` path is NOT removed. Rollback is a flag flip with
no deploy.

### Why this is safe under the existing queue

`decideExecution` is pure and per-row: it terminates any claimed job carrying
`spend_recorded_at`. Two separate jobs means two independent stamps, so nothing is
ever claimed twice after paying. An earlier analysis concluded batching would need a
queue rewrite; that was true only for batching INSIDE the agent, where a single job
would pause 24 hours and lose its lease.

### The intermediate state lives in its own table, not in a half-written research row

`storeResearchResult` requires an `opening`, so there is no row shape meaning
"synthesis done, opening pending". And `loadStoredFindings` filters reuse candidates
on `candidates.length > 0` and nothing else, so a synthesis-only row HAS candidates:
an ordinary later run would select it as reuse material and hand a different prospect
a synthesis with no judged opening, silently.

`synthesis_batches` and `synthesis_batch_entries` remove that failure rather than
guarding against it. `storeResearchResult`, `loadStoredFindings` and every live
selection path are untouched.

### Everything phase 2 needs is SNAPSHOTTED, never re-read

A 24-hour gap turns every re-read into a silent drift: the copy is simply different
and nothing fails. Snapshotted: the four source payloads, the approved messaging
document content, the assigned variant, the recency signal, and the client document
context. The messaging document is the one that would have shipped wrong copy, and it
is why compose was never migrated to the queue.

### Consequences accepted

- **`batch_id` on an entry is ON DELETE SET NULL, not CASCADE.** These rows hold
  sources bought with real money. Pruning old batch rows is exactly the tidy-up
  someone runs without thinking about what it takes with it. Orphaning an entry is
  recoverable; deleting the snapshot is not.
- **The two research paths are mutually exclusive, enforced by a unique index on
  system_flags.** Both fetch sources and therefore both start Apify actors against a
  measured ceiling of 25 concurrent runs. With both at maxInFlight 20, allowing both
  to be enabled would permit 40. The exclusion is what lets the Apify assertion take a
  MAX across source-fetching job types rather than a SUM, which in turn lets the
  proven path keep its measured configuration unchanged.
- **One live research job per prospect, across all three research types.** The
  existing per-type index does not span job types, and during a batch wait the
  prospect still reads as unresearched. Without this, one operator click mid-wait
  re-pays Apify, Apollo and Brave for every prospect in flight: the 10 August 2026
  shape, 141 credits for 29 prospects.
- **The 1-hour cache TTL on the batched call is PROVISIONAL.** Anthropic documents
  in-batch cache hits as best-effort at 30% to 98%. A 1-hour write costs 2x base input
  against 1.25x for 5 minutes, so at the bottom of that range the 1-hour TTL is a
  loss. A 13-call probe measured 85% at 1h, but with max_tokens 16 rather than
  production's 16,000. The real `cache_read_input_tokens` on the first live batch
  decides it.

### Rejected alternatives

- **Batching inside the agent.** The job would pause for the batch and lose its
  360-second lease. This is what made an earlier session conclude a queue rewrite was
  needed.
- **A nullable-opening research row.** See above: the reuse filter would select it.
- **Batches of one, submitted by each phase-1 job.** Keeps the 50% discount and needs
  no separate submitter, but maximises the number of independently scheduled batches,
  which is the condition Anthropic names as reducing best-effort cache hits, and turns
  one batch id to poll per organisation into one per prospect.
- **Dropping `research.maxInFlight` from 20 to 15 to make room for the batch path.**
  Would have been necessary if the Apify assertion summed across paths. Proving the
  exclusion instead leaves a proven number alone.

---

## ADR-034: Send eligibility is evaluated once, at verification, and frozen on the row

**Date:** 2026-08-26
**Status:** Accepted as a description of what the system does. The consequences are
accepted; the retroactivity gap is NOT, and is tracked in BACKLOG.

### The fact, stated plainly

`prospects.email_send_eligible` is a MATERIALISED VERDICT, not an evaluated predicate.

It is written in exactly two places, both at verification time:

- `verification-trigger.ts:490` — `eligibilityCheck.is_eligible && result.send_eligible`
- `second-pass-trigger.ts:557` — `decision.eligible`, from `resolveSendEligibility`

`checkSendEligibility`, which owns the country rule and `EXCLUDED_COUNTRIES`, is called
in exactly two places, and both are those same verification paths:

- `verification-trigger.ts:484`
- `send-eligibility-resolver.ts:97`

**It is never called in the send path.** `handleUploadLeads` gates on the stored column
at `actions.ts:288` and `actions.ts:329`.

### Therefore

**Adding a country to `EXCLUDED_COUNTRIES` is NOT retroactive.** A prospect verified
before the change keeps `email_send_eligible = true` until it is verified again, and
verification costs money. The exclusion list governs prospects verified from that moment
on, and nothing else.

The same applies to any change in `CATCH_ALL_IS_RESEARCH_WORTHY`'s send-side counterpart,
to the Bouncer status mapping, and to any future rule that feeds either write site.

### Why it is like this, because the design is defensible

The column is the last word at send time on purpose. Re-evaluating the full predicate
during the upload claim would mean joining verification state into a hot path that
currently claims rows with a single conditional UPDATE, and the claim is what makes the
send path race-safe. `send-eligibility-policy.ts:20-40` documents the mirror-image
decision for the research spend filter, and reaches the opposite answer for good reasons:
that filter reads the RAW verdict precisely because it needs policy to be changeable
without re-verifying.

So the split is deliberate. What was not deliberate is that nobody wrote down that the
send side is frozen.

### The consequence, and it is not hypothetical

This is the mechanism behind the German-prospect incident.

`country` was normalised to ISO-2 and `EXCLUDED_COUNTRIES` was taught to match aliases on
2026-08-25. Both fixes are correct. Neither one reached the two prospects already
verified, already uploaded, and already mid-sequence in the outbound provider. Their rows
now read `email_send_eligible = false, country_excluded_de` and that changed nothing about
what the provider was going to do next, because our gate governs UPLOAD and the provider
owns the SEQUENCE.

Four emails reached German recipients, not the two the incident record captured: step
`0_0_0` on 2026-08-21 and step `0_1_0` on 2026-08-24, verified against the provider's own
sent-email log. The second went out one day before the fix landed.

### What follows from it, for anyone changing an eligibility rule

1. **Changing a rule does not change a prospect.** If a rule change must apply to existing
   prospects, it needs an explicit re-evaluation pass, and if that pass calls a paid
   verifier it needs a budget decision. There is no code path today that re-evaluates
   eligibility without re-verifying.
2. **Our gates govern upload, not delivery.** Once a prospect is uploaded, the outbound
   provider owns the sequence. Marking a row ineligible afterwards is a no-op with respect
   to email that has not been sent yet. Stopping in-flight sends is a provider-side action
   and there is no code for it.
3. **A compliance rule therefore needs a third layer**, and does not have one: the write
   path (normalise), the evaluation (rule), and a REMOVAL path for prospects already in
   flight. Only the first two exist.

### Rejected

- **Re-evaluating in the send claim.** Would make the rule live, and would put verification
  state into the conditional UPDATE that makes the claim race-safe. Not taken now because
  it is a change to the one path where a race sends duplicate email, and it should not be
  made in the same change as anything else.
- **Treating the column as authoritative and saying nothing.** That is the status quo this
  ADR exists to end. The behaviour is defensible; being undocumented is what let it
  surprise us.

---

## ADR-036: The 5-20 headcount narrowing is a stopgap, and the 21-50 band is declared but not sourced

**Date:** 2026-08-27
**Status:** Accepted, explicitly temporary

### Context

MargenticOS's ICP narrows to firms of 5 to 20 employees for the ramp. The Apollo
sourcing filter asked for 5 to 50.

Measured live on 2026-08-27 against the shipped filter, changing only
`organization_num_employees_ranges`, by importing the handler rather than re-typing
its values:

  5,20   (shipped)    36,818
  21,50  (tier_2)     19,162
  5,50   (previous)   55,980

The two bands partition the previous filter exactly: 36,818 + 19,162 = 55,980, zero
residual. That arithmetic is the check that matters, not the individual counts.
Apollo silently ignores a parameter it does not recognise (ADR-032), so a range string
it failed to parse returns a plausible number rather than an error. A clean partition
across three independent queries cannot happen by accident; two numbers that merely
look reasonable can.

So the narrowing gives up about 34 percent of reachable inventory. 36,818 is ample for
the ramp at current send volumes, which is the only reason this is affordable.

**The two briefing figures came from different filter bases. Resolved, and worth
keeping.** The narrowing was specified with 36,820 at 5-20 and 20,269 at 21-50. The
first reproduced against the shipped filter and the second did not, which is what
prompted measuring all three bases:

  band     both axes    person_locations only    organization_locations only
  5,20       36,818            39,867                      40,293
  21,50      19,160            20,268                      21,245
  5,50       55,978            60,135                      61,538

36,820 is the BOTH-AXES figure (36,818, two rows of index drift). 20,269 is the
PERSON-LOCATIONS-ONLY figure (20,268, one row). Both were correct measurements of
different queries, and the pair was mixed.

That table is a SECOND pass, taken a few minutes after the three figures quoted above
it, which is why its both-axes column reads 19,160 and 55,978 rather than 19,162 and
55,980. Both passes partition exactly (36,818 + 19,160 = 55,978). Two rows in minutes
is the drift scale to expect from Apollo's index, and it is the reason every figure
here is quoted with the date and the base it came from rather than on its own.

It is recorded because the mix biases the one judgement the numbers exist to support.
Read as a pair, 36,820 against 20,269 says the narrowing gives up 35.5 percent. On a
single consistent base it gives up 34.2 percent. That difference does not change the
decision, and would have changed nothing if it had gone the other way by the same
margin, which is exactly why it would never have been caught by whether the conclusion
still looked right.

**The shipped filter constrains both axes**, per ADR-032, because CASL attaches to the
recipient. So the both-axes column is the only one describing prospects this system can
actually source, and it is the column every figure in this ADR is quoted from.

The awkward part is not the number. It is WHERE the number lives. Under ADR-032 the
Apollo query is hardcoded in the handler and the ICPFilterSpec no longer builds it.
That decision was correct and is not being reopened here: a config layer that shipped
three silent defects was replaced by one filter that carries its measurements. But it
has a consequence that only becomes visible when the ICP acquires a second tier.

### Decision

Three things, and the third is the one that will be forgotten.

**1. `organization_num_employees_ranges` becomes `['5,20']`.** One constant, in
`src/lib/sourcing/handlers/adapter-apollo.ts`. Reversing this decision is editing that
one string back to `'5,50'`. Nothing else in the filter was tuned to compensate, and
nothing else needs to change to widen it again. That was deliberate: a stopgap that
takes six coordinated edits to undo is not a stopgap, it is a migration.

**2. The 21-50 band is declared in the ICP document as `tier_2`, and is DELIBERATELY
NOT SOURCED.** Those 19,160 firms are in the ICP and out of the query. This is a
decision, not an oversight, and it is recorded here precisely so that the next person
to notice the gap finds an answer instead of a bug.

**`tier_2` MEANS TWO UNRELATED THINGS IN THIS CODEBASE, and this ADR is about the
first one only.** The collision is real, it predates this decision, and reading the
wrong one turns everything below into nonsense.

  IcpDocument.tier_2          A DECLARED MARKET SEGMENT. A band of the addressable
  (icp-filter-spec.ts:162)    market, defined before any prospect exists, describing
                              WHO WE WOULD SELL TO. Population-level. This is the
                              tier_2 this ADR narrows out of the query.

  prospects.sourced_tier      A PER-PROSPECT FIT SCORE, assigned after sourcing and
  = 'tier_2'                  enrichment by calculateFitScore in
  (tier-classification.ts)    tier-classification.ts. Points for industry, seniority
                              and headcount, bucketed into tier_1/2/3, describing HOW
                              WELL THIS ONE PERSON MATCHES. Row-level. Nothing to do
                              with the ICP document's tiers.

They are different axes, not two views of one thing. A prospect from the ICP's tier_1
segment can score `sourced_tier = 'tier_3'` and frequently will, because the score is
dominated by seniority and industry rather than by headcount. Narrowing the sourced
headcount band does NOT empty the `sourced_tier = 'tier_2'` bucket, and nothing in the
sourcing-review UI changes meaning because of this decision.

A third thing is worth knowing while looking at this: `icp-filter-spec.ts:220` builds
the headcount range as the UNION of the ICP's tier_1 and tier_2, commented "Both tiers
are sourced". That comment described the spec-driven query, which ADR-032 removed. The
spec no longer builds the Apollo query, so the union is computed and discarded. It is
not wrong, it is unreached, and it is the clearest single illustration of what
ADR-032's hardcoding costs.

**3. ADR-032's hardcoded filter is hereby SUPERSEDED IN PRINCIPLE by spec-driven
sourcing, WHICH DOES NOT EXIST YET.** This is the honest statement of where the
architecture is. Naming a tier the system cannot ask for is the first thing the
hardcoded filter has cost that a comment at the call site does not cover, because it
is not a property of the Apollo query, it is a property of the ICP no longer fitting
in one query. ADR-032 stands as the current implementation and should be read as such.
It is now known to be the wrong long-term shape, and this is the ADR that says so.

Until that work lands there is exactly one filter, and every client sourced through
this handler gets it, whatever their spec says.

### Consequences

**The tier_2 declaration is the only record that roughly 19,160 firms were chosen
against rather than missed.** There is no code path that reads `tier_2` and nothing in the
system behaves differently because it exists. It is a document making a promise the
query cannot keep. Stated plainly here so it is not later mistaken for a feature.

**THE `sourced_tier` MIX SHIFTS SLIGHTLY TOWARD tier_1 FROM 2026-08-27, and this is
the cause.** Not a defect and not a change in what any tier means. It is written down
so a discontinuity dated today is not investigated as one.

The mechanism is COMPOSITIONAL, not a rescoring. No prospect scores differently than it
would have yesterday. A 5-20 firm scored 20 headcount points before and scores 20 now.
What changed is that the 21-50 firms, which scored 10, are no longer in the population
at all. Removing a systematically lower-scoring subpopulation raises the SHARE of
tier_1 while lowering the ABSOLUTE count of every tier, because 34 percent less is
sourced in total. Anyone reading absolute tier counts will see all three fall.

The effect on the mix is smaller than the 10-point gap suggests, and the arithmetic
says why. The score is industry (0/20/45) plus seniority (0/25/30/35) plus headcount
(0/5/10/20, unknown 10), against thresholds of 80 for tier_1 and 50 for tier_2. Only
eleven industry-plus-seniority bases are reachable: 0, 20, 25, 30, 35, 45, 50, 55, 70,
75, 80. For a 10-point headcount difference to cross the 80 threshold a base of 60 to
69 would be needed, and none exists, so **the tier_1 boundary never turns on headcount
at all**. The 50 threshold does turn on it, at bases 30 and 35 only: no industry match
plus a chief-executive or founder title. Those are the prospects that would have been
tier_3 at 21-50 and are tier_2 at 5-20.

So the honest prediction is a modest rise in the tier_1 share, driven by dropping a
population that skewed tier_3 in one narrow profile, not a step change across the
board. Prospects with unknown headcount score 10 either way and are unaffected, which
damps it further wherever Apollo's headcount coverage is thin.

Nothing was retuned to compensate, deliberately, for the same reason nothing else in
the filter was: this decision must stay reversible by one constant, and moving the
score thresholds to hold the old distribution would make reverting a multi-file change.

**Widening back is safe and cheap; widening in stages is not.** Changing the constant
to `'5,50'` restores the previous measured filter exactly. Introducing a SECOND range
(for example `['5,20', '21,50']` as separate tiers with different handling) is not a
constant change and must not be done as one: nothing downstream distinguishes tiers,
so both bands would land in the same undifferentiated pool and the tier distinction
would exist only in the ICP document. That is the spec-driven work, not a shortcut
into it.

**The divergence log now fires on every run**, in the same change. It previously fired
only when the stored spec named a country outside US/GB/IE. ADR-032 moved the spec
defaults to `['GB', 'IE', 'US']` for good reasons, and the side effect was that the
condition became false for every correctly-configured client. So the specs most likely
to be wrong produced no log at all, and a run discarding headcount, industries,
keywords, titles, seniorities and revenue was indistinguishable in the logs from a run
with nothing to report.

That is the shape CLAUDE.md keeps returning to: a check that runs, reports nothing, and
cannot see the class it was written to find. The absence of a line read as "no
divergence" when it meant "the one divergence I test for is absent". The log now emits
once per sourcing run and names which spec fields were ignored, derived from
`supported_fields` rather than hand-listed beside it so the two cannot drift.

Cost accepted: one INFO line per sourcing run, always. That is the point. A report that
only speaks up when the problem is already obvious is not a report.

### Alternatives rejected

**Leave the filter at 5-50 and post-filter results down to 20.** Rejected. It pays
Apollo pagination for rows that are then discarded, and post-filtering happens in
`execute()` where the two existing post-filters are exclusions applied to results. It
would also make `total_entries` stop describing the sourced population, which is the
number every measurement in ADR-032 is expressed in.

**Build the spec-driven query now, since the ICP has outgrown one filter.** Rejected
for timing, not for merit. It is the correct end state and it is what supersedes
ADR-032. Doing it inside a ramp change would mean reinstating the ISO-3166 location
table, the seniority map and the manifest check as a real gate, all at once, against
the live sourcing path. That is its own change with its own verification.

**Say nothing about tier_2 and just narrow the constant.** Rejected. A band declared in
a client-facing strategy document and silently absent from every sourcing run is
exactly the kind of gap that gets rediscovered as a defect six weeks later.

**Revisit when:** client two needs a different filter, or tier_2 needs to be sourced.
Either one is the trigger for spec-driven sourcing, and at that point ADR-032's
recovery instructions (the location table and seniority map at `bc05658`) apply, and
the manifest check must be reinstated as a real gate in the same change.

---

## ADR-037: A tiering verdict is frozen on the row, and ONLY a new ICP filter spec thaws it

**Date:** 2026-08-27
**Status:** Accepted. This is ADR-034's missing third layer, built for one rule.
**Supersedes:** nothing.

### The problem this solves

`tierEnrichedBatch` selected `enrichment_status = 'enriched' AND sourced_tier IS NULL`.

`sourced_tier IS NULL` is not "not yet tiered". It is ALSO every prospect a disqualifier
removed, because a removed prospect keeps a NULL tier forever: nothing in the codebase
ever sets `sourced_tier` for one. So every tiering run re-fetched every prospect it had
already rejected, re-classified it, and rewrote the identical reason.

That costs no money. `classifyTier` makes no API call. What it costs is the BATCH CAP.

At roughly 1,730 prospects a month with removals accumulating, a client reaches the point
where the cap is filled entirely by rows that were already decided, and tiering stops
reaching newly enriched prospects. **Silently**, because the run still reports
"completed, N classified". The number is true. They are N of the wrong prospects.

This bites during the ramp, not at client one. At current volume (one client, 31 enriched
prospects, 1 stuck removal) it is invisible.

### The decision

**Exclude by STATE, not by timestamp.** `tierEnrichedBatch` now also filters
`.is('tiering_reason', null)`.

`tiering_reason` is the discriminator because `classifyTier` writes one on EVERY path,
survivors included, and nothing else writes that column except the two operator re-tier
routes, which set a tier at the same time.

**Why not a timestamp.** `updated_at` is unusable: a `prospects_set_updated_at` trigger
fires `BEFORE UPDATE` on every row change, so a verification write, a research link or a
suppression all move it. It cannot answer "when was this tiered". A new `tiered_at`
column would work, but it would be queried as `WHERE tiered_at IS NULL`, which is a state
test wearing a timestamp's clothes, and any "re-tier anything older than N days" rule
would be a threshold nobody has measured. Same objection as the deliberate absence of a
minimum batch size on the returned-industry assertion (ADR-036 neighbourhood, see
`docs/sourcing-specification-gates.md`).

**Why not a new terminal state** such as `sourced_tier = 'removed'`. It is clearer, and it
costs a migration plus every reader of `sourced_tier IS NULL` — three in application code
and two in the operator UI. Same effect, larger blast radius, and it would have broken
the industry-tag-mapping re-tier route, which finds its candidates by that exact
predicate.

### The consequence, which is not free

**This freezes a removal verdict.** ADR-034 named this shape: a predicate evaluated once
and stored is not a rule, and editing the rule changes nothing that already exists.
Before this change every tiering run accidentally re-evaluated removals. That was the
waste, and it was also the only re-evaluation mechanism the system had.

So the filter must never ship alone, not even briefly.

### The third layer

**A new ICP filter spec is the rule changing.** `persistIcpFilterSpec` therefore clears
`tiering_reason` for that organisation's prospects where `sourced_tier IS NULL` and a
reason is present, putting them back in the queue to be decided against the spec that is
actually in force.

Scope is deliberately narrow:

- **This organisation only.** No cross-client write.
- **Removed rows only.** A survivor keeps its tier. Re-tiering something already published
  to a client is a different decision with different consequences, and is not this.
- **On spec persist only.** Not on a cron, not on a timer.

**Removals are re-queued by this and by nothing else.** That sentence is the reason this
ADR exists. The next person to wonder why a removed prospect never changes needs to find
it here rather than derive it from two files.

### It is loud on purpose

A non-zero re-queue logs at `warn` with the organisation and the count. It costs no API
spend at the moment it runs, but it commits the next tiering runs to real work, and each
re-tiered survivor goes on to cost research money downstream. At ramp volume one spec
change can re-queue four figures of rows. The operator should see that number when they
cause it, not infer it later from a bill.

Zero re-queued logs at `info`. A quiet path and a busy path must not look the same.

### What still has no re-evaluation path

- A prospect removed for `email_unverified` whose email later verifies. Nothing re-queues
  it. The verification path does not clear `tiering_reason`.
- A prospect removed for `company_too_large` whose headcount is later re-enriched smaller.
  Same.
- A change to the disqualifier CODE itself, such as adding a decision-maker title. That is
  a rule change with no spec change behind it, so nothing thaws.

All three are the ADR-034 shape again, one level down, and none is fixed here. They are in
BACKLOG. The honest statement is that this ADR closes the ICP-change case because that is
the one that will actually happen during the ramp, not because it is the only one.

### Revisit when

A second re-queue trigger is needed, or removals grow large enough that a full re-queue on
spec change is itself the expensive event. At that point the answer is probably a bounded
re-queue with an operator confirmation, not a threshold.

---

## ADR-039: A client-facing view runs as the caller, and the grant is the control

**Date:** 2026-08-27
**Status:** Accepted. Applied to production and verified live before this ADR was written.
**Supersedes:** nothing. It corrects a conclusion reached on 2026-08-26 in migration
20260826170000, which is left in place because its reasoning about the READ path was
right and is still worth reading.

**Number:** 039 assigned by Doug on 2026-08-27 because 035 is unmerged on
sourcing-filter, 036 exists on five branches, 037 is claimed by two, and 038 belongs to
operator-rejection-note. Whoever collides after this renumbers.

### The problem this solves

`client_organisation_view` was owner-executing (`security_invoker = false`). The Supabase
advisor raised it as an ERROR. It had already been examined once, on 2026-08-26, during
the work that closed the nine leaking `mon_*` views. That examination measured the READ
path, found the view self-scoped by `WHERE id = get_my_organisation_id()`, found
`get_my_organisation_id()` denies EXECUTE to anon, and left the view alone by decision.

**Every one of those findings was correct. The conclusion was still wrong.**

The view is auto-updatable (`information_schema.views.is_updatable = YES`), and `anon` and
`authenticated` both held the full Supabase default `arwdDxtm` grant on it. An
owner-executing auto-updatable view bypasses RLS on WRITE exactly as thoroughly as on
read. Measured as a real signed-in client, in a transaction forced to abort:

    baseline pipeline_unlocked = false
    SELECT via view        -> own org row (correct)
    UPDATE via view        -> SUCCEEDED, 1 row changed     <-- RLS bypassed
    UPDATE via base table  -> SUCCEEDED, 0 rows            <-- RLS holding, correctly

Same role, same target row, same transaction. `organisations` refuses the write because
`clients_read_own_organisation` is SELECT-only and no client UPDATE policy exists. The
view performs it because the view is not running as the client.

A client could therefore set `pipeline_unlocked` on their own organisation, which is the
operator-controlled phased unlock, and rewrite `name`, `slug`, `contract_start_date` and
`meetings_count`. Bounded to their OWN organisation by the WHERE clause, so this was
escalation within one tenant and never cross-tenant leakage. No evidence it was ever
exercised: `updated_at` on the probed row still read 2026-08-21 afterwards.

### The decision

**A client-facing view runs as the CALLER, and its grant is narrowed to what it is for.**

1. `security_invoker = true` on every view any client role can reach, so RLS on the base
   tables is consulted as a real second gate rather than assumed to be one.
2. The GRANT is the control, not the WHERE clause. A view's predicate constrains WHICH
   rows; only the grant constrains WHAT OPERATIONS. A read-only view gets SELECT and
   nothing else.
3. Owner-executing views are permitted only on service-role-only paths where RLS is
   deliberately not the gate, and those still get their grants read back per role, in
   both directions, in the migration that creates them.
4. Changes go via `ALTER VIEW`, never `DROP` + `CREATE`. A drop loses the ACL, and
   Supabase's `ALTER DEFAULT PRIVILEGES` on the public schema re-grants `anon` and
   `authenticated` the full set by name at creation time. That default is how the write
   grant arrived here, and a drop would silently reinstate it.

Applied in 20260827220000. End state, read back live:

    security_invoker = true
    relacl {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres}

and re-tested by SET ROLE rather than inferred from the grant table: anon denied 42501,
client reads its own row unchanged, client write blocked 42501, operator reads its own
row unchanged.

### Why not the alternatives

**Leave it and rely on the WHERE clause.** That is what 2026-08-26 chose, on evidence
that only covered reads. The predicate does bound the blast radius to one organisation,
which is why this was escalation and not a breach. It does not make a write path
read-only.

**Revoke the write grant and leave it owner-executing.** Closes this instance and leaves
the class open. The next person adding a client-safe column re-runs `CREATE OR REPLACE`,
or drops and recreates, and inherits the defaults again with no second gate underneath.

**Switch to SECURITY INVOKER but keep the full grant.** Would have been enough here,
because RLS on `organisations` has no client UPDATE policy, so writes match zero rows. It
makes the safety of the view depend entirely on the absence of a policy on a different
table. Adding a legitimate client UPDATE policy to `organisations` later would silently
re-open the write path through the view. Two gates, not one.

### What this does NOT fix

**The audit that missed it.** The corrected view audit in CLAUDE.md, written on
2026-08-26, selects `has_table_privilege(..., 'SELECT')` and nothing else. It asks who can
READ. `client_organisation_view` appeared in its output and was reasoned past. An audit
that cannot see the class it was written to find reports zero rows reassuringly forever,
and this is the third time that exact shape has cost real time on this build, after the
`relkind = 'r'` filter and the monitor-sweep parallel arrays.

The audit needs write privileges added AND needs to live in a monitor rather than a
markdown file, for the same reason the commit gate was made executable on 2026-08-27: a
control that runs only when someone remembers it is not a control. Both in BACKLOG, not
done here because CLAUDE.md is the one file every parallel session reads.

**The baseline generator.** `scripts/regen-schema-baseline.ts` matches `security_invoker`
by PRESENCE (`LIKE 'security_invoker=%'`) and then hardcodes `= true`, so it wrote
`WITH (security_invoker = true)` into the tracked baseline for a view that was false, on
the exact property the advisor was raising an ERROR about. This ADR's change makes that
row true and the discrepancy self-heals, which is worse rather than better: the generator
bug survives, invisible, until the next view is created false. In BACKLOG.

**Documentation that asserted the opposite.** `docs/data-model.md` stated the client
SELECT policy on `organisations` "was dropped", and used that to justify the view running
as its owner. Live `pg_policies` says the policy exists. Anyone reasoning from the doc
would conclude this change must break every client read. Corrected against a live read,
and it is the reason the standing rule is to query `pg_policies` rather than grep the
migrations.

### Revisit when

A client-facing view is genuinely needed that must read something the caller's own RLS
cannot reach. That is a real case, and the answer then is a SECURITY DEFINER function with
EXECUTE granted to exactly one role and the privilege read back in both directions, not an
owner-executing view with a permissive grant.
## ADR-038: An operator's rejection note is an instruction to the next run, not an audit record

**Date:** 2026-08-27
**Status:** Accepted

### The defect

Measured live on 27 August, organisation `0ed34697-0fa9-4f08-ac15-d3504ac45caf`:

    20:54:21  an ICP suggestion was created
    20:57:02  an operator rejected it with a note instructing removal of Canada,
              Australia and Western Europe from the geography in all three tiers.
              The note was stored in document_suggestions.rejection_reason.
              revision_note was NULL.
    20:59:15  a new ICP suggestion was created. Its suggestion_reason said the
              existing document was used as context and mentioned no note. The
              regenerated document still named all three regions.

Two controls accept a free-text note, two columns store one, and only one was read again:

| Control | Column written | Reached an agent before this ADR |
|---|---|---|
| Client "Request changes" | `revision_note` | yes, `runDocumentRevisionAgent` |
| Operator "Reject and regenerate" | `rejection_reason` | no |

`/api/suggestions/regenerate` persisted `rejection_reason` on the row it rejected and
then called the generation agent with `{ organisation_id, supabase, is_refresh }`. There
was no parameter for a note to travel in. Nothing logged, warned or displayed that the
instruction had been dropped, and the regenerated suggestion's reasoning line asserted
only that the existing document had been used as context, which was true and beside the
point.

### Decision

A note attached to a rejected suggestion is carried into the run that replaces it.

One shared module, `src/lib/agents/regeneration-notes.ts`, owns both the prompt block and
the sentence appended to `suggestion_reason`. All four generation agents accept
`regeneration_notes` and call the same two builders. The route passes them.

**Both notes travel when both exist, and the rejection note wins on conflict.** They are
not competing instructions for the same thing. The client note is the REQUEST ("mention
the onboarding guarantee in email two"); the operator note is the CORRECTION to the
attempt that answered it ("email two is now longer than email one"). Dropping the client
note loses the reason the document was being changed at all, which is this same defect one
level up. Dropping the operator note is the defect itself. Where they genuinely conflict
the operator note wins, because it is the later judgement and it was made against the
version that was actually produced.

`suggestion_reason` now names the note that was supplied. Without that an operator cannot
tell a regeneration that honoured the note from one that ignored it, which is the half of
the defect that hid the other half.

### What was deliberately not built

**The rejected document itself is still not shown to the agent.** The generation agents
refresh from the live approved document in `strategy_documents`, not from the
`suggested_value` that was just rejected. So the note reads as "the geography is too
broad", not as "here is what you produced and here is what is wrong with it". This is
enough for the measured case and for any note that describes the target rather than the
diff. It is not enough for a note like "the second paragraph contradicts the third".

**A plain rejection with no regeneration still goes nowhere.** `POST
/api/suggestions/[id]/reject` records the note and stops, which is correct: there is no
run to carry it into. But an operator who rejects with a note, and later regenerates
through the no-`suggestion_id` path, gets no note. Reading the most recent rejected
suggestion's note back would be guessing at intent across an unbounded time gap, so it
was not built.

**Direct agent triggers bypass notes entirely.** `/api/agents/{icp,positioning,tov,
messaging}` call the agents without a suggestion in the picture.

### Consequences

- Adding a fifth generation agent means wiring `regeneration_notes` or failing
  `src/agents/__tests__/regeneration-notes-wiring.test.ts`.
- A regenerated document that ignores a note is now a model failure, visible in the
  reasoning line, rather than a silent plumbing failure.
- The block is empty when there is no note, so a first generation, or a refresh with no
  rejection behind it, produces a prompt byte-identical to the one before this change.
  (These four agents do not use prompt caching, so there is no cache prefix to preserve;
  the point is only that unrelated runs are untouched.)

### The optional parameter that reopened the hole one level down

The first version of this change shipped with the defect it was fixing, in miniature.
`positioning` and `tov` called `buildRegenerationNotesReason(params.regeneration_notes)`
inside `writeDocumentSuggestion`, and their call sites never passed `regeneration_notes`.
The value was `undefined`, the reason sentence was silently empty, and the note still
reached the prompt, so the visible half worked and the receipt half did not. `tsc` said
nothing because the parameter was optional. The wiring test said nothing because it
checked that the builder was CALLED, not that a value was THREADED to it.

Caught while verifying a rebase, not by any check that was written for it.

The fix is structural rather than another assertion. Internal parameter types now declare
`regeneration_notes: RegenerationNotes | undefined` instead of `regeneration_notes?:`, so
an object literal that omits the field is a compile error. Reintroducing the bug now
produces `TS2345` at the call site. The PUBLIC agent inputs (`IcpAgentInput` and friends)
stay optional on purpose, because external callers legitimately omit the field; it is only
the plumbing between an agent's own functions that is required.

This is the same lesson as the `as Record<JobType, JobTypeResult>` cast in CLAUDE.md: the
dangerous place for `?` is exactly where a required type was about to do useful work.

### The shape this belongs to

CLAUDE.md already documents "validating one thing and returning another" and "a producer
and a consumer that are each correct and disagree". This is a third variant: **a value
that is correctly captured, correctly persisted, and never read.** The write side has a
test, the column has a value, the UI has a control, and the only missing piece is the one
nobody can see. The general guard is the one applied here: when a control captures an
instruction, something downstream must either act on it or say out loud that it did not.

## ADR-040: Intake is evidence, and checkability is the line between reasoning and invention

**Date:** 2026-08-27
**Status:** Accepted. Applied to all four document generation agents and merged the same day.

**Number:** 040 assigned after surveying every ref rather than main alone. Numbers collided
three times on 2026-08-27, so the check was: 001 to 039 are taken across the union of all
local branches, all remote branches, all commit messages and the other live session's
working tree. 035 sits unmerged on sourcing-filter and is being cherry-picked, 038 belongs
to operator-rejection-note, 039 was assigned by Doug. 040 was free everywhere.

### The problem this solves

The four document generation agents treated intake as authoritative. That is wrong in both
directions at once, and the two failures look nothing alike.

**Treating intake as a ceiling.** Intake answers come from a person filling in a form,
often at the end of a working day. They are biased, incomplete, occasionally wrong, and
usually thin on how the buyer experiences the problem. Nothing told the agents they were
allowed to reason past a thin answer, so a two-word answer about buyer pain produced a
two-word-deep document. A client answering one question badly could point their outbound at
the wrong people.

**Treating a gap as something to fill.** The opposite failure, in the same agents. A
required schema field with no basis in intake was emitted as prose inside a client-visible
field: the literal string "Unknown: not established in intake" followed by a question. An
operator who approves without reading it ships it. On 27 August a geography naming four
excluded markets and a revenue band arithmetically impossible against its own headcount
both reached a live document exactly that way.

**And a third, underneath both.** Rule 5's ban list did not only illustrate with consulting
language, it PRESCRIBED it. Thirteen instructions across five files told the agent to reach
for "referral ceiling", "revenue swings month to month" or "pipeline resets to zero when a
client ends" whenever it wanted to name recurring revenue pressure. A school catering
supplier does not have a referral ceiling. This contradicted the industry-agnosticism
principle in CLAUDE.md from inside the prompts that principle governs.

### The decision

**Checkability is the line.** A fact a reader could verify outside the client's own
materials must be sourced or omitted. A characterisation of how a buyer experiences their
situation must be reasoned about, and thin input is a reason to reason harder rather than a
reason to write nothing.

Three rules implement it.

**1. Intake is evidence, not a ceiling (new Rule 10).** Where the client's own words are
strong and specific, use them. Where an answer is thin, vague, internally inconsistent, or
clearly answers a different question, reason past it from the buyer's role, industry, size
and situation, from the upstream documents, and from research where it exists. The boundary
with Rule 9 is stated in the rule itself, because a model given both without the boundary
will get confused: VERIFIABLE FACTS may never be invented, CHARACTERISATION may be reasoned
about.

**2. Pain language is derived, never selected.** No fixed vocabulary, and no replacement
list. Different clients sell to different buyers with different pain, so any fixed
vocabulary is wrong for someone. The bans on "revenue rollercoaster" and on repeated
"feast-or-famine" survive; only the "use X instead" half is deleted.

**3. A fact that cannot be established becomes `unresolved_fields`, not a guess.** A
required array on the ICP output schema. Each entry carries the field path, why intake could
not settle it, and the single question that would. It renders as a banner at the top of the
approval card, above the document, so it cannot be approved past without being seen.

Rule 9 becomes one canonical prohibition-only rule, absorbing 9a, and lives in the shared
spec rather than in four divergent copies.

### The disclosure half of Rule 9 is deleted, not promoted

Rule 9 previously permitted an unsourced fact provided it was footnoted in an "Assumptions
we have made" section. Measured before deleting it:

  - No key for it in the ICP output schema, and the schema says "no text before or after
    the JSON", so the markdown section the rule asked for was uninstructable.
  - One machine consumer, `extractAssumptionsFromDocument` in
    messaging-generation-agent.ts, which regexes that section out of
    `strategy_documents.plain_text`.
  - `plain_text` is never written. Nothing in the repo assigns it. Live check across all
    50 `strategy_documents` rows: NULL in every one. So that consumer has always
    returned `[]`.

**CORRECTION, 2026-08-27, found by an adversarial re-check of this ADR before merge and
recorded rather than quietly edited.** An earlier draft of this section said "full
compliance surfaced nothing to anyone" and that deleting the rule "changes no behaviour".
**Both were wrong**, and the error was a too-narrow query: the check used
`content ? 'assumptions'`, and the key the agent actually emits is
`assumptions_we_have_made`. Corrected census:

    content ? 'assumptions'              -> 0     (what was checked)
    content ? 'assumptions_we_have_made' -> 1     (what exists)

The ICP agent did not write the markdown section. It emitted a top-level JSON key instead,
in 1 of 15 ICP documents, and `renderUnknownFields` on the approval card renders any key
not in `handledKeys`. So the disclosure DID reach the operator, by a different route than
the rule described. What is dead is the plain_text route and its messaging-agent consumer.

The row is `a8d35c94-b1a6-429e-99fd-119fb481c6cb`, org **360 Bia Og**, ICP v2, status
active, client_approval_status approved. It carries six assumptions naming An Taisce, the
Department of Social Protection, safefood and the HSE. **Those are exactly the externally
verifiable named bodies the NEW Rule 9 bans**, which is the argument for the new rule
rather than against it: the old rule permitted the agent to state them provided it
footnoted them.

This is also the frozen-verdict shape from CLAUDE.md. Editing a prompt does not touch a row
already generated, so that document keeps its assumptions until it is regenerated. Logged in
BACKLOG as a decision to take, not a silent leftover.

### A deliberate exception to ADR-028

ADR-028 says code validators are hard gates and prompt instructions are advisory. The
revenue-against-headcount coherence check stays **prompt-only**, with failure routed into
`unresolved_fields`. This is a knowing exception, agreed explicitly with Doug.

The reason is that every code gate for this check needs a revenue-per-head prior, and any
fixed ratio is industry-specific. Roughly 100K to 150K billed per consulting head is the
figure that would have caught the 27 August case, and it is wrong for a school-meals
company or a distributor. Hardcoding it would have put an industry assumption into a
validator in the same change that removed industry assumptions from the prompts. A test
asserts no such ratio appears in the prompt, so the exception cannot quietly become a
hardcoded assumption later.

**Stated plainly for the record:** this rule already existed in two places before this
change, in Rule 9a and in the ICP data-quality section, and it failed anyway. The prompt
instruction is the control that already did not hold. **The banner is the new control, not
the rule.** Last time the failure was invisible; now an operator cannot approve past it
without seeing it. If a wrong revenue band reaches a live document again, prompt wording is
not the fix to reach for. What would make it a hard gate is a per-client revenue-per-head
expectation captured at intake, which would make the check arithmetic rather than assumed.
That is not built.

### The shared spec is canonical in substance, not byte-for-byte

`docs/prompts/*.md` ARE the runtime system prompts. `loadSystemPrompt()` reads them from
disk at call time. Editing them is editing production behaviour.

`shared-voice-spec.md` claimed its content was "EMBEDDED VERBATIM" in all four. That was
false and had been for some time. Five differences were measured: heading level, no `---`
separators in the prompts, no em dashes in the prompts where the spec has six, a shorter
Rule 7 example, and messaging's local Understandability rule.

**A re-sync carries SUBSTANCE, not bytes.** Following the sync rule literally would have
injected five em dashes into four runtime prompts that ban em dashes and run
`assertNoDashes` on their own output. That is a regression wearing the costume of
compliance. The spec header now records all five divergences so the next re-sync preserves
them. Rules 1 to 10 are hash-identical across the four prompts, verified by hash rather
than by eye.

### Consequences

- Thin intake now produces a reasoned document rather than a thin one, within a stated
  boundary that no invented figure may cross.
- No agent anywhere is told to reach for a named pain phrase. The only surviving mention of
  "referral ceiling" in the repo is in the derivation rule, as the counter-example.
- The ICP agent has a structured channel for an honest gap, and the operator sees it before
  the approve button rather than inside the document.
- `unresolved_fields` is ICP-only. The other three agents still have no structured way to
  report a field they could not ground. The renderer reads the key off any document type,
  so extending it is schema plus prompt work per agent with no renderer change.
- Roughly 40 lines of now-provably-dead assumptions-extraction code remain in
  messaging-generation-agent.ts. Logged in BACKLOG for deliberate deletion rather than left
  to be rediscovered.

### Rejected alternatives

**Promote one of the four existing Rule 9 versions.** Rejected: the disclosure half is dead
in every version, so promoting any of them would carry the dead half forward and make it
look ratified.

**Keep a replacement vocabulary, just a better one.** Rejected, and this was the settled
decision rather than an open question. There is no correct replacement list, because the
list is wrong for whichever client it was not written for.

**A code validator for revenue against headcount.** Rejected on industry-agnosticism
grounds, as above. This is the ADR-028 exception.

**Leave the Rule 3 worked example alone as out of scope.** Rejected by Doug. It taught
specificity by demonstrating it with invented revenue figures, which is the exact
fabrication Rule 9a forbids in the same prompt. A model shown a good example reproduces its
content and not only its structure, and every stylistic tic in this codebase has traced back
to a worked example being copied verbatim.

---

## ADR-041: A privilege audit belongs in a monitor, and "intended" means a second gate exists

**Date:** 2026-08-27
**Status:** Accepted. Applied to production and verified live before this ADR was written.
**Number:** 041 assigned after surveying EVERY ref rather than main alone. 040 is taken by
docgen-intake-rules, which merged first; 035 existed only on sourcing-filter until this
session cherry-picked it. Seventeen refs were checked: 041 is free on all of them.
**Relates to:** ADR-039, whose "What this does NOT fix" section named both halves of this.

### The problem this solves

CLAUDE.md has carried a privilege audit query since 2026-08-25. It has now been wrong twice,
in two different ways, and each time the wrongness was invisible because the query returned
a reassuring answer.

    version 1   filtered relkind = 'r', so it had NEVER LOOKED AT A VIEW, and returned zero
                rows for as long as it existed
    version 2   read a single privilege, SELECT, so it asked who could READ and never asked
                who could WRITE

Version 2 is why `client_organisation_view` survived the 2026-08-26 review. It appeared in
the audit output, its read path was measured correctly, and it was cleared. It was
auto-updatable, owner-executing, and both public roles held the full `arwdDxtm` default, so
a signed-in client could UPDATE their own organisation row through it, `pipeline_unlocked`
included. ADR-039 measured that write succeeding.

Three instances of one shape now: the `relkind` filter, the monitor sweep's parallel arrays,
and a privilege list with seven omissions. **When the check is the thing that is wrong,
nothing downstream of it can notice.**

### The decision, part one: the audit runs without being remembered

The corrected query stays in CLAUDE.md, because that is what you run when you want the full
list rather than a verdict. But a query in a markdown file is not a control. Both misses
above happened while that section already existed and was being followed.

`mon_024` reads all eight table privileges for `anon` and `authenticated` across every table,
view and materialised view in `public`, on every monitor sweep. Same reasoning that turned
the commit gate from prose into a hook earlier the same day.

### The decision, part two: what "intended" means

Supabase runs `ALTER DEFAULT PRIVILEGES` on the public schema granting the full set to both
public roles, so every relation in `public` starts life granted to both, by name. A monitor
that treats that default as a fault is red on 29 tables from birth, and a permanently red
monitor is one nobody reads. So the line is drawn at whether a SECOND GATE exists underneath
the grant:

    table, RLS on              intended. RLS is the gate, and the count is reported in the
                               detail line so the single-layer posture stays visible
    table, RLS off             PROBLEM. Nothing stands between the role and every row
    view, security_invoker     SELECT intended. RLS on the base tables applies to the caller
    view, security_invoker,    PROBLEM. ADR-039: the predicate constrains WHICH ROWS, only
      with a write grant       the grant constrains WHAT OPERATIONS
    owner-executing view       PROBLEM for any privilege. RLS is never consulted, so the
      or materialised view     grant is the whole of the protection

This is deliberately NOT an allowlist of relation names. An allowlist has to be edited by
the same person who just added the thing it was meant to catch.

### The decision, part three: nothing to evaluate is not OK

Every rule above has the form "no relation is in a bad state", and all of them pass
vacuously over an empty catalog. `mon_024` returns UNKNOWN when it finds no relations and
says why. OK means "I looked at 63 relations and they were fine", never "I looked at
nothing". This is the MON-019 lesson: a monitor that exists and is silent renders as
healthy.

### What it found, and the disagreement it settled

`client_prospects_view` gave `authenticated` INSERT, UPDATE, DELETE and TRUNCATE, and
`information_schema` reports the view `is_updatable = YES`. **Two sessions reached opposite
conclusions about that same object on the same day**, the other holding that the write
grants were intentional because of the `clients_update_own_prospect_review` policy.

That argument fails, and the failure is worth stating precisely: **the policy is on the
TABLE.** A policy on the table is what permits the client's direct write to the table, which
is the write the code actually performs. It says nothing about whether the VIEW needs a
grant. `security_invoker` means that IF someone wrote through the view the table's RLS would
still apply; it does not mean anyone does, and it does not make the grant load-bearing.

Settled five ways rather than by re-reading:

1. Every client approve and reject path writes `.from('prospects')`. The two live buttons
   reach `/api/dashboard/client/prospects/reject` and `/approve-all`, both service-role.
2. The view name appears in exactly ONE `.from()` call in the repository, a SELECT in a test.
3. The compiled browser bundle contains one `.from()` call in total, a read of
   `integrations_registry`, and no write to any relation.
4. The live catalog has no rewrite rules, no INSTEAD OF triggers on any view, and no function
   or cron command naming the view. Each probe run with a non-vacuous control.
5. **Measured, not inferred.** As a real client (`SET LOCAL request.jwt.claims`, `SET LOCAL
   ROLE authenticated`), inside `BEGIN ... ROLLBACK`, with the old grant RESTORED for the
   test: `UPDATE client_prospects_view ... ` wrote **zero rows**. `security_invoker` means the
   caller's RLS applies, and `clients_read_own_prospects_denied` is `USING (false)`, so the
   client cannot see the row to update it. The grant was never load-bearing.

There is also a structural reason it could not have been used by accident: the three
client-facing routes that run as `authenticated` write `suppressed_at`,
`suppression_reason` and `sourcing_review_status`, and the view does not have those columns.

**The residual risk, which is real and now guarded.** Supabase generates Insert and Update
types for an auto-updatable view, so `.from('client_prospects_view').update(...)`
type-checks cleanly and would fail only at runtime in production. A test now fails on any
write chained onto that view, and it guards itself against scanning nothing.

### Why not the alternatives

**Keep the audit in CLAUDE.md and be more careful.** That is what was in place for both
misses. Every session reads that file, and both misses were made by sessions that had.

**Make the monitor enforce the strict posture: anon holds nothing anywhere.** Correct as an
end state, and measurement supports it: not one RLS policy in this database is addressed to
`anon`, so every anon grant is dead weight. But it is a 29-table change on a live database
and it would land the monitor red on day one. Recorded in BACKLOG with the evidence, to be
done in its own session with a per-table read-back, and the monitor tightened in the same
commit.

**Encode intent as a baseline table of accepted grants.** A drift detector rather than a rule
engine. Rejected because the baseline row and the grant are two lists that must agree, which
is the failure this codebase keeps having, and because a person adding a bad grant would be
the same person adding its baseline row.

## ADR-042: Rule 9 narrows to checkability, and the flag is a gate rather than a label

**Date:** 2026-08-28
**Status:** Accepted. Narrows ADR-040, which is one day old.

**Number:** 042 chosen after surveying every ref. 041 was taken on main by the privilege
audit ADR while this work was in progress, which is the fourth number collision in two days.

### What was wrong with the rule shipped yesterday

ADR-040 made Rule 9 a flat prohibition: any externally verifiable fact not supplied in this
message must be left out. That was right about invention and wrong about a whole category
of true, useful, checkable statement.

The evidence was one live document. Its ICP named several public bodies and a public funding
programme that genuinely govern its buyer's market. The model flagged every one of them,
exactly as the rule of the day asked. The rule worked. The CHANNEL was dead: the disclosure
was written into a section nothing renders, so it was correct and invisible. ADR-040 deleted
the disclosure half on the grounds that it surfaced nothing, which was true of the channel
and unfair to the rule.

An hour later the same session built `unresolved_fields`, which surfaces as a banner above
the document that an operator cannot approve past. That is the working channel the old rule
never had.

### The decision: draw the line at checkability, not provenance

**Tier One, never stated.** If a reader trying to verify the claim would find nothing, it
does not go in the document, and there is no flag for it. Company names, people, statistics,
percentages, market sizes, currency amounts, headcounts, client results, and any figure,
date or threshold attached to a third party. Also, and this is the part that is easy to
miss: **this client's own standing** under anything in Tier Two. Whether they hold it,
qualify for it, comply with it or are funded by it is a fact about them, and it is
unverifiable from general knowledge.

**Tier Two, stated only if the document needs it, and flagged.** Public bodies, regulators,
statutes, funding programmes, industry schemes, published standards, settled sector
conventions. What may be said is that the thing exists and what it does, in general terms.
Attach a number, a date, a threshold or an eligibility rule and it is Tier One again.

**Tier Two is closed to any agent whose output format has no flag channel.** Today that
means it is open to the ICP agent alone. For positioning, TOV and messaging, every Tier Two
item is Tier One. That is not a restriction on anything legitimate: a public body named in
intake, uploads, the website or research is SOURCED, and neither tier governs it.

Flagging uses a `kind` discriminator on the existing `unresolved_fields` array rather than a
second array, so there is one extractor, one renderer, one banner and one place for the two
to drift apart. Entries without `kind` mean `unestablished_field`, so nothing already
written breaks.

### The loophole, and how the rule text closes it

A tier that permits a flagged claim is a route to declaring something unverifiable and then
writing whatever you like. The rule text states the consequence so the model has a standing
reason to prefer sourcing:

> Every flag reaches the operator as a visible gap in the work, and reaches them before they
> can approve. One or two flags read as care. Ten read as a document where nothing was
> researched, and it comes back to be generated again.

with the order made explicit: source it, or omit it, or flag it, in that preference. And:
"A flag never widens what Tier One permits, and it never makes a Tier One item acceptable."

### The precondition: downstream agents see a projection, not the document

This narrowing could not ship on its own, because flagged content was not contained.

Measured 2026-08-28. `messaging-generation-agent.ts` and `positioning-generation-agent.ts`
both embedded the upstream ICP as `doc.plain_text ?? JSON.stringify(doc.content, null, 2)`.
`plain_text` is NULL on every row in production, so the stringify branch always ran and
every top-level key entered the prompt verbatim, with no allowlist and no key stripping.
A flagged claim is a review item in a document and an assertion of fact in an email sent to
a stranger under the client's name, and **no outbound gate catches one**: measured against
the real validators, `findFirmographicFigures` returns `[]` for a sentence naming a
government department and a compliance deadline, and `scrubAITells` leaves it untouched.

So `projectIcpForDownstream` narrows the ICP to five content keys before it reaches any
document-writing prompt. **Allowlist, not denylist**, because a denylist is a second list
kept in step by hand and a new operator-facing key would leak until someone remembered it.
The `project` parameter is REQUIRED rather than optional: omitting it at a call site is a
compile error. That was found by mutation, after the first version made it optional and
deleting the argument left the whole suite green.

The two paths that actually reach a prospect's inbox were already safe and are the pattern
this follows: `research/synthesize.ts` and composition's `extractPainFromIcp` both read
named fields and never stringify a document.

### THE ASSUMPTION THIS RESTS ON, STATED PLAINLY

**A Tier Two claim written into `tier_1` prose survives the projection.** The projection
strips `unresolved_fields` and keeps the tiers, which is what it is for. So the CLAIM
propagates into the messaging prompt while its FLAG does not.

That is coherent rather than a hole, and the reason is worth stating rather than assuming:
**operator approval is the verification step.** A flagged claim that reaches an approved
document has been read by a human, taken to the client on the onboarding call, and either
confirmed or removed. Everything downstream of approval is entitled to treat the document as
checked, which is why the flag does not need to travel with the claim.

**It holds only if the operator actually verifies rather than clicking approve.** The banner
is not a warning label on a shipped document. It is a gate, and the whole design rests on
somebody reading it. If approvals become routine, this ADR's reasoning fails silently: the
claims still propagate, the flags still do not, and nothing in the system will say so.

The mitigations that exist are that the banner is the first thing in the card body, above
the document, and that a document carrying many flags is visibly one nobody researched.
Neither is a control. Both are prompts to a human.

### Consequences

- The ICP agent can state what genuinely governs a buyer's market instead of writing around
  it, and every such statement arrives at the operator as a question to settle.
- The messaging, positioning and TOV agents cannot introduce an unsourced third-party claim
  at all, and cannot inherit a flagged one from the ICP.
- Two independent defences, not one: the tier rule stops it originating in copy, and the
  projection stops it propagating into copy.
- The client does NOT see the flags. Deferred deliberately, see BACKLOG. The client is
  currently protected by renderer omission rather than by any filter, which is a trap and is
  logged as one.
- `unresolved_fields` remains ICP-only. Positioning, TOV and messaging have no gap channel
  and therefore no Tier Two.

### Rejected alternatives

**A second array for flagged claims.** Rejected: two extractors and two renderers that can
disagree, for no gain over a discriminator.

**Leaving the projection out and relying on the tier rule alone.** Rejected: the tier rule
governs what an agent WRITES, and the propagation problem is about what an agent READS. One
does not substitute for the other.

**A denylist of operator-facing keys.** Rejected: fails open. The allowlist fails closed and
the drift test makes an unclassified schema key a test failure rather than a silent
omission.

**Fixing the research queries instead.** Not rejected, deferred, and it is the better fix.
See BACKLOG: the queries that produced the flagged document were built from an off-question
intake answer and a currency-derived geography, so research was asked nonsense rather than
failing. Better queries reduce how often flagging is needed but never to zero, so the two
are complementary.

---

## ADR-045: The two document agents share one research-descriptor module, and the positioning agent gains the same skip path

**Date:** 2026-08-29
**Status:** Accepted.

NOTE ON NUMBERING: taken as 045 on branch positioning-research-queries off main c7d42c1.
See BACKLOG on ADR numbers racing across parallel branches.

**Context.**

ADR-044 fixed the ICP agent's research queries. The positioning agent builds its own and
was untouched from the start of the project, so for one day the same intake produced a
checked query in one document and raw narrative prose in the other. Measured against the
real intake of all five live organisations before the port, the positioning builder had
four defects:

1. Query 2 interpolated `clients_clone` RAW into a quoted-phrase search. All five
   organisations sent prose. One read:
   `When a problem becomes our problem, that's my aim. let me solve "looking for" OR
   "need help with" hot school lunches ...`
2. Geography from CURRENCY, the inference ADR-043 removed from the ICP agent for being the
   thing CLAUDE.md's geography rule forbids. Every EUR client searched "Europe", including
   an .ie client whose own domain says Ireland.
3. No skip path. With no service description it substituted the literal "B2B service
   providers" and searched anyway.
4. `service` fell back to `offer_deliverables`. FOUND WHILE MEASURING, not in the brief.
   That field is an OUTCOME in all five live answers, so one organisation's competitor
   query searched "A qualified meeting in the diary that flows into pipeline and drives".

**Decision.**

1. THE SHARED RULES MOVE TO `src/lib/agents/research-descriptors.ts`. Both agents import
   condense, usableDescriptor, recipientFromServiceDescription, resolveBuyerDescriptor,
   geographyFromIntake and q from one module.

   It is a lib module rather than an agent-to-agent import. An agent importing another
   agent is what CLAUDE.md's one-file-one-agent rule exists to stop, and it is also how
   circular imports get built, which pass tsc and vitest and fail only `npm run build`.

2. THE POSITIONING AGENT GAINS THE SAME SKIP PATH, keyed on the SERVICE descriptor rather
   than the buyer, because three of its four queries are about the client's own service.

3. `offer_deliverables` IS DELETED AS A FALLBACK, not relaxed. A field that answers a
   different question is not a fallback.

**Why this was a separate change and not part of ADR-044.**

The two builders are not the same shape. Three of four ICP queries are about the BUYER;
three of four positioning queries are about the CLIENT'S SERVICE, for which
`company_what_you_do` is correct and was never the bug. Only query 2 needed the buyer fix.
Folding it into ADR-044 would have hidden that asymmetry and skipped its own before-and-
after table.

**Two bugs the port surfaced, both the same shape as the original.**

Neither was visible until a second caller exercised the shared code with different inputs.
Both are cases of a rule that is correct for the field it was written against and wrong for
the next one:

- `condense` stripped a first-person opener using a FIXED VERB LIST. "We manufacture
  industrial fasteners" kept its "We", `usableDescriptor` rejected the pronoun opener, and
  the client got no research at all. A closed list of verbs can never be complete, and its
  incompleteness failed in the direction of losing research rather than of a worse query.
  There is now a general second pass that strips a first-person subject and its verb
  whatever the verb is.

- The three-word PROSE floor was applied to a parsed CATEGORY name and rejected "industrial
  fasteners". This is the second time that floor has been wrong in this exact way: ADR-044
  already hit it with the extracted buyer "B2B consultants". There are now two named
  constants, MIN_PROSE_WORDS and MIN_PHRASE_WORDS, and the floor is passed explicitly at
  every call site rather than defaulted, so the choice has to be made rather than inherited.

**Consequences.**

- All five live organisations now resolve the SAME buyer descriptor in both agents.
  Previously the two disagreed for four of the five.
- One organisation now skips positioning research where it previously sent four queries,
  one of which searched an outcome phrase and one of which searched narrative prose.
- Descriptors gain a trailing-function-word trim, so a hard cut at the word budget no
  longer ends "...on a contractual basis with".
- The divergent empty-intake contract in research-queries-agnostic.test.ts collapses back
  to one contract for both agents.

**Alternative rejected.**

IMPORT THE HELPERS FROM THE ICP AGENT DIRECTLY. Smaller diff, no new file. Rejected: it
makes one agent depend on another, which is the coupling the agent conventions forbid, and
it would have left the canonical home of a shared rule inside one of its two callers.

## ADR-044: The ICP research agent declines to search when intake names no buyer, and researches the service RECIPIENT rather than the service

**Date:** 2026-08-29
**Status:** Accepted.

NOTE ON NUMBERING: taken as 044 on branch research-query-builder off origin/main ef20336.
See BACKLOG on ADR numbers racing across parallel branches; renumber on merge if 044 is
taken by another branch first.

**Context.**

Every ICP generated over 2026-08-27/28 reported that web research returned nothing, and the
documents fell back to framework logic. Research had not failed. It was being asked
unanswerable questions.

An earlier fix (ADR-043) stopped raw `clients_clone` prose reaching the provider by adding
`usableDescriptor`. It left the fallback in place: when the ideal-client answer was
rejected, the buyer descriptor became `company_what_you_do`, which describes the client's
SERVICE rather than the client's BUYER. Measured across all five live organisations, the
buyer-profile query read:

    "B2B consultants get more qualified meetings in their diary through cold email
     typical company size revenue headcount profile 2025"

That is a service description with research keywords appended, not a population. It also
left `clients_trigger` unchecked entirely, so all five organisations sent a second query
opening with narrative prose.

**Decision.**

1. THE BUYER IS THE RECIPIENT NAMED INSIDE THE SERVICE DESCRIPTION, NOT THE SERVICE
   DESCRIPTION. A service description names who it is for after a recipient marker: "to
   founder-led businesses", "into hospitals, care homes", "help B2B consultants". Extracting
   the complement of that marker is a grammatical rule and holds in any industry.
   Prepositions are tried before beneficiary verbs, and the phrase stops at a closed list of
   function words plus a heuristic list of generic predicate-opening verbs.

2. WHEN NOTHING NAMES A POPULATION, RESEARCH IS SKIPPED AND SAID TO BE SKIPPED. The agent
   sends nothing to the provider, and `suggestion_reason` says the intake did not supply a
   buyer descriptor. The prompt is told the same, and is instructed not to claim a search
   ran.

3. THE PROVENANCE OF THE DESCRIPTOR IS REPORTED WHEN IT IS NOT THE IDEAL-CLIENT FIELD.

**Why 2 is the load-bearing part.**

"Research ran and found nothing" and "research was skipped because intake never named a
buyer" are different facts about a document, and only the second is actionable. The first
reads as a provider problem and points the operator at nothing. Three generations were
reported the first way when the second was true.

This is the same shape as the failures already catalogued in CLAUDE.md: a check that runs,
reports a result, and was never actually applied to the thing it was protecting. A bad
query that returns nothing looks exactly like a good query about an obscure market.

**Consequences, including the ones that cost something.**

- One of the five live organisations now gets NO research where it previously got four
  queries and four empty results. That is a loss of nothing real and a gain of an
  explanation.
- Three of the five get a genuinely searchable population where they previously got a
  service description.
- ONE OF THE FIVE GETS A REAL POPULATION THAT IS THE WRONG ONE. 360 Bia Og delivers school
  meals to children and is paid by the state, so the recipient extractor returns "children
  in Ireland". Separating delivered-to from bought-by needs world knowledge, not grammar.
  The fallback is deliberately NOT made cleverer; it is made visible, via the provenance
  note in 3. The proper fix is an intake field, logged in BACKLOG and not built here
  because intake is write-once with no edit path, so a new field helps future clients and
  none of the five that exist.
- The positioning agent's own builder is UNCHANGED and still has the pre-ADR-043 defects.
  Logged in BACKLOG. The two builders are not the same shape: three of four ICP queries are
  about the buyer, where three of four positioning queries are about the client's own
  service, for which `company_what_you_do` is correct rather than a bug.

**VERIFIED LIVE 2026-08-29.** A real ICP generation against MargenticOS 74243c62, the
organisation that triggers the skip, confirmed all three surfaces: suggestion_reason states
SKIPPED, the model emitted the unresolved_fields banner entry on tier_1.buyer_profile, and
no sentence in the generated document claims research ran or returned nothing. Suggestion
93e09f5a. See BACKLOG "VERIFIED LIVE: THE CASE 3 SKIP PATH" for the one finding it turned
up, which is that `offer_structure` held a usable buyer descriptor the builder does not read.

**Alternatives rejected.**

- ASK THE CLIENT A NEW INTAKE QUESTION. Correct long-term and useless now: intake is
  write-once with no edit path, so it fixes nobody who already exists. Logged, not built.
- USE AN LLM TO EXTRACT THE BUYER. Would handle the school-meals case. Rejected under
  ADR-018: a grammatical rule covers four of five, and the fifth is made visible rather
  than guessed at. Revisit if the visible-note path proves noisy on real clients.
- KEEP SEARCHING WITH A GENERIC "B2B buyer" FALLBACK. This is what the old code did on
  empty intake. It returns plausible generic results that ground the ICP in nothing about
  this client, which is worse than an empty section, because it is not visible.

## ADR-043: ICP research geography comes from the client's own domain, and Rule 9B is the positive counterpart to Rule 9

**Date:** 2026-08-28
**Status:** Accepted.

**Number:** 043 claimed by surveying every local and remote ref, per the method in BACKLOG.
042 is the highest defined anywhere.

### What prompted this

An ICP regenerated on 2026-08-28 for the live school-meals client described the business
generically. The previous version had named the delivery mechanism, the waste model and a
product range of the client's own. Measured rather than assumed: the current suggestion
still carries the delivery mechanism and gains the founder's background, and has LOST the
named range and the waste model that the June version carried.

The material was not missing. Two pages, 6,000 characters, `fetch_status = complete`, sit
in `intake_website_pages` for that organisation and contain every one of those details.

### Finding one: the website content reaches the agent, and always did

`fetchWebsiteContext` in `src/lib/agents/website-context.ts` is called by the ICP agent at
`icp-generation-agent.ts:142`, and its output is interpolated at `buildUserMessage` as
`websiteBlock`, after the intake responses and the uploaded documents and before the
research block. There is no cap, no slice and no row limit on the read.

So the plumbing was never the cause, and the other two changes are not secondary to it.

There IS a truncation, but it is upstream and it is not what lost these details.
`MAX_CHARS_PER_PAGE = 3_000` in `src/lib/intake/fetch-website.ts:17` cuts each page at
ingest. Four of the eight stored pages sit at exactly 3,000 characters and end mid-word.
(Reported as three of seven in the first pass, which counted three organisations rather than
all five. Corrected against the full table when the backfill was verified live.)
Every detail named above is inside the stored window, so the cap did not remove them. It is
logged in BACKLOG rather than changed here, because changing it would need a re-fetch to
mean anything and the prompt budget it protects is real.

### Finding two: the research queries were the cause, and they were asked nonsense

Both causes were logged in BACKLOG on 2026-08-28 and are fixed here.

**Cause one, an emptiness check standing in for a quality check.** `const buyer =
cloneClient || whatYouDo` falls back only when the ideal-client answer is EMPTY. An answer
that is non-empty and does not answer the question asked became the buyer descriptor
verbatim, in three of the four queries.

This is not an edge case. Run against the real intake of all five organisations, FOUR of
the five `clients_clone` answers are prose about a relationship rather than a description
of a population, and the fifth is the only one that names a buyer.

`usableDescriptor` replaces the emptiness check with two category-level criteria and a
floor. Neither criterion names an industry, a buyer archetype or a service type.

  1. The descriptor must open with a noun phrase. A subject pronoun has no antecedent a
     search engine can resolve, and a subordinating conjunction opens a story rather than
     naming a population. Possessives are deliberately NOT rejected: "our clients are
     hospital procurement leads" opens with "our" and is a good descriptor.
  2. The descriptor must not carry a first-person singular marker. That means the answer
     turned into the respondent's own story.
  3. Below three words it carries no more than the generic fallback already does.

The failure is deliberately asymmetric. A false reject falls back to the service
description, which is still a real search term. A false accept sends narrative prose to a
search engine, the research comes back empty, and the document is written without it.

**Cause two, geography inferred from currency.** `geoHint` mapped EUR to "Europe", so a
single-country client inside a multi-country currency zone was searched against the whole
zone. On the school-meals client that put "Ireland" in the service description and "Europe"
in the same query string. CLAUDE.md's geography rule says currency alone is insufficient.
The document prompt obeys that rule; the query builder did the opposite and its own comment
said so.

Geography now comes from the ccTLD of the client's own website and from nothing else.
There is no country field in intake, and the domain is the only direct country evidence
that exists. The ccTLD map is an allowlist, so the country codes sold as vanity domains
(.io, .ai, .co, .me, .tv) yield no hint rather than a wrong one.

**The accepted trade-off, stated because it is a cost and not an oversight.** A generic TLD
now yields NO geographic hint, where currency previously supplied a confident wrong one.
Three of the five live organisations are on .com and lose their hint. A query with no
geography returns broader results; a query with the wrong geography returns results about
the wrong market and reads as though it worked. Broader beats wrong. The real fix is a
country field in intake, which is in BACKLOG.

**Proved rather than asserted.** `scripts/prove-research-queries.ts` runs the real builder
against the real intake of every organisation and prints before beside after. The "before"
column comes from `scripts/__before__research-queries.ts`, extracted mechanically from
origin/main rather than retyped. All twenty queries across five organisations change.

### Finding three: Rule 9 has no positive counterpart, and Rule 9B is it

Rule 9 is a prohibition on stating third-party facts that are not sourced. It says nothing
about the client's own facts. A model reading a long absolute ban immediately before
generating has no instruction pulling the other way, and the observed output is a specific
business described in general terms.

Rule 9B states that the client's own materials ARE sourced material and must be used
concretely: their own products, methods, mechanisms, named ranges, operational detail and
the founder's own background all come from intake, the uploads or their own website, so no
tier of Rule 9 governs them. The test is stated in the rule and repeated in the ICP quality
self-check: a reader who knows this market should be able to tell this client apart from a
competitor after reading the document.

It defers rather than widens on the one place the two rules touch. Where the client's own
material states their standing under a public body, a regulator, a scheme or a standard,
Rule 9 governs that sentence. Whether Rule 9 Tier One's ban on "this client's own standing"
is overridden by that standing appearing in the client's own website text is a genuine
ambiguity in the rule as written. It is logged in BACKLOG rather than resolved here,
because resolving it changes what Rule 9 permits and that is its own decision.

**Why 9B and not a new Rule 10.** Inserting a rule between 9 and 10 renumbers Rule 10 in
five files and Rule 11 in the messaging prompt, and touches roughly fourteen cross
references. 9B is adjacent to Rule 9, which is what makes the boundary visible, and it can
be synced to the other three prompts later without renumbering anything. The retired
lowercase "9a" was absorbed into Rule 9 because it was a duplicate PROHIBITION. 9B is the
opposite half, not a duplicate.

**Scope boundary, recorded as divergence 7 in the shared spec.** 9B is in
`shared-voice-spec.md` and `icp-agent.md` only. It is not yet in the positioning, TOV or
messaging prompts. That is a scope decision, not drift: this session was scoped to the ICP
path, and the messaging prompt feeds the send path, which another session was exercising.
A test asserts the two copies that DO exist are identical, so they cannot drift while the
other three wait.

---

## ADR-046: The buyer criterion is derived per client and applied before enrichment, and it is not the provider's seniority filter

**Date:** 2026-09-02
**Status:** Accepted.

NOTE ON NUMBERING: taken as 046 on branch seniority off main e7c7ea0.
See BACKLOG on ADR numbers racing across parallel branches.

**Context.**

`DECISION_MAKER_PATTERNS` was twelve job-title fragments in `tier-classification.ts`,
applied identically to every client. It is a Rule Zero violation that had been in
production since sourcing was built, and it stayed invisible for two reasons. The only
client generating volume is a consulting firm whose buyers those fragments describe, and
the one live client in a different market, an Irish school-meals business selling to
primary schools, passed it by a coincidental substring collision: `principal` is in the
list because of a consulting title, and it happens to also be an Irish school principal.
One uncommon title, a Board of Management member or a school bursar, and that client would
have been silently rejecting its own buyers.

The rule also ran AFTER enrichment. On the 100-prospect cohort of 2026-09-01, 14 of the 15
removals were `not_decision_maker`, every one already enriched at one credit each. The job
title it reads is written at sourcing time and is never touched by enrichment
(`field-ownership.ts` lists `job_title` as a sourced field), so all 14 credits were
avoidable using data that was already on the row.

**Decision.**

Three things, and the first is the one that is easy to get wrong.

**1. Search breadth and the buyer criterion are different questions.** `seniority_levels`,
and the provider filter it corresponds to, is what we ASK FOR. It stays deliberately wide,
because the provider derives seniority from job title and is coarse about it: narrowing it
to owner and founder measured 29,139 rows against 72,458, because in professional services
the owner is usually titled Partner. The buyer criterion is who we will actually EMAIL out
of that wide result. It is narrower and per client. **The gate does not read
`seniority_levels`, and nothing should ever make it.** Conflating them is how one list came
to serve two jobs and served neither.

**2. The criterion is derived from the client's own documents, and rides in the existing
spec.** `deriveBuyerCriterion` reads every ACTIVE strategy document plus intake, not the
ICP alone: an ICP describes a market, and the positioning document is what says which
problem the client solves and therefore who owns it. The result is stored as
`icp_filter_spec.buyer_criterion`, so it is approved with the ICP, regenerates with the
ICP, and is thawed by the same re-queue. No new document, no new approval step, no new
table, and no migration.

It produces two outputs, and the second is not optional. Machine-readable fragments the
gate matches, and a plain-English statement with evidence from the documents, written to
be read aloud on an onboarding call. The statement is how an operator validates a
judgement the system made on a client's behalf. A criterion nobody has read is a rule
nobody has agreed to.

**3. It is applied before enrichment, through one selector both paths call.** The two
enrichment paths held two copies of the same four eligibility predicates with a comment
asking the next person to keep them in step. They now call `selectEnrichmentEligible`. The
lock clause stays out of it: the inline path locks a column, the queue path uses the queue
as its lock, and giving one prospect two notions of "in progress" would let them disagree.

**Consequences, including the ones that cost something.**

A rejected prospect gets `tiering_reason` set and `sourced_tier` left NULL, which is the
shape every other rejection already has, so it appears in Removed and in
`removed_by_reason` under the same bucket. `enrichment_status` stays NULL, because nothing
was enriched and that column means we paid. That choice is what makes the ADR-037 thaw work
unchanged: clearing `tiering_reason` returns the row to enrichment eligibility as well as to
tiering, so there is no half-thaw that frees the reason and leaves the row unenrichable.

Two counts had to change to see these rows, and one of them revealed a defect. `countRow`
required `enrichment_status = 'enriched'` alongside the reason. That conjunct was never
part of what makes a row a removal; it was true of every removal only because every
disqualifier used to run after enrichment. It is dropped. The alternative, stamping
`enriched` on a prospect we never enriched, would have kept the line untouched at the cost
of lying in the column that means we paid, and would have fed rows with no email address to
verification, which selects on exactly that value. It also emerged that `removed_count` is
computed by a SECOND query rather than by `countRow`, contradicting that function's own
docstring, and the two had to be fixed together. Logged in BACKLOG.

**Everything fails OPEN, loudly.** No criterion, an unsettled one, one outside the sanity
band, or a read that throws: every prospect passes, a warning is returned to the operator
in the HTTP response, and Sentry is notified. Failing closed would stop a client's pipeline
with no error anyone would think to look for. The cost is real and is accepted: a client
with no criterion pays to enrich everyone, exactly as today.

**Unsettled is a correct outcome.** Where the documents do not establish who owns the
problem, who controls the spend, or who can convene the decision, the derivation says so
and does not gate. That becomes a question on the onboarding call, which is where an open
question belongs, rather than a judgement the model made quietly on thin evidence.

**The sanity band.** Measured against the client's own sourced titles at derivation time.
Fewer than 25 distinct titles and it reports itself unchecked rather than presenting noise
as a finding. Outside 5% to 95% acceptance the criterion is stored `out_of_band` and does
not gate. The band is deliberately wide: a legitimately narrow criterion against a wide
provider search accepts a small fraction, and a tighter band would fire on correct
derivations and teach the operator to ignore it.

**The seniority ladder loses a band.** `calculateSeniorityScore` re-listed the same
fragments inline and had already drifted from the constant it mirrored. Both now read the
one criterion, through a single evaluation per prospect. The old three bands (35/30/25)
become two ranks, primary 35 and secondary 25, because a client-derived list has no natural
middle. Measured on the cohort's 85 survivors: 3 move tier_2 to tier_3, tier_1 is unchanged
at 70. Existing rows are not re-tiered, so this only affects future classification.

**Rule Zero is enforced by a test, not by review.** The derivation is ABOUT job titles,
which makes its prompt the likeliest place in this codebase for a worked example to be
written, and a worked example there is reproduced verbatim for every client. The prompt
states the criterion at category level only: who owns the problem, who controls the spend,
who can convene the decision. `buyer-criterion-agent.test.ts` scans the prompt against a
banned list of title and industry vocabulary, derived in part from `CANONICAL_INDUSTRIES`
so a new sector is covered without anyone remembering. Both mutations were verified:
planting a worked example turns it red, and deleting the assertion turns it red too,
because a second test reads the file and fails if the scan is not in it. That guard builds
its own needle by concatenation, because written whole the literal satisfied its own search
and the first version passed with the real assertion removed.

**Model:** `claude-opus-4-6`. An LLM rather than deterministic code, per ADR-018, because
the input is prose and no rule engine reads a positioning document and answers who owns the
problem. Everything downstream is deterministic substring matching that makes no model call.

**Measured.** Against the 100-prospect cohort, the new gate rejects exactly 14 before
enrichment, the same 14, with zero differences in either direction. The first derivation
rejected 17: it emitted an abbreviation but not the written-out form of the same role, and
matching is literal, so three real buyers were wrongly rejected. The prompt now states that
matching is literal and requires both forms. That failure is worth recording because it is
the failure mode this design will keep having, and the sanity band would not have caught it.

---

## ADR-047 — Client approval on strategy documents is removed; versions are recoverable instead

**Date:** 2026-09-03
**Status:** Accepted

### The defect that forced the decision

`promote_strategy_doc_version` archived the client-approved document and inserted the
replacement as `status = 'active'` with `client_approval_status = 'pending'`. Every new
version therefore passed through a state where it was the live document and unapproved.

`assertStrategyApproved` blocks the lead upload until all four documents read `approved`,
so generating a new version stopped outreach for that organisation until a client clicked
Approve or the daily `strategy-doc-auto-approve` cron decided three days had elapsed. RLS
could not help: the client policy gated on `status` and never read
`client_approval_status`.

Nothing was ever destroyed. Every archived version still held its content. There was
simply no route back, and no way to tell two versions apart once you found them.

### The decision

Client approval on strategy documents is removed. The conversation with the operator is
the approval. A document is live because an operator produced it.

Removed completely rather than defaulted to `approved`, so nothing is left half-wired:
the two approval routes, the auto-approve cron and its monitor, the approval condition in
every read, the Approve button, the pending state, the operator "Proceed without client
approval" escape hatch, and the client email promising that three days of silence counted
as approval.

**Not touched:** prospect batch review, which is a separate mechanism and a separate
decision that still stands. Nor the hourly `auto-approve` job on `document_suggestions`,
which is the operator's own queue.

### What replaces it

**One document on screen, always the current one.** A line saying it changed and when,
with View previous beside it. Never two documents side by side.

**Every version listed with the note that produced it.** `describeVersion` falls back
note, then change summary, then what produced it, because the four documents an
organisation starts with have neither and would otherwise be blank rows.

**Revert to any version, not only the last.** `revert_strategy_doc_version` copies an old
version's content forward as a NEW version through the same promotion function. The old
row is not resurrected, so history grows in one direction and nothing is destroyed in
order to recover something. Operator-only: reverting rewrites the copy every future email
is composed from, and a client's route to a change is Request an update.

**On messaging, the panel says what restore does not do.** It affects emails composed from
that point on. Emails already written are not rewritten and campaigns already running
continue exactly as they are. That is structurally true rather than a promise: a
prospect's whole sequence is composed in one call, uploaded to the provider as substituted
variables, and `applySendGate` only ever claims prospects at
`outbound_upload_status = 'pending'`.

### What happened to the four approval columns

Not dropped, and not left alone. Both were wrong for opposite reasons: dropping is
irreversible and `approval_source` plus `approved_at` on 30 archived rows are the only
record of whether a past version was approved by the operator, by a client, or by the
three-day cron; leaving them means `client_approval_status` keeps its
`NOT NULL DEFAULT 'pending'`, so every new row is born 'pending' and one re-added read
silently blocks the lead upload again.

So the defaults and the NOT NULLs are dropped and the data is untouched. History survives
in full, and a new row gets NULL, which is not a state anything can gate on. The CHECK
constraints stay: a CHECK passes on NULL because it only fails on FALSE, so NULL is
admitted while a third value would still be rejected.

Measured after applying: 30 rows still carry `approval_source` and `approved_at`, all 62
rows still carry the `client_approval_status` they had, and a promotion run inside a
rolled-back probe produced `client_approval_status=NULL pending_since=NULL`.

One adjustment was needed and it was found by probing rather than by reading. Dropping the
DEFAULT on `pending_since` while leaving its NOT NULL breaks every promotion, because
`promote_strategy_doc_version` stopped naming that column and the default was the only
thing filling it. The probe, run inside a DO block that rolled itself back, returned
`NOT NULL VIOLATION on pending_since`. `pending_since` therefore drops its NOT NULL too.

### Cascade: flag, do not auto-rewrite

An upstream change marks the downstream documents stale and surfaces them to the operator
with a regenerate action. Nothing regenerates on its own. Judging whether a change is
relevant is exactly what an automatic rewrite cannot do, and a client's voice must not
change mid-campaign because a headcount band moved.

`triggerCascadeIfEligible` was already called a cascade and had never propagated a change:
`isEligible()` returns true only when the target has no active document and no pending
suggestion, so once positioning exists an ICP change can never reach it. It is a
first-generation sequencer and is left as one.

`strategy_documents.is_stale` had existed since the table was created with nothing ever
reading or writing it. This is its first use.

### What the RLS widening cost

The client policy now admits `archived`, because archived rows are the history. The
consequence needed code: reads that filtered only by organisation and document type used
to get "live only" free from RLS. `buyer-criterion-view` now gates on `status = 'active'`
itself, and `deriveStrategyNavState` counts document TYPES rather than rows so a pile of
archived rows cannot stand in for a document that does not exist.

### Three defects found by running it, not by reading it

**The note reached the prompt and stopped there.** An operator regenerated with a note,
approved, and the version had `revision_note` NULL, because `approve_document_suggestion`
passed NULL and nothing had written the note onto the suggestion row. Five regenerations
produced five indistinguishable entries, which is the one thing the version history exists
to prevent. Same family as ADR-038, one step further down the pipe.

**`update_trigger` had a CHECK constraint that did not include `revert`.** The function
was correct, the migration that introduced it never touched the constraint, and nothing in
the type system or the suite could see it: `update_trigger` is `text` on both sides and
the constraint lives only in the database. The producer-and-consumer-disagreeing shape,
with the database as the consumer.

**The client revision path never derived the ICP filter spec.** Every active ICP with
`update_trigger = 'client_revision'` had a NULL spec; every one from the suggestion path
had one. A clean split along the code path. Fixed, and the fix asserts the NEW document id
is passed, because deriving from the old one would write a spec onto an already-archived
row and look right.

---

## ADR-048 — A rate declares its unit, the unit drives the denominator, and an unsourced range is removed rather than kept

**Date:** 2026-09-03
**Status:** Accepted
**Supersedes nothing. Corrects the range half of the 2026-09-02 reply-denominator change.**

### The decision

Three parts, and the third is the one that generalises.

1. **The meeting booking rate is denominated in people contacted**, matching the reply
   rate, computed at the metrics chokepoint so no two pages can render different values.
   Its sample gate is `MIN_PEOPLE_FOR_MEETING_RATE = 1500`, derived independently rather
   than reused from the reply gate.

2. **The meeting booking industry range is REMOVED, not replaced.** No defensible
   per-person published benchmark exists. The card shows our rate alone and says so.

3. **Every benchmark declares a `unit`, and the page derives its denominator from that
   declaration.** A card cannot name one unit and divide by another.

### What went wrong, which is why part 3 exists

Commit `9283bbe` (2026-09-02) moved the reply rate's denominator from emails sent to people
contacted. The statistics are sound and that change stands: `sqrt(p(1-p)/n)` assumes n
independent trials, and four emails to one person are one person deciding once, prompted
four times. Counting them as four overstates the sample by roughly the sequence length.

What it missed is that the 3 to 6% range it was rendered beside is measured **per email
sent** by its own source. The Instantly report defines its metric as "percentage of all
replies received (including follow-up responses) divided by TOTAL EMAILS SENT", average
3.43%, top quartile 5.5% — which is where 3 to 6 came from. So for one day the page divided
by people and compared the result against a range built by dividing by emails.

The code comments in `get-client-visible-campaign-metrics.ts` and `BenchmarksView.tsx` both
asserted the opposite: that the published figures were people-denominated and the old
per-email rate was "the one being compared against a range measured the other way". The old
rate was in fact the one that matched. Both comments are corrected in place rather than
deleted, because a wrong comment that reads as a rationale is what carried the error
through review.

**The rate was not reverted.** Per person is the better statistic. The range moved instead,
to two sources that state a per-contact denominator in their own words, both verified
against the primary source rather than a summary:

| Source | Sample | Figure |
|---|---|---|
| Smartlead, State of Cold Email 2026 | 850M+ emails, Jan–Jun 2026 | median 0.74% of contacts; top 10% 2.63%+ |
| ReplyLead, August 2026 | 115 campaigns, 242,669 unique leads | median 2.12% per contacted lead; IQR 1.39–3.00% |

Range shown: 0.7 to 3%. The two medians differ threefold. That is a real disagreement
between populations and the width of the range is the honest shape of it.

### Why the meeting range is deleted rather than corrected

It read 1 to 3%, cited to the Instantly report. That report **publishes no meeting metric
at all**, in any unit. The number on a client-facing card presenting itself as research had
no source behind it. This is the second citation to fail on this one card: Belkins was
removed earlier for contradicting the same range, and the replacement did not carry the
figure either.

Four candidates were read and rejected:

- **GROU** — 0.35% median, 0.9% top quartile, 47 B2B clients. The only one with first-party
  data and a stated method, and explicitly "the percentage of SENDS that result in a
  calendar booking". Wrong unit.
- **Prospeo** — 1 to 4% per sequence started. The article attributes it to nothing.
- **LeadHaste** — 0.4 to 3.0% "per unique prospect". No sample, no method, no named source,
  selling consulting on the same page.
- **Assorted blogs** — several attribute 1 to 3% to the Instantly report. That is our own
  unsourced number circulating back with a citation attached, which is the strongest
  argument for deleting it.

**Removal is stated on the card, not silent.** A heading reading "Industry range" with
nothing under it looks like a loading failure. The card carries the reason, and so does the
page attribution. In the type system `MetricBenchmark` is a discriminated union: the
member with `industryRange: null` requires `rangeAbsentNote`, so dropping a range without
writing down why does not typecheck.

### The generalisation, which is the part to carry forward

**A denominator change is a change to BOTH SIDES of a comparison.** Changing our half and
leaving the published half is not a partial fix; it is a new defect pointing the other way.
The 2026-09-02 change made the reply rate more meaningful and less comparable in the same
edit, and nothing on screen or in the type system could see the second half.

This is a new instance of a shape already in CLAUDE.md: *a producer and a consumer that are
each correct and disagree on FORMAT*. Here the two sides are our arithmetic and a published
figure, and the disagreement is a unit rather than a string encoding. The fix is the same
in kind: make the seam explicit and test the PAIR.

Structurally:

```ts
// tier1-benchmarks.ts — the unit is declared once, beside the range it belongs to
replyRate: { industryRange: { min: 0.7, max: 3 }, unit: 'people contacted', ... }

// BenchmarksView.tsx — and the arithmetic is derived from it
function denominatorFor(unit: RateUnit): number {
  switch (unit) {
    case 'people contacted': return contactedCount
    case 'emails sent':      return sentCount
    case 'replies':          return repliedCount
  }
}
```

Changing the unit changes the division. There is no second place to update, so the label
and the arithmetic cannot drift. Both halves print their unit on the card, ours on the
counts line and the range on its own, because a reader who can see only one of the two
cannot check whether they match.

### The sample gate is derived, not copied

`MIN_PEOPLE_FOR_MEETING_RATE = 1500`, from the same standard error of a proportion at the
rate meetings actually run:

```
0.0025 = sqrt(0.009 × 0.991 / n)   ->   n ≈ 1,427, rounded to 1,500
```

Reusing `MIN_PEOPLE_FOR_RATE = 400` would print a meeting rate off roughly 3.6 expected
events, a figure that moves by a third of itself when the next meeting lands. It is a
separate constant with a separate derivation for the same reason `MIN_PEOPLE_FOR_RATE` is
separate from `MIN_SENDS_FOR_RATE`: same formula, different question, and dragging one
along with the other is how the units got confused in the first place.

The cost, stated: about 3.75× the reply gate, so the meeting card shows a dash for
considerably longer. A long dash beats a confident number off 3.6 expected meetings.

### What was deliberately not done

**The numerator is not campaign-scoped.** `meetings.campaign_id` exists with a foreign key
to `campaigns`, but the Calendly webhook — the only writer of meeting rows — never
populates it. The link is reachable one hop away through `prospect_id →
prospects.campaign_id`. Left alone: there is currently one campaign per organisation, both
sides are already org-scoped by `.eq('organisation_id', …)`, and the distinction has no
instances. Recorded in BACKLOG rather than built against a case that does not exist.

**Bounce and opt-out stay per email.** Deliverability is a property of a message. A bounce
is one address rejecting one delivery; an opt-out arrives from one email even when three
more were scheduled. Dividing either by people would answer a question nobody asks of them.
The positive reply share is of replies and was never involved.

### Rollback

Display only. No migration, no schema change, no write path: every touched module only
reads. Nothing stored changes, so `git revert` is sufficient and complete.

---

## ADR-049 — Suppression reaches the sending tool via a capability, by interest status, and a reconciliation reads the provider rather than our own record

**Date:** 2026-09-04
**Status:** Accepted, implemented, proved on a live prospect
**Supersedes nothing. Extends ADR-034, which recorded that the third layer did not exist.**

### The problem, as measured rather than as reported

Marking a prospect suppressed changed nothing about what the sending tool had already
queued. Measured live before any of this was built:

    prospect ecc5f9d2-3b8e-4ad4-a70b-0f829409149f
      our database:  suppressed = true, client_review_status = 'rejected'
      the provider:  status 1 (Active), no interest status,
                     step 3 executed 2026-08-31, step 4 queued behind a seven-day delay

Uploaded 2026-08-21. Nothing in this codebase ever told the provider.

**The framing that turned out to be wrong is worth recording.** It is not true that
suppression never reached the provider. Of the four write sites, the opt-out reply path DID
call it, and its two prospects are correctly stopped. The fault was that ONE path did it and
nothing compared the two sides.

| write site | provider call before | can fire after upload |
|---|---|---|
| client rejection route | none | no, guarded to `outbound_upload_status = 'pending'` |
| research auto-disqualification | none | **yes**, research can re-run on an uploaded prospect |
| opt-out reply | yes | yes, and handled |
| a hand-written UPDATE | none | **yes, and this is the one that bit** |

### Decision 1 — a capability, not two more direct callers

`can_suppress_contact` in `integrations_registry`. All three paths and the reconciliation
sweep go through it.

The opt-out path called the provider handler directly, which its own comment flagged as a
deferred ADR-001 violation. This work added two more callers. Wiring them the same way would
have tripled a recorded violation instead of repaying it, for the same effort.

### Decision 2 — interest status, not delete and not the blocklist

Four mechanisms exist. Checked against the provider's documentation on 2026-09-04.

**Rejected: delete.** The API description says plainly that it cannot be undone, and nothing
documents what survives it. Reply history is load-bearing here, not decoration: the reply
processor threads replies off the stored email object, campaign analytics counts replies, and
the reply audit trail is the compliance record showing an opt-out was honoured. Irreversible
plus undocumented is not a combination to choose when a reversible option exists.

**Rejected: the workspace blocklist, and this is the load-bearing decision.**
`getInstantlyApiKey` ignores its `organisationId` argument and returns one global key, so
every client's campaigns live in one workspace and share one blocklist. One client rejecting
a prospect would block that address out of every other client's campaigns, silently and
permanently, and blocklist entries accept whole domains. Today there is one campaign and the
blast radius is zero. The moment there are two, it is not.

**The cost of that refusal, stated:** the blocklist is the only mechanism that can stop an
address with no lead row yet. Interest status needs a lead id. That half is already covered by
`findBlockedProspects`, which blocks a suppressed address before it is ever uploaded. The two
mechanisms cover different halves and this one covers the half that was missing.

### Decision 3 — the write is read back, and the read-back does NOT check status

`stopLead` writes, then GETs the lead and confirms the value landed. A 200 from a write
endpoint is the same class of evidence as a notification logged as sent before sending.

**The stop is asynchronous. Measured, not assumed:**

    before                    status 1 (Active), interest unset
    T+0.5s after the PATCH    status 1 (Active), interest -1
    T+43s                     status 3 (Completed), interest -1
    then                      absent from the provider's own ACTIVE filter

So the documented behaviour holds and the immediate read-back cannot see it. The check asserts
the interest field only. Requiring status to have moved would have failed every suppression
this system makes, and the obvious fix for that failure — dropping the read-back — would have
removed the confirmation instead of the wrong assertion.

### Decision 4 — a column on the prospect, not just an action row

`outbound_suppression_status` is `not_required`, `confirmed` or `failed`. An action row
answers "what happened in this run"; the column answers "does this record claim suppressed
while the provider was never told", which is one predicate over every write site rather than a
join that exists for one of them.

NULL on a suppressed row is a finding, not a gap: it means something bypassed the shared path.

### Decision 5 — the reconciliation reads the PROVIDER, and it is the half that matters

MON-026, every 30 minutes.

Two of four write sites are code. **The one that actually bit was a hand-written UPDATE**, and
no amount of care on a code path catches a person typing SQL. Neither does the column above,
because a hand UPDATE leaves it NULL.

So the sweep never consults our suppression columns to decide anything. It asks the provider,
per lead, and compares against `findBlockedProspects` — reusing the send gate rather than
restating it, because a reconciliation that disagrees with the gate it audits would go green
over exactly the prospects the gate blocks.

**Unreachable is red, not green.** "We could not tell" and "it is fine" are different answers.

**Vacuous truth is UNKNOWN, not OK.** Every rule is "no row is in a bad state", all true over
an empty set.

### What the first live run changed

It reported 2 unreachable out of 6, and **neither was a provider that could not be reached**:

- one lead had been deleted along with its campaign in August, deliberately
- one row carried `mock-lead-0-1780586487684`, a MOCK id written into a real prospect row by
  an upload made while the provider flag was off

Both would have held MON-026 red on artefacts for ever, which teaches an operator to ignore
the board. The sweep now falls back from the stored id to the **address**, which is the
authoritative question: a provider holding no lead for an address cannot be sending to it,
whatever our column says. Only when both the id and the address fail to answer is it
unreachable.

Second run: 26 uploaded, 6 suppressed, 6 read back, 0 unreconciled, 0 unreachable, 0 invariant
breaches.

### Two bugs fixed on the way, both of a shape this codebase already names

**The fabricated success.** `process-reply` set `{ ok: true }` when no lead id could be
resolved, marked the signal processed, and never retried. The reasoning beside it was that the
database is authoritative — true for future uploads, false for the sequence already in flight,
which is the only thing that call can stop. So the case where the call mattered most was the
one recorded as a success. Same family as the opt-out footer that was validated and then
discarded by a return-value bug.

**The single-match address lookup.** `resolveInstantlyLeadId` asked for `limit: 1` and took
`items[0]`, so an address held as two leads had one stopped and the rest left sending. The
provider's own list endpoint carries a `distinct_contacts` flag whose entire purpose is
collapsing duplicates of one address, which is the provider stating that duplicates are an
expected state. `findLeadIds` now pages to exhaustion and a partial stop is recorded as a
failure.

### What was deliberately not done

**`prospects.email_send_eligible` is untouched.** That verdict is frozen at verification and
re-evaluating it costs money per address. ADR-034 covers it and it stays a separate problem.

**Suppression is still not retroactive across the board.** This stops what the provider holds
now. It does not re-run any eligibility rule over rows already evaluated.

**The reject route's provider call is a no-op today** and was added anyway. The route is
guarded to `outbound_upload_status = 'pending'`, so it resolves `not_required` and writes that
to the row rather than leaving NULL. If that guard is ever relaxed, the path is already
correct — and the two prospects that prompted this whole build were suppressed by hand
precisely because that route refused them.

### Rollback

`git revert` restores the code. The two migrations are additive: three nullable columns, a
partial index, one registry row, one singleton table, one view, one cron job. Reverting the
code without the migrations leaves unread columns and a cron calling a 404 route, which shows
up as MON-026 going stale rather than as silence. Drop the cron first if reverting.
