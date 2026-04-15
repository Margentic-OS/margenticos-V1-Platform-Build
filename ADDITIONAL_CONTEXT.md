# MargenticOS — Additional Context Prompt
# This supplements HANDOFF_PROMPT.md. Paste both when starting a new session.
# This file captures reasoning, judgment calls, and context that shaped the build
# but doesn't fit neatly into the spec documents. Without this, the right decisions
# get made for the wrong reasons, or good decisions get quietly reversed.

---

## The product origin and why it matters for build decisions

MargenticOS was designed from the ground up as a services business, not a SaaS product.
Doug runs campaigns manually using existing tools. The system makes that scalable.

This distinction affects almost every UI and agent decision:
- Clients never see execution controls because they don't need them
- The dashboard is a results and IP display layer, not an operations tool
- Agents don't replace tools — they orchestrate them
- The operator view is Doug's control panel, not an admin interface

When a feature request feels like "letting the client do X themselves," that is usually
a signal to pause and reconsider. The service model depends on clients not operating
the system. They buy outcomes and IP, not software.

---

## The four strategy documents — why quality matters so much

These documents are the primary product the client is buying.
The $750 setup fee essentially pays for these four documents.
They are the client's permanent IP — they keep them even if they leave.

This means:
- A generic-feeling document is a product failure, not just a quality issue
- The "AI slop" test must be applied rigorously — would a sharp founder cringe reading this?
- Each document must feel like it was written specifically for this person's business
- The frameworks underpinning each document were selected specifically for this:
  ICP: JTBD + Four Forces of Progress + Tier model (not just demographics)
  Positioning: April Dunford "Obviously Awesome" + Moore compression
  TOV: extraction-first principle (find their real voice, correct bad habits)
  Messaging: Foundation + layer architecture + StoryBrand influence

The TOV extraction principle is particularly important:
Extract: vocabulary, rhythm, personality, sentence structure, natural warmth
Correct regardless of samples: never open with I/We, one question max per message,
no feature listing before relevance, no service-led language, first touch under 100 words.
The agent must improve the voice even when the writing samples show these bad habits.

---

## The founding client offer context

Three founding slots. $750 setup + $500/month for 3 months.
In exchange for: feedback, testimonial, case study.
Explicit framing to founding clients: "You're helping me build this.
Your fee is marginal. In return I'll be more communicative, more iterative,
and more involved than any future client will experience."

This is important context for any onboarding copy or client-facing language.
The founding clients know they're early and they've accepted that.
The goal is to under-promise and over-deliver on results.

---

## MargenticOS as client zero — what this means in practice

Doug runs the full MargenticOS system on his own business first.
This is not a test environment — it is a live campaign for Doug's own pipeline.

In the database: MargenticOS is the first row in the organisations table.
Doug fills out the intake questionnaire about MargenticOS.
The four strategy documents are generated for MargenticOS itself.
Apollo is used to find prospects for MargenticOS.
Instantly runs cold email campaigns for MargenticOS.
Taplio posts LinkedIn content for MargenticOS.
GoHighLevel tracks meetings for MargenticOS.

The output of running client zero:
- Every integration is tested against real data before a paying client touches it
- Every webhook is verified against live events
- The four strategy documents for MargenticOS become the product demo
- Campaign results become the case study that sells the service
- Doug understands every part of the client experience firsthand

This is not optional. Phase one is not complete until client zero is live.

---

## The Lean Marketing conflict of interest — unresolved, must not be forgotten

Doug is a contractor at Lean Marketing selling full-funnel marketing programs
to the same buyer profile as MargenticOS (founder-led B2B service firms).

Before MargenticOS outbound begins — even for client zero — Doug needs to:
1. Read his Lean Marketing contractor agreement
2. Decide how to handle prospect overlap (a prospect contacted via MargenticOS
   should not also be pitched via Lean Marketing and vice versa)
3. Make a conscious decision about how to separate the two activities

This is not a build issue. It is a timing issue.
Nothing in the codebase needs to address this.
But it must be resolved before any live outbound campaigns begin.
Flag this to Doug if it comes up in context.

---

## The dashboard design direction — locked and approved

Three views were mockup-verified through multiple iterations.
The approved aesthetic is called the "A/B amalgam":
- Dark green sidebar (#1C3A2A) with the A-direction navigation structure
- Editorial header from the B-direction (eyebrow + large title + sub)
- White cards on warm off-white (#F8F4EE) background
- Progress bar as primary metric (not a hero number)
- Strategy panel as a permanent fixture on the right side of the pipeline view

The key UX decision on metrics: the primary visual is momentum (progress toward target),
not raw numbers. Raw numbers in months 1–2 would discourage clients.
"7 of 8 meetings — On track" is psychologically very different from just "7 meetings."

The empty state is a first-class view, not a fallback. It is the client's experience
for the first two months. It must feel like an arrival, not an absence.

---

## Personalisation framework for outbound — Trigger-Bridge-Value

The prospect research agent uses the Trigger-Bridge-Value framework.
This was selected after research across multiple frameworks.

Trigger: one specific business-relevant observation about this prospect right now.
Bridge: one sentence connecting that trigger to the problem the client solves.
Value: outcome statement framed around the prospect, not the service.

Critical business-relevance filter (never bypass):
ALLOWED: business pain signals, role pressures, company growth indicators,
strategic shifts, hiring patterns, tech changes, funding events, published business content.
FORBIDDEN: personal interests, hobbies, sports, family, personal social media,
conference attendance (unless business topic), anything surveillance-like.

One personalisation element per email. One sentence. Woven naturally into the opening.
Not a separate "personalisation paragraph" — just one line that proves someone looked.

If no trigger found after 3 research steps: use role-based pain proxy.
Never fabricate a trigger. Never use a generic compliment.

---

## A/B testing framework — OVAT with signal tiers

The feedback loop uses tiered signal thresholds:
3 signals (same type, unrelated prospects) → low-confidence suggestion (informational)
5 signals → agent generates A/B test variant for next batch
10 signals + confirmed A/B winner → high-confidence document update suggestion

A/B tests follow OVAT (One Variable At A Time):
Test sequence: subject line → opening line → CTA → sequence length.
Minimum 200 prospects per variant for meaningful results.
Wait 5–7 business days before evaluating.
Winner requires 15–30% relative lift over control.

At small list sizes (<200 per client), treat A/B results as directional signals,
not declared winners. The pattern library across multiple clients compensates
for the lack of statistical power at individual client level.

---

## Performance monitoring framework — tiered SLO protocol

The warnings engine uses a tiered response protocol borrowed from SRE practice:

Green: silent monitoring, no operator action needed.
Amber: diagnostic suggestion with recommended action. Doug approves or dismisses.
       No automatic action — human decision required.
Red: auto-pause of specific campaign + critical alert with plain English diagnosis
     + specific recommended fix + one-click approve or reject.
     Nothing restarts without Doug's explicit action.

The quality of diagnostics matters as much as the thresholds.
A good warning says: "Reply rate dropped from 6.8% to 0.4% over 48 hours for
Apex Consulting's finance sequence. A sudden drop (not gradual) typically indicates
a deliverability issue. Recommended: pause and run inbox placement test in Instantly."
A bad warning says: "Reply rate is low. Consider reviewing campaigns." — never do this.

---

## Reply handling — the identity question for AI responses

Positive reply emails are signed "[Client Company Name] Team."
This was a deliberate decision after analysis of the legal and ethical position.

Never: founder name (implies the founder personally wrote this in real time)
Never: "AI" or "automated" (unnecessary disclosure that adds friction)
Never: "MargenticOS" (clients don't know who MargenticOS is)
Always: company team name (warm, professional, not deceptive, legally clean)

The AI reply agent sounds like a competent team member from the client's company.
It is not pretending to be human. It is not disclosing it is AI.
It is acting as a company representative — which is what it is.

---

## Intake completeness logic

80% of critical fields must be completed before documents generate.
Critical fields are tagged with is_critical = true in intake_responses.
Not all fields are critical — some are enrichment only.

If a critical open-text field is under 20 words: prompt one specific follow-up.
Do not move to the next section until the follow-up is answered or explicitly skipped.

After initial intake, clients can update at any time.
Updates trigger document refresh suggestions in the queue (not full regeneration).
The 90-day clock for the automated refresh email resets on meaningful intake updates.

---

## Document staleness — two different mechanisms

There are two separate staleness mechanisms — do not confuse them:

1. Internal operator flag (operator view only):
   If a document hasn't been meaningfully updated in 60 days while campaigns are active,
   the operator view flags it. This is an internal quality check for Doug.
   It prompts a review: is the strategy still current? Does anything need refreshing?
   Not shown to clients.

2. Client refresh email (via Resend, every 90 days):
   A warm personal email from Doug to the client.
   Framing: "It's been 90 days — anything changed worth updating?"
   Not a system notification. Not alarming. Not "your documents are stale."
   Clock resets on meaningful intake update.
   Doug receives a copy in his operator notifications when it fires.

---

## The pattern library — realistic expectations

The patterns table will be sparse for months.
With 3–5 founding clients, there will not be enough cross-client signal to produce
meaningful patterns for weeks or months.

This is fine and expected. It is not a bug.

Agents must handle empty pattern query results gracefully:
- Default to per-client signal history
- Do not fail or produce errors if the patterns table returns nothing
- Do not force patterns to be generated — they emerge naturally from signal volume

The pattern library's value compounds over time as more clients, more campaigns,
and more signals accumulate. Do not try to accelerate it artificially.

---

## What to do when scope is ambiguous or something is not in the spec

1. Check the relevant PRD section first
2. Check ADR.md to see if the decision was already made
3. If still unclear, check HANDOFF_PROMPT.md for reasoning context
4. If still unclear, stop and ask Doug before proceeding

Never invent an architectural solution and implement it silently.
Doug has invested significant time in the decisions recorded here.
A well-intentioned silent decision that conflicts with the architecture
creates technical debt that costs 10x the time it saves.

---

## Files in the project and where they live

/CLAUDE.md                     Standing instructions — read every session
/prd/PRD.md                    Hub index — read before loading any section
/prd/sections/01-14.md         Spec sections — load the relevant one per task
/docs/ADR.md                   Architecture decisions and reasoning
/docs/design.md                Visual design system and copy rules
/docs/prompts/                 Agent system prompt files (to be created in setup)
/docs/architecture.md          System overview (to be created/updated in setup)
/docs/data-model.md            Database reference (to be updated as tables are built)
/docs/agents.md                Agent documentation (to be updated as agents are built)
/docs/integrations.md          Integration documentation (updated as integrations built)
[remaining /docs stubs created in setup session]
