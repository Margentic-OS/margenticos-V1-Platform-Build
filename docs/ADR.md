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

## ADR-012 — Messaging agent writes four document_suggestions rows per run, grouped by sequence_position
Date: April 2026 | Status: Accepted

Context:
The messaging agent generates a four-email cold outbound sequence. The question is
whether to write the full sequence as a single row in document_suggestions or as four
separate rows, one per email.

Decision:
The messaging agent writes four separate rows to document_suggestions per sequence run.
Each row is tagged with sequence_position (integer 1–4) and document_type 'messaging'.
The four rows share the same organisation_id and are written in a single batch insert
so all four succeed or none are saved.

Reasoning:
Instantly (the email sending platform) loads sequences as individual emails. Each email
in a sequence has its own subject line, body, and send delay. Writing four separate rows
maps directly to this structure, making it straightforward to load the sequence into
Instantly without parsing a single compound document.
Emails 2 and 3 have subject_line set to null — threading must be configured in Instantly
when the sequence is loaded. A compound single-row document would require the dashboard
to parse and split the sequence before it could be used, adding unnecessary complexity.

Rejected alternatives:
- Single row with full sequence as compound JSON: rejected because it requires parsing
  at display time and at load time, and does not map to the Instantly email-per-row model.
- Separate agent runs per email: rejected because the four emails must be generated as a
  coherent unit — angle progression, threading, and word count relationships are enforced
  across the sequence.

Consequences:
The Session 4 dashboard approval UI must display messaging suggestions grouped by
sequence_position order (Email 1 → 2 → 3 → 4), not as four independent unrelated
suggestions. The grouping key is: same organisation_id + same document_type 'messaging'
+ status 'pending' + sequence_position 1–4. Approving the sequence should approve all
four rows together, or surface them as a sequence for review before approval.

