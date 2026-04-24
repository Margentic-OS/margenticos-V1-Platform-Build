# Prospect Research Agent v2 — Architecture & Scope
# Drafted: 2026-04-24
# Status: Scope document — NOT a build spec. Decisions in Section 4 must be resolved before build begins.

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [Proposed Architecture](#2-proposed-architecture)
3. [Synthesis Prompt Draft](#3-synthesis-prompt-draft)
4. [Implementation Decisions Needed](#4-implementation-decisions-needed)
5. [Phased Build Plan with Estimates](#5-phased-build-plan-with-estimates)

---

## 1. Current State Audit

### What the v1 agent does

The existing agent lives at `src/lib/agents/prospect-research-agent.ts`. Its job is to produce a single personalisation trigger for each prospect — one sentence that Email 1 opens with. It follows a strict waterfall: try Apollo, if that fails try web search, if that fails try the company website, if that fails fall back to a generic ICP pain point. It stops as soon as any source produces something.

**Current output schema (TBVResult):**
```typescript
{
  trigger: string           // one-sentence observation
  bridge: string            // connects trigger to problem
  value: string             // outcome framed for prospect
  source: 'apollo' | 'web_search' | 'website_fetch' | 'pain_proxy'
  confidence: 'high' | 'medium' | 'low'
  research_notes: string
}
```

**Where results are stored:** Directly on the `prospects` table row:
- `personalisation_trigger` — the trigger sentence
- `research_source` — which source produced it
- `trigger_confidence` — high/medium/low
- `trigger_data` — full TBVResult as JSON
- `research_ran_at` — ISO timestamp

**The synthesis model:** Claude Haiku 4.5, called once per source attempt.

**The system prompt:** Hardcoded inside `buildSystemPrompt()` in the agent file. Not editable without a code deploy.

### The core problem with v1

The waterfall architecture has a fundamental flaw: it stops at the first trigger it finds rather than synthesising across all available sources. But the deeper problem is the prompt and framing. The agent produces triggers in the pattern:

> "Given your work in consulting, you're likely dealing with feast-or-famine pipeline..."

This is assumption language. It reads as AI-generated because it is — there is no specific observation behind it. Founder-led consulting firms, the exact ICP MargenticOS targets, are precisely the people who have learned to recognise this pattern and delete immediately. The product-critical fix is shifting from assumption to observation.

**There is also no tier system.** Every prospect goes through the same process and tries to produce a "specific" trigger. When no specific signal exists, the fallback produces vague assumption copy, not honest ICP framing. The result is emails that neither feel personal (because they aren't) nor feel credible (because the "I know your pain" framing without evidence reads as spam).

### What the v1 agent does well

- Client isolation is solid: every query enforces `organisation_id` at the application layer
- Stateless invocation: no module-level state between calls
- Batch processing with error isolation: one failed prospect doesn't abort the batch
- Agent run logging: every invocation writes to `agent_runs`
- Pain proxy fallback: reads the client's ICP document for pain language — this is the right instinct, just the wrong framing

### How downstream agents use research output

**Composition handler** (`src/lib/composition/compose-sequence.ts`):
- Reads `prospects.personalisation_trigger` directly
- Applies the trigger to Email 1's first sentence after `{{first_name}}`
- Falls back to the same ICP pain proxy if trigger is empty
- Does not know which tier the trigger came from — treats all triggers identically

**Messaging agent** (`src/agents/messaging-generation-agent.ts`):
- Does NOT read research output at generation time
- Generates 4 variants (A, B, C, D) with different opening angle instructions
- All 4 variants are tier-agnostic — they assume a specific trigger will be applied at compose time
- Generates once per organisation, not once per prospect

**ICP, Positioning, TOV agents:** Do not read research output. They produce the documents that the research agent reads.

### Current database schema — research-relevant fields

The `prospects` table carries research output directly. There is no separate research results table. This means:
- No history: each research run overwrites the previous one
- No raw data storage: only the synthesised output survives
- No per-run audit trail linking a research result to the agent_run that produced it

---

## 2. Proposed Architecture

### Design principle

The v2 agent does not stop at the first source that produces something. It collects data from all available sources in parallel, stores all raw data, and runs a single synthesis step at the end. The synthesis step — not the individual source handlers — decides what tier the prospect is and what the trigger should be.

This separation of concerns is the key structural change. Source handlers gather. The synthesis step judges.

### Two-tier output model

**Tier 1 — Specific observation found.**
A dateable, verifiable public signal exists: a LinkedIn post, podcast appearance, authored article, case study they feature in, or similar. The trigger references this specific thing by name. It is observation-based, not assumption-based.

**Tier 3 — No specific signal found.**
No dateable public signal was found that is substantively relevant. The trigger uses ICP-derived pain framing: "From working with [ICP type] at your stage, [specific pain] is the pattern that comes up most." This framing is honest: it is based on pattern recognition from client work, not fake personalisation from a prospect who was never researched.

The tier number (1 and 3, not 1 and 2) is kept consistent with the ICP document's existing Tier 1/Tier 2/Tier 3 prospect classification. This is intentional — the research tier reflects what was findable, not the quality of the prospect.

### Data sources — all attempted in parallel, failures tolerated

| Source | Status | Notes |
|--------|--------|-------|
| LinkedIn profile (via `stickerdaniel/linkedin-mcp-server`) | **BLOCKED** — MCP not installed, throwaway account not created | Build handler now; integrate when unblocked |
| Apollo enrichment (`/api/v1/people/match`) | **BLOCKED** — 403 on free plan | Build handler now; integrate when Apollo Basic activated |
| Company website (user-agent spoofing + Jina.ai Reader fallback) | Available now | Jina.ai Reader (`reader.jina.ai/URL`) returns clean markdown, bypasses most anti-bot |
| Web search (Brave Search + Anthropic native web search) | Available now | Two passes: person-specific + company-specific |

**Failure mode at each source:**
1. Try primary method
2. On failure: try alternative method (e.g., Jina fallback for website)
3. On second failure: mark source as unavailable in `sources_attempted` but not `sources_successful`
4. Never throw to the batch runner — one source failure is not a prospect failure
5. After all sources: if zero sources returned data, classify Tier 3 with low confidence and flag prominently

### Relevance filter applied during synthesis

When multiple signals exist, the synthesis step picks the most relevant using this ordering:

1. **Pain signal** — directly maps to the client's ICP four_forces.push pain points (highest priority)
2. **Value prop signal** — connects to the client's positioning and unique attributes
3. **Conversation starter** — professionally relevant and specific (not university, not football team, not city of residence)

A conversation starter that does not connect to the prospect's professional situation or the client's ICP is not a valid trigger. The synthesis prompt enforces this explicitly.

### Qualification assessment

Built into the synthesis step. Separate from tier classification.

| Status | Trigger condition |
|--------|-------------------|
| `qualified` | Default. No disqualifying evidence found. Absence of evidence is not grounds for flagging. |
| `flagged_for_review` | Ambiguous contradicting evidence found: former-role language, headcount significantly larger than ICP ceiling, industry that contradicts what Apollo reported |
| `disqualified` | Strong specific evidence: closed business, acquisition by larger firm, "open to work" status (signals no active company to sell to) |

Disqualified prospects: set `prospects.suppressed = true` automatically. Do not delete — historical data is valuable.
Flagged prospects: notify operator by email, but proceed to the sequence (do not block). Operator decides whether to suppress.

### File structure

**New files:**
```
src/lib/agents/prospect-research-agent-v2.ts          Entry point. Orchestrates sources → synthesis → store.
src/lib/agents/research/types.ts                      All new interfaces and types for v2.
src/lib/agents/research/sources/linkedin.ts           LinkedIn source handler (blocked until MCP ready).
src/lib/agents/research/sources/apollo.ts             Apollo source handler (blocked until Basic activated).
src/lib/agents/research/sources/website.ts            Website source: user-agent spoofing + Jina fallback.
src/lib/agents/research/sources/web-search.ts         Web search: Brave + Anthropic native.
src/lib/agents/research/synthesize.ts                 Synthesis step: all raw data → tier + trigger + qualification.
src/lib/agents/research/qualify.ts                    Post-synthesis qualification check (deterministic rules first).
src/lib/agents/research/prompts/synthesis-prompt.ts   Editable synthesis prompt. Lives here so Doug can tune it.
```

**Modified files:**
```
src/lib/composition/compose-sequence.ts               Read research_tier; route to tier-appropriate variant.
src/agents/messaging-generation-agent.ts              Generate 8 variants: 4 Tier 1 + 4 Tier 3.
```

**Migration:**
```
supabase/migrations/[date]_prospect_research_v2.sql   New table + new columns on prospects.
```

**v1 agent status:** `prospect-research-agent.ts` remains in place until v2 is verified end-to-end. Do not delete during build. Archive after v2 dogfooded.

### Data flow

```
Input: prospect_id + client_id
         │
         ▼
Load prospect record (prospects table)
Load client docs: ICP, Positioning, TOV (strategy_documents)
         │
         ▼
Parallel source collection — all four sources attempted simultaneously
  ┌─────────────────┬───────────────┬────────────────┬──────────────────┐
  │ LinkedIn source │ Apollo source │ Website source │ Web search source│
  │ (blocked: MCP)  │ (blocked: 403)│ user-agent +   │ Brave + Anthropic│
  │                 │               │ Jina fallback  │ native           │
  └─────────────────┴───────────────┴────────────────┴──────────────────┘
         │ (collect all raw data, mark each source attempted/succeeded)
         ▼
Single synthesis step (Claude Sonnet 4.6 — see Decision #1)
  Input: all raw data + ICP document + Positioning document + TOV guide
  Output: tier, qualification_status, trigger_text, trigger_source,
          synthesis_reasoning, confidence
         │
         ▼
Store to prospect_research_results table (raw data + synthesis output)
Update prospects table (research_tier, qualification_status,
                        current_research_result_id, suppressed if disqualified)
         │
         ├── qualification_status = 'disqualified' → suppress prospect, stop
         │
         ├── qualification_status = 'flagged_for_review' → email operator,
         │   then continue to make available for composition
         │
         └── qualification_status = 'qualified' → available for composition
                  │
                  ▼ (at send time, via compose-sequence.ts)
         Read research_tier → select tier-appropriate variant set from messaging doc
         Read trigger_text from current_research_result → apply to Email 1
                  │
                  ▼
         Outbound sequence (Instantly)
```

### Output schema — new

**`prospect_research_results` table (new):**
```typescript
{
  id: string                              // uuid
  prospect_id: string                     // FK → prospects.id
  organisation_id: string                 // FK → organisations.id (for RLS)
  run_id: string | null                   // FK → agent_runs.id

  // Synthesis output
  research_tier: 'tier1' | 'tier3'
  qualification_status: 'qualified' | 'flagged_for_review' | 'disqualified'
  qualification_reason: string | null     // Why flagged/disqualified. Null if qualified.
  trigger_text: string | null             // The one sentence that goes into Email 1
  trigger_source: {                       // What produced the trigger
    type: 'linkedin_post' | 'podcast' | 'article' | 'case_study'
          | 'company_content' | 'icp_pain_proxy'
    url: string | null
    date: string | null                   // Approximate date if known
    description: string                   // One sentence: what was found
  } | null
  synthesis_reasoning: string | null      // Claude's chain-of-thought before classification
  synthesis_confidence: 'high' | 'medium' | 'low'

  // Raw source data — stored indefinitely
  raw_linkedin: object | null
  raw_apollo: object | null
  raw_website: object | null
  raw_web_search: object | null

  // Source tracking
  sources_attempted: string[]             // e.g. ['linkedin', 'apollo', 'website', 'web_search']
  sources_successful: string[]            // e.g. ['website', 'web_search']

  synthesized_at: string                  // ISO timestamp
  created_at: string
}
```

**`prospects` table — new columns:**
```sql
research_tier           text    CHECK IN ('tier1', 'tier3')         -- denormalised for fast compose lookup
qualification_status    text    DEFAULT 'qualified'                  -- denormalised; updated each research run
current_research_result_id  uuid    REFERENCES prospect_research_results(id)  -- latest result
```

The existing columns (`personalisation_trigger`, `research_source`, `trigger_confidence`, `trigger_data`, `research_ran_at`) remain in place during the v2 build to avoid breaking the v1 compose path. They can be dropped after v2 is verified.

### Messaging document structure — v2

The messaging agent currently produces 4 variants (A, B, C, D) in a flat object. v2 needs 8 variants split by tier.

**New messaging document shape:**
```json
{
  "variants": {
    "tier1": {
      "A": { "emails": [...] },
      "B": { "emails": [...] },
      "C": { "emails": [...] },
      "D": { "emails": [...] }
    },
    "tier3": {
      "A": { "emails": [...] },
      "B": { "emails": [...] },
      "C": { "emails": [...] },
      "D": { "emails": [...] }
    }
  }
}
```

**Tier 1 variant instructions** (how Email 1 opens):
- A: Pain-led — pain signal from specific observation, then cost of inaction
- B: Outcome-led — what the specific situation signals about their likely goal
- C: Peer pattern — the observation connects to what similar firms are navigating
- D: Pattern interrupt — the observation challenges an assumption

**Tier 3 variant instructions** (how Email 1 opens):
- A: Pain-led — "From working with [ICP type], [specific pain] is the pattern that comes up most..."
- B: Outcome-led — frames the ICP pain as a solvable problem with a specific outcome
- C: Peer pattern — "Most [ICP type] at your stage are dealing with..."
- D: Direct ask — shortest possible; skips the pain frame, opens with direct question

All 8 variants: same 4-email cadence, same word count constraints, same validator rules.

### Integration points with existing agents

| Existing agent | Change required |
|----------------|-----------------|
| `compose-sequence.ts` | Read `prospects.research_tier`; select `messaging_doc.variants.tier1` or `.tier3`; read `trigger_text` from `current_research_result` instead of `personalisation_trigger` |
| `messaging-generation-agent.ts` | Generate 8 variants with tier-specific opening angle instructions; write new document shape |
| `icp-generation-agent.ts` | No change — research agent reads ICP at synthesis time |
| `tov-generation-agent.ts` | No change |
| `positioning-generation-agent.ts` | No change |
| `log-agent-run.ts` | No change — called as before at entry and exit |

---

## 3. Synthesis Prompt Draft

The synthesis step is the core of the product. The prompt below is a first draft written for initial testing. It lives at `src/lib/agents/research/prompts/synthesis-prompt.ts` as an exported TypeScript constant — editable without touching the agent logic, deployable without a schema migration.

---

```
You are a prospect research synthesist working for {{CLIENT_NAME}}.

Your job is to review research gathered from multiple public sources about a prospect and
produce a single, honest, observation-based trigger sentence for use in Email 1 of an
outbound sequence. You also assess whether the prospect should be reviewed or disqualified.

You serve {{CLIENT_NAME}}, whose clients are {{ICP_SUMMARY}}. Their core positioning:
{{POSITIONING_SUMMARY}}. Their TOV rules: {{TOV_RULES}}.

─────────────────────────────────────────────────────────────────────
PROSPECT
─────────────────────────────────────────────────────────────────────

Name: {{FIRST_NAME}} {{LAST_NAME}}
Role: {{ROLE}}
Company: {{COMPANY_NAME}}
LinkedIn: {{LINKEDIN_URL}}
Reported industry: {{INDUSTRY}}
Reported headcount: {{HEADCOUNT}}

─────────────────────────────────────────────────────────────────────
RESEARCH GATHERED
─────────────────────────────────────────────────────────────────────

{{RESEARCH_SECTIONS}}

(Each section is labelled with its source: LinkedIn, Apollo, Website, Web Search.
 If a section is absent, that source was unavailable or returned no data.)

─────────────────────────────────────────────────────────────────────
TIER CRITERIA
─────────────────────────────────────────────────────────────────────

Classify as TIER 1 if a specific, dateable, verifiable public signal exists from any of:
  • A LinkedIn post in the last 60 days (personal or company page)
  • A podcast appearance they made
  • An article, case study, or guide they authored
  • A case study or piece of content in which they appear as subject or client
  • Any authored public content that can be referenced by name and approximate date

A valid Tier 1 trigger must:
  ✓ Reference a specific piece of content (name it; approximate date if known)
  ✓ Be RELEVANT — connects to {{CLIENT_NAME}}'s ICP pain points, value prop,
    or a genuine conversation starter about their professional situation
  ✓ Be observation-based: "I came across..." "Caught your episode on..." "Saw your
    piece on..." — never "I imagine you're..." or "You're probably dealing with..."
  ✗ Must not begin with "I" or "We"
  ✗ Must not reference personal life (family, sports, university, city)
  ✗ Must not invent or assume details not present in the research

Classify as TIER 3 if no specific, relevant, dateable signal was found.
Do NOT classify as Tier 3 just because you found less than you hoped.
Classify as Tier 3 only when what you found is genuinely not specific enough to cite.

For Tier 3, use ICP-derived pain framing:
  "From working with [ICP type] at your stage, [specific pain from ICP four_forces.push]
   is the pattern that comes up most."
  OR: "Most [ICP type] I work with are dealing with..."

Never use "you're likely facing," "I'm sure you're dealing with," "I imagine," or "probably."
These signal assumption, not observation. Founders detect this immediately and delete.

─────────────────────────────────────────────────────────────────────
RELEVANCE ORDERING (when multiple signals exist, pick the highest)
─────────────────────────────────────────────────────────────────────

1. Pain signal — directly maps to a push force from the ICP document (highest priority)
2. Value prop signal — connects to {{CLIENT_NAME}}'s positioning or unique attributes
3. Conversation starter — professionally specific and genuinely interesting

A conversation starter that references someone's alma mater, home city, sports team,
or personal interest is NOT relevant unless it directly connects to their business situation.
If the only signal you found is of this type, classify Tier 3.

─────────────────────────────────────────────────────────────────────
QUALIFICATION ASSESSMENT
─────────────────────────────────────────────────────────────────────

Default: QUALIFIED. Do not flag unless you have specific contradicting evidence.

Auto-disqualify (strong evidence only — be conservative):
  • Business is confirmed closed, acquired by a larger entity, or dissolved
  • Person's profile shows "open to work" or "actively seeking employment"
    (no active company to receive outreach)

Flag for review (specific ambiguous evidence only):
  • LinkedIn shows this as a former/previous role with clear departure date
  • Company headcount significantly exceeds the ICP ceiling (e.g. 200+ employees
    when ICP ceiling is 15)
  • Industry clearly contradicts what Apollo reported (not just a different label —
    a fundamentally different business type)

NEVER flag based on:
  • Absence of information
  • Low LinkedIn activity or sparse profile
  • Can't find their website
  • They seem quiet or unengaged
  Absence of evidence is not evidence. Default: qualified.

─────────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────────

First, think through your reasoning in a <reasoning> block. Cover:
  1. What each source returned (or didn't return)
  2. Which signals are specific enough for Tier 1, and why
  3. Relevance assessment for any Tier 1 candidates
  4. Tier decision and why
  5. Qualification assessment — what you found (or didn't find) and your conclusion

Then output this exact JSON (no markdown fences around it):

{
  "tier": "tier1" | "tier3",
  "qualification_status": "qualified" | "flagged_for_review" | "disqualified",
  "qualification_reason": null | "one sentence explaining what evidence was found",
  "confidence": "high" | "medium" | "low",
  "trigger_text": "The one sentence that opens Email 1. No leading I/We.",
  "trigger_source": {
    "type": "linkedin_post" | "podcast" | "article" | "case_study"
             | "company_content" | "icp_pain_proxy",
    "url": "URL if available, otherwise null",
    "date": "Approximate date if known, otherwise null",
    "description": "One sentence: what specifically was found"
  },
  "relevance_reason": "One sentence: why this trigger connects to the ICP pain or value prop"
}
```

---

### Hand-crafted examples for prompt inclusion

These three examples are built from real publicly findable founder-led consulting firms. They illustrate what the synthesis step should produce. Two negative examples follow.

---

#### Positive Example 1 — Tier 1, podcast appearance

**Prospect:** Garrett Jestice, Prelude Marketing, GTM consultant for founder-led agencies
**LinkedIn:** linkedin.com/in/garrettjestice
**Website:** preludemarketing.com
**Signal found:** Appeared on *The Digital Agency Growth Podcast* (November 19, 2025). Episode: "How to Build a Real GTM System for Your Agency." Core argument: agencies plateau after $1M because they're running on random acts of growth, not a repeatable system. Also runs an active Substack (*GTM Foundations*) with December 2025 post on systematic referrals.

**Synthesis reasoning:**
The podcast appearance is specific, dateable (November 2025), and directly relevant. Garrett's episode argues agencies plateau because of the same root cause {{CLIENT_NAME}}'s positioning addresses — no repeatable pipeline system. The pain signal match is direct (ICP four_forces.push: referral-dependent growth hitting a ceiling). The Substack is also active and recent. Podcast episode is the stronger signal: dateable, named, directly relevant. Tier 1, high confidence.

**Output:**
```json
{
  "tier": "tier1",
  "qualification_status": "qualified",
  "qualification_reason": null,
  "confidence": "high",
  "trigger_text": "Heard your episode on The Digital Agency Growth Podcast last month — the point about agencies running on random acts of growth rather than a repeatable engine is exactly the pattern we work with.",
  "trigger_source": {
    "type": "podcast",
    "url": "https://thedigitalagencygrowthpodcast.buzzsprout.com/1859828/episodes/18220094",
    "date": "November 2025",
    "description": "Episode on The Digital Agency Growth Podcast about building a real GTM system for agencies, specifically the growth plateau at $1M and how to build a repeatable system."
  },
  "relevance_reason": "Garrett's podcast argument maps directly to the ICP push pain: founder-led service businesses that can't scale past referral-based growth because they have no repeatable pipeline."
}
```

---

#### Positive Example 2 — Tier 1, authored article

**Prospect:** Bruce Roberts, OakStreet Growth Partners, commercial growth consulting for T&L firms
**LinkedIn:** linkedin.com/in/bruce-roberts-profile
**Website:** oakstreetgrowth.com
**Signal found:** Published "Why Transportation & Logistics Companies Benefit from Both an Engagement Pipeline and a Deal Pipeline" on the OakStreet blog, March 5, 2026. Argues T&L operators need two structurally separate pipelines in their CRM — one for relationship cultivation, one for deal progression. This is a sophisticated structural insight that most T&L operators have never formalised.

**Synthesis reasoning:**
The article is specific, dateable (March 2026), and authored. The content is substantively professional — not generic thought leadership but a specific argument about pipeline architecture for T&L operators. Relevance: Bruce helps T&L clients build commercial systems; the article shows he thinks in systems. The connection to {{CLIENT_NAME}}'s positioning is via the value prop (you help founders build pipeline systems) rather than a direct pain signal. Tier 1, high confidence. The article is strong enough to reference directly.

**Output:**
```json
{
  "tier": "tier1",
  "qualification_status": "qualified",
  "qualification_reason": null,
  "confidence": "high",
  "trigger_text": "Came across your piece on the OakStreet blog about separating the engagement pipeline from the deal pipeline — that structural distinction is something most T&L operators have never been shown.",
  "trigger_source": {
    "type": "article",
    "url": "https://www.oakstreetgrowth.com/insights",
    "date": "March 2026",
    "description": "Blog article arguing T&L companies need two structurally separate pipelines: one for relationship cultivation, one for active deal progression."
  },
  "relevance_reason": "The article signals that Bruce thinks in structured commercial systems — the same framing {{CLIENT_NAME}} uses, which makes the connection to pipeline building credible and non-generic."
}
```

---

#### Positive Example 3 — Tier 3, honest ICP pain framing

**Prospect:** Rich Hartigan, Riverbend Consulting Group, fractional COO for $3M–$15M service businesses
**LinkedIn:** linkedin.com/in/richhartiganpdx
**Website:** rbendconsulting.com
**Signals found:** October 2025 LinkedIn post about "business growth is strategy" (general, low engagement). October 2024 LinkedIn post announcing he's "growing and taking on new clients" (dated, 18 months ago). Website bio describing his practice and 25 years of experience. No recent podcast appearances, no articles, no case studies with specific names or dates found.

**Synthesis reasoning:**
October 2025 post is about general growth philosophy — not specific enough to cite by name without it reading as filler. The "growing and taking on clients" post is 18 months old — too dated to feel current. Website bio describes his practice well but is not a signal we can reference specifically. No LinkedIn activity in the last 60 days found across web search results. No podcast appearances surfaced. Conclusion: no specific, dateable, relevant public signal exists. Profile is strong ICP match (solo fractional COO, $3M–$15M service clients). Tier 3 is the honest classification. Use ICP pain framing: the primary push pain for this ICP is referral-dependent pipeline — predictable enough to stay busy, not predictable enough to plan around.

**Output:**
```json
{
  "tier": "tier3",
  "qualification_status": "qualified",
  "qualification_reason": null,
  "confidence": "medium",
  "trigger_text": "Most fractional COO practices I work with at this stage are dealing with the same pattern — referrals keep the pipeline full enough to stay busy, but not predictable enough to plan around.",
  "trigger_source": {
    "type": "icp_pain_proxy",
    "url": null,
    "date": null,
    "description": "No specific recent public signal found. ICP pain proxy used: referral dependency creating unpredictable pipeline (primary ICP push force)."
  },
  "relevance_reason": "Rich's practice profile (solo founder, service-business clients, 25+ year practitioner) is strong ICP match. Referral-dependency pain is the primary push force for this ICP tier."
}
```

---

#### Negative Example 1 — Fake personalisation disguised as Tier 1

**WRONG output:**
```json
{
  "tier": "tier1",
  "trigger_text": "I noticed you've been thinking a lot about pipeline generation lately — that's exactly what we help with."
}
```

**Why this is wrong:**
"I noticed" with no cited event. "Been thinking a lot about" is an assumption with no specific evidence. The synthesis has invented a signal that does not exist. This is the exact pattern that gets cold emails deleted by the ICP. If no specific signal was found, classify Tier 3 and use honest framing.

---

#### Negative Example 2 — Assumption language disguised as Tier 3

**WRONG output:**
```json
{
  "tier": "tier3",
  "trigger_text": "Given your work in the consulting space, I'm sure you're dealing with feast-or-famine revenue patterns."
}
```

**Why this is wrong:**
"I'm sure you're dealing with" is assumption language. Even for Tier 3, the framing must be grounded in observed patterns from client work, not in what the agent imagines the prospect is experiencing. The word "sure" signals a guess. The correct Tier 3 framing grounds the claim in the client's experience with similar firms: "From working with consulting practices at your stage, feast-or-famine pipeline is the most common pattern I see — referrals when word-of-mouth is strong, silence when it isn't."

---

## 4. Implementation Decisions Needed

These must be resolved with Doug before building begins. Each is a genuine choice with implications that cannot be defaulted away.

---

**Decision 1 — Synthesis model: Haiku vs Sonnet**

ADR-013 assigns Claude Haiku 4.5 to the prospect research web search synthesis step. But the v2 synthesis step is materially different: it is no longer a simple "summarise this Apollo data into a trigger sentence." It must reason across multiple sources, assess relevance against ICP and positioning documents, make a tier classification, and assess qualification. This is the product's core quality driver.

Option A: Use Claude Sonnet 4.6 for the synthesis step. Higher quality, better reasoning, ~15× higher cost per call than Haiku. At 200 prospects/week per client, Sonnet synthesis adds roughly $3–8/week/client at typical token volumes — not material at this scale.

Option B: Keep Haiku for cost, accept lower synthesis quality. Risk: the tier classification is the product's differentiating feature. If Haiku misclassifies (produces Tier 1 from thin signals, or writes assumption language in Tier 3 framing), the product problem is not solved.

**Recommendation:** Sonnet 4.6 for synthesis only. Haiku remains appropriate for source-level summarisation (processing raw Apollo/website/LinkedIn data before feeding to synthesis). Update ADR-013 in same commit.

---

**Decision 2 — Flagged-for-review prospect UI**

When a prospect is `qualification_status = 'flagged_for_review'`, the operator receives an email (via Resend). But the dashboard needs somewhere to surface these so Doug can review them.

Option A: Add a "Flagged" filter to the existing prospects view. No new UI needed; a status badge and a filter. Small scope.

Option B: Build a dedicated review queue — a separate dashboard section showing only flagged prospects with their qualification_reason and research context.

Option B is cleaner operationally but adds UI scope. Option A is faster and sufficient for client zero (volume will be low).

**Needs Doug's call.** Recommendation: Option A for now, with flagged badge and filter. Build the queue when flag volume justifies it.

---

**Decision 3 — Disqualified prospect retention**

When a prospect is auto-disqualified (closed business, acquired, open to work), the agent sets `prospects.suppressed = true`. But should the prospect row and its research result be deleted eventually, or retained permanently?

Option A: Retain permanently. Value: historical data for re-engagement protocol (Phase 2), debugging, and pattern analysis. Storage cost is negligible.

Option B: Soft-delete after N months. Adds complexity; provides minimal benefit at current scale.

**Recommendation:** Retain permanently (Option A). Consistent with the "store all raw research data indefinitely" decision already made.

---

**Decision 4 — LinkedIn source via MCP at agent runtime**

The `stickerdaniel/linkedin-mcp-server` is a Claude Code MCP — it is configured in `.mcp.json` and available to Claude Code sessions. But the prospect research agent runs as a Vercel serverless function, not as a Claude Code session. The MCP will not be available at function runtime.

This is a significant architectural constraint. Options:

Option A: Use the LinkedIn MCP only for operator-initiated research runs (i.e., Doug triggers research manually from Claude Code). Not suitable for automated batch processing.

Option B: Implement LinkedIn research via a direct API call to the linkedin-mcp-server if it exposes an HTTP endpoint, or via a separate microservice that holds the LinkedIn session.

Option C: Use the LinkedIn MCP's underlying mechanism directly. If stickerdaniel/linkedin-mcp-server uses a headless browser or Playwright session, the same approach can be ported to the serverless function with appropriate timeouts.

Option D: Defer LinkedIn as a source until there is a hosted LinkedIn scraping service (Phantombuster, Apify) that can be called via HTTP — this is already on the Phase 2 backlog.

**Needs Doug's call.** This is the most significant architectural constraint in the entire v2 build. The source handler can be written now with the LinkedIn MCP interaction pattern, but the deployment pathway needs a decision.

---

**Decision 5 — Synthesis prompt editability: TypeScript file vs database row**

The synthesis prompt is the primary tuning surface for improving research quality. Two options:

Option A: TypeScript file (`src/lib/agents/research/prompts/synthesis-prompt.ts`). Editable in code. Requires a deploy to take effect. Doug tunes it via Claude Code sessions. Simple, version-controlled, no schema needed.

Option B: Operator-configurable database row in a `agent_prompts` table. Doug can edit the prompt in the dashboard without a deploy. More powerful; adds a new table, a new UI component, and prompt injection risk if not validated carefully.

**Recommendation:** TypeScript file for the v2 build. The weekly review cycle (spot-check 5-10 per batch, identify pattern, tweak prompt, redeploy) works well within Claude Code sessions. If tuning frequency increases, revisit.

---

**Decision 6 — QA feedback storage**

For the spot-check workflow (Doug reviews 5-10 research results per 200 batch, identifies patterns, flags issues), feedback needs to be captured somewhere structured.

Option A: A `research_qa_feedback` table with fields: `research_result_id`, `feedback_type` (good_tier1 / false_tier1 / bad_tier3_framing / wrong_qualification / other), `notes`, `reviewed_by`, `created_at`. Feeds into future prompt tuning sessions.

Option B: A `notes` text field on `prospect_research_results` that Doug fills in via the dashboard when reviewing. Simpler, less structured.

**Recommendation:** Option A — structured table. Even with low volume, structured feedback lets Doug and Claude Code identify patterns quickly ("4 of the last 10 false Tier 1s came from a Substack post with no direct pain relevance"). Design the table now; build the UI in Phase 4.

---

**Decision 7 — Tier 3 ICP pain language: research agent or composition handler?**

The Tier 3 trigger ("From working with [ICP type] at your stage, [pain] is the pattern...") requires knowing the ICP description. Two places it can be constructed:

Option A: The research agent reads the ICP document during synthesis and writes the fully-formed Tier 3 trigger text into `prospect_research_results.trigger_text`. The composition handler just uses whatever trigger_text is there — no special logic needed.

Option B: The research agent writes `tier: 'tier3'` and stores the raw ICP pain point. The composition handler constructs the "From working with..." sentence at compose time, injecting current ICP language.

Option A is cleaner: trigger_text is always fully formed when stored. The composition handler doesn't need to know about tiers at all — it just applies trigger_text to Email 1. This is the correct separation of concerns.

**Recommendation:** Option A.

---

**Decision 8 — Messaging agent update timing**

The 8-variant messaging document (4 Tier 1 + 4 Tier 3) is required before the full pipeline works. But the messaging agent update is an independent piece of work from the research agent rewrite.

Option A: Update the messaging agent before v2 research agent goes live. Requires both pieces before any live testing.

Option B: During Phase 1 testing, use the existing 4-variant messaging document for all prospects (both tiers route to the same variants). Upgrade to 8 variants in Phase 3. This allows Phase 1 research quality to be evaluated before the messaging agent is touched.

**Recommendation:** Option B. Phase 1 tests research quality in isolation. Phase 3 adds tier-specific messaging once research tier classification is verified accurate.

---

**Decision 9 — Rate limiting strategy for parallel source collection**

The v1 agent uses a 1-second delay between batch calls. v2 runs 4 sources in parallel per prospect. At batch scale this could hit simultaneous rate limits on multiple APIs.

The question is whether parallel-per-prospect (all 4 sources for one prospect at once) creates problems, and whether the inter-prospect delay needs to increase.

This is a low-stakes technical decision that can be tuned at test time. Flagging here so it is not forgotten.

---

**Decision 10 — Do existing v1 prospects need re-research on launch?**

When v2 is deployed, the `prospects` table contains rows from v1 research (or no research at all, due to the Apollo 403 blocker). Options:

Option A: Re-run v2 research on all existing prospects. Correct data; more thorough; takes time.

Option B: Leave existing v1 research results in place. New prospects get v2 research. Old prospects get v2 research only if re-engagement triggers a re-run.

Given that client zero (MargenticOS's own campaign) is the first live use and the prospect list is not yet finalised, the practical answer is: run v2 research on the final prospect list from scratch. There is no legacy data to preserve.

---

## 5. Phased Build Plan with Estimates

### Dependencies and blockers

Before any phase can be fully tested end-to-end:
- **Apollo Basic** must be activated ($49/month) — unblocks Apollo source handler
- **Throwaway LinkedIn account** must be created and aged 1-2 weeks — unblocks LinkedIn source handler
- **stickerdaniel/linkedin-mcp-server** must be installed — plus architectural decision on runtime delivery (Decision 4)

Phase 1 can be built and tested without either blocker (website + web search sources work now). Phase 2 is fully blocked until both are resolved.

---

### Phase 1 — Foundation rewrite (no new data sources)
**Builds:** New types, database schema, website + web search sources, synthesis step, main agent, compose-sequence update.
**Result:** A working v2 agent using only website and web search sources. Produces real tier classifications. Synthesis prompt is live and tunable. Phase 1 is deployable and testable with Doug's own prospect list.

| Task | Estimate |
|------|----------|
| Define new types (research/types.ts) | 30 min |
| Database migration + RLS (new table + new prospects columns) | 1.5 hrs |
| Website source handler (user-agent + Jina fallback) | 2 hrs |
| Web search source handler (Brave + Anthropic native, two-pass) | 1.5 hrs |
| Synthesize.ts with initial synthesis prompt | 3 hrs |
| Qualify.ts (deterministic pre-screen + post-synthesis rules) | 1 hr |
| Main agent entry point (orchestration, parallel collection, store) | 2 hrs |
| Update compose-sequence.ts (read research_tier, use trigger_text from new table) | 1.5 hrs |
| Update test file, run end-to-end, verify storage | 1 hr |
| Update docs | 1 hr |
| **Phase 1 total** | **~15 hrs / 2 days** |

---

### Phase 2 — New data sources (blocked on infrastructure)
**Builds:** LinkedIn source handler, Apollo source handler. Integrates both into the parallel collection step.
**Unblocked by:** Apollo Basic activation + throwaway LinkedIn account aged + Decision 4 resolved (LinkedIn MCP runtime architecture).

| Task | Estimate |
|------|----------|
| Apollo source handler (extracted from v1, enhanced for new output shape) | 2 hrs |
| LinkedIn source handler (implementation depends on Decision 4) | 3 hrs |
| Integrate both into parallel collection, test with real data | 2 hrs |
| **Phase 2 total** | **~7 hrs / 1 day** |

These tasks can be coded during the Phase 1 window (handlers can be built and unit-tested without live credentials). Integration testing happens once the blockers clear.

---

### Phase 3 — 8-variant messaging
**Builds:** Expanded messaging agent (8 variants, tier-specific opening instructions), updated compose-sequence routing.
**Depends on:** Phase 1 deployed and verified — need confidence in tier classification before building tier-specific messaging.

| Task | Estimate |
|------|----------|
| Expand messaging agent to generate 8 variants | 3 hrs |
| Tier-specific opening angle instructions (4 Tier 1 + 4 Tier 3) | 1.5 hrs |
| Update validator for both tier types | 1 hr |
| Update compose-sequence routing (select correct tier variant set) | 1 hr |
| Test end-to-end: Tier 1 prospect gets Tier 1 variant, Tier 3 gets Tier 3 | 1 hr |
| **Phase 3 total** | **~7.5 hrs / 1 day** |

---

### Phase 4 — QA and self-improvement infrastructure
**Builds:** QA feedback table, spot-check workflow in operator dashboard, synthesis prompt documented as explicitly editable config.
**Depends on:** Phase 1 running with real data so there is something to QA.

| Task | Estimate |
|------|----------|
| `research_qa_feedback` table + RLS + migration | 1 hr |
| Synthesis prompt extracted to editable TypeScript config file (already designed above) | 30 min |
| Operator dashboard: research results view with tier badges, flagged filter | 2 hrs |
| Operator dashboard: QA feedback form on each research result | 1.5 hrs |
| Update docs | 1 hr |
| **Phase 4 total** | **~6 hrs / 1 day** |

---

### Total estimate

| Phase | Estimate | Blocker |
|-------|----------|---------|
| Phase 1 — Foundation | ~15 hrs / 2 days | None — start immediately |
| Phase 2 — New sources | ~7 hrs / 1 day | Apollo Basic + LinkedIn account + Decision 4 |
| Phase 3 — 8-variant messaging | ~7.5 hrs / 1 day | Phase 1 verified |
| Phase 4 — QA infrastructure | ~6 hrs / 1 day | Phase 1 live with real data |
| **Total** | **~35.5 hrs / 5–6 days** | |

This is focused coding time. With Claude Code, expect 3–4 actual calendar days for Phase 1 + 3 combined once infrastructure blockers clear.

---

### Recommended sequence

1. **Now:** Resolve Decisions 1–5 (model, flagged UI, disqualified retention, LinkedIn runtime, prompt editability). Resolve Decision 4 first — it determines what the LinkedIn source handler looks like.
2. **Phase 1:** Build and dogfood with Doug's own MargenticOS prospect list. Tune synthesis prompt through spot-checks.
3. **While Phase 1 runs:** Activate Apollo Basic. Create LinkedIn throwaway account and let it age.
4. **Phase 2:** Integrate Apollo and LinkedIn once both are available. Re-run research on the live prospect list.
5. **Phase 3:** Expand messaging agent to 8 variants once tier classification is confirmed accurate.
6. **Phase 4:** Add QA infrastructure as the weekly review cycle becomes a real habit.

---

*End of scope document.*
*Next step: resolve the 10 decisions in Section 4, then begin Phase 1.*
