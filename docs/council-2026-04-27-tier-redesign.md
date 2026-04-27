# Council: April 27, 2026

## Original question

What output schema should a B2B cold outbound prospect research agent produce per prospect?

Context: MargenticOS prospect research agent. Current `research_tier` field collapsed ICP fit quality and signal availability into one label. A 10-prospect dogfood batch on hand-curated ICP-fit prospects returned 10/10 tier3. Two downstream consumers: email composition layer (bridge sentence vs. ICP-pain opening) and operator prioritisation (push hard / deprioritise / skip). Current schema: research_tier (tier1/tier3), qualification_status (qualified/flagged/disqualified), confidence.

## Framed question

Core decision: The prospect research agent produces a single `research_tier` field that conflates two distinct dimensions: (1) how well the prospect fits the ICP, and (2) whether a specific dateable signal exists for composition personalization. This collapsed two orthogonal things into one label, making it useless for operator prioritization. What schema should replace it?

User context: MargenticOS runs AI-powered cold outbound for founder-led B2B consulting firms. Operator (Doug) manages campaigns on behalf of clients at 200 prospects/client/week across 5+ clients. The research agent pulls from LinkedIn (Apify), company website, web search, and Apollo enrichment, then a Sonnet 4.6 synthesis call produces a single classification per prospect. Two downstream consumers: (a) the email composition layer branches on the classification — "bridge sentence" referencing a dateable observation, or thematic ICP-pain opening; (b) the operator reviews in CSV/dashboard to prioritize: push hard, deprioritize, or skip. Current schema: research_tier (tier1/tier3), qualification_status (qualified/flagged/disqualified), confidence. The problem: a 10-prospect dogfood batch of hand-curated ICP-fit prospects all returned tier3. Reasoning chains showed excellent ICP fit + no recent post = same classification as weak ICP fit + irrelevant post. The tier axis collapsed prospect quality and signal availability.

Workspace context: The tier1 composition path (bridge generation) has never executed on real data — all 10 dogfood results were tier3. The trigger_data column is already overloaded (synthesis output overwrites seed metadata); any new schema must not compound this. The synthesis prompt is the sole tuning surface — schema must be expressible as prose rules an LLM can follow.

Stakes: Schema changes require synchronized DB migration + prompt rewrite + composition layer update. At 200 prospects/client/week × 5+ clients, this schema is the primary artifact determining operator workload and email quality for ~1,000+ prospects/week. Wrong schema = operator drowns in undifferentiated output, or wrong email opening for a material fraction of sends.

Specific questions: (1) What dimensions should the schema capture, and at what granularity? (2) What edge cases break your proposed structure? (3) Should qualification_status remain separate, fold in, or be restructured?

## Workspace context used

- `docs/prospect-research-agent-v2-state.md`: Tier 1 requires specific dateable observation; Tier 3 is honest ICP pain framing. Value prop alignment filter. Tier 1 composition path untested on real data.
- `docs/BACKLOG.md`: [pre-c0] Tier 1 composition path untested entry (2026-04-27). [research] trigger_data column overloaded entry (2026-04-27).

---

## Round 1: Advisor responses (raw, de-anonymized)

### The Contrarian

The load-bearing assumption nobody is examining: the LLM can reliably classify two orthogonal dimensions simultaneously in a single synthesis call, at production volume, with acceptable consistency.

It cannot. Here is the specific failure mechanism.

You are asking Sonnet 4.6 with extended thinking to produce, in one pass: ICP fit score, signal availability flag, signal recency, signal specificity, and qualification status. Each dimension has its own ambiguity surface. ICP fit requires interpreting company context against a client-specific ICP document that varies across 5+ clients. Signal availability requires distinguishing "recent dateable post" from "old post" from "no post" from "post that exists but is generic." These interact. A model that finds a weak signal in an otherwise strong-fit prospect has to hold both evaluations independently and output them cleanly. At 1,000+ prospects per week, the tail behavior — the 8% of outputs where the model conflates dimensions, hallucinates recency, or applies the wrong client's ICP frame — is not a footnote. It is 80 wrong classifications per week becoming wrong emails or wrong operator decisions.

The deeper problem: you have zero calibration data. The tier1 path has never run on real data. You are redesigning a schema to feed a composition path whose failure modes are entirely theoretical. You do not know whether bridge sentences generated from tier1 signals actually perform better. You are adding schema complexity to serve a downstream consumer whose value is unproven.

The proposal to add `icp_fit_score` alongside `signal_tier` doubles the LLM output surface before you have validated that the existing single-dimension output is reliable enough to build on.

Validate tier1 end-to-end on 20 real prospects first. Then redesign the schema around observed failure modes, not anticipated ones.

### The First Principles Thinker

The surface question is wrong. You are not asking "what schema should replace this?" You are asking "how do I fix a schema that is lying to me?" Those are different problems.

The premise buried in your framing: the research agent should produce a classification. Test that premise. A classification is a compression. You are compressing two orthogonal signals into one label, noticing the compression loses information, and proposing to fix it with a more sophisticated compression. That is not a fix. That is a slower collapse.

The question you should be asking: what are the two raw facts downstream consumers actually need, and why is the agent classifying instead of reporting?

Downstream consumer A (composition layer) needs one binary: does a dateable observation exist, yes or no. Not a tier. Not a quality score. A boolean and the observation text.

Downstream consumer B (operator review) needs one thing: is this prospect worth the send. That is ICP fit, which you already have in qualification_status.

The schema that survives first principles scrutiny: keep qualification_status as-is. Add has_dateable_signal (boolean) and signal_observation (text, nullable). Delete research_tier entirely.

Now test this against your fatal workspace constraint: the tier1 composition path has never run on real data. This schema makes that irrelevant. The composition layer does not branch on a tier — it branches on a boolean the LLM is reporting, not classifying. Reporting is harder to hallucinate than classification because there is no judgment call involved. Either a post from last week exists or it does not.

The overloaded trigger_data problem is separate and stays separate. Do not solve it here.

### The Expansionist

The collapsed tier schema is not just a classification bug — it is a missed data asset.

Every prospect the research agent touches produces a reasoning chain: ICP fit signals, company context, recency of activity, topic relevance. Right now that reasoning is discarded after producing a single label. That is the waste. The schema question is actually a data capture question in disguise.

The two-axis split (fit quality + signal availability) is correct and necessary, but stop there and you are still thinking small. The real upside is a third field: `signal_topic`. Not just "dateable signal exists" but what category it falls into — hiring, funding, leadership change, content theme, product launch. Even a coarse taxonomy (4–5 buckets) transforms the composition layer from a binary branch into a routing table. Different signal topics warrant different bridge sentence templates. That is composition quality at scale, not just composition availability.

The operator workload upside is equally concrete. An `icp_fit_score` (strong/moderate/weak) plus a `signal_type` field gives Doug a two-axis sort on the CSV. Strong fit + hiring signal = top of stack, write first, push hardest. Weak fit + no signal = skip. That is a decision support tool, not just a classification. The current schema forces Doug to open every reasoning chain to make that call. Two sortable fields eliminates that entirely.

One specific consequence worth naming: when tier1 composition finally executes on real data, you will immediately want to know which signal topics produce the highest reply rates. If `signal_topic` is not in the schema from day one, that analysis requires a retroactive data backfill across 10,000+ prospect rows.

Capture the topic now. The cost is one more LLM output field. The return is a performance feedback loop that currently does not exist.

### The Outsider

Reading this cold, two things are invisible to you that would confuse anyone without your history:

"Tier1" and "Tier3" are meaningless labels to a first reader. You skipped tier2. That is not explained anywhere. A stranger assumes a typo or a deleted middle option. If this schema surfaces in any dashboard, CSV export, or operator-facing UI, those labels carry zero intuitive meaning.

The deeper problem, stated plainly: you built one field to answer two questions, noticed it fails both, and are now asking what two fields should replace it. That is the right instinct. But the framing of this question is still entangled. You are asking "what dimensions should the schema capture" when the answer is already in your own problem statement — ICP fit and signal availability are the two dimensions. The question you actually need answered is: what are the valid values for each, and what rule decides them?

The fatal flaw no one else may say directly: you have a classification system where the LLM controls every label, the tier1 path has never run on real data, and you are considering adding more output dimensions before fixing that. Every new field is a new axis an LLM must produce correctly at 1,000+ prospects per week with no deterministic fallback. Schema complexity compounds hallucination surface. The right sequence is: reduce to two explicit boolean or binary fields, run real volume, verify the LLM gets both right consistently, then discuss granularity. Do not design a five-dimension schema for a system whose simplest path has never executed once.

### The Executor

The tier1 path has never run on real data. That is the only fact that matters right now.

Do not redesign the schema before you know what the composition layer actually needs from it. You are solving a downstream consumer problem you have not yet observed.

Monday morning: Ship a two-field split — `icp_fit` (strong/weak/disqualified) and `signal_available` (yes/no) — as a direct replacement for `research_tier`. Nothing else changes. No new columns. One migration, one prompt tweak, one composition branch update. The composition layer already branches; give it two clean booleans instead of one overloaded string.

Then run 20 prospects through it. Look at what actually comes back for `signal_available = yes`. Check whether the bridge sentences the composition layer generates are any good. That is your real validation gate — not whether the schema feels correct in the abstract.

The fatal flaw in every richer schema proposal: the LLM controls classification. Every field you add is another axis it must get right at 1,000+ prospects/week with no deterministic fallback. Two fields is the maximum surface area you can trust right now.

Do not touch `qualification_status`. It is doing separate work. Do not merge it.

Do not add `signal_type`, `signal_date`, `signal_recency`, or any other enrichment field until the two-field version has run on at least one real client batch and the tier1 path has actually executed. Any schema that is "ready for future signal types" before the current signal type has ever fired is speculative complexity you will regret.

Ship the minimum. Run it. Read the output. Then ask the schema question again.

---

## Anonymization map

Session timestamp: `1777312328` · permutation index: `8`

| Advisor | Letter shown to reviewers |
|---|---|
| Contrarian | A |
| First Principles Thinker | D |
| Expansionist | B |
| Outsider | C |
| Executor | E |

---

## Round 2: Peer reviews (reviewers saw only the anonymized A to E responses)

### Reviewer 1

**Strongest: E.** The only response that gives a concrete, shippable answer with an explicit validation gate tied to real operational constraints. It names the minimum viable schema, tells you exactly when to revisit it, and refuses to let schema aesthetics substitute for evidence.

**Biggest blind spot: B.** B argues for capturing `signal_topic` to enable future reply-rate analysis, but never addresses who validates that the LLM's topic classification is correct. At 1,000+ prospects/week, a miscategorized topic silently corrupts the performance feedback loop B is most excited about. The whole case for the field depends on data quality B doesn't examine.

**What all five missed:** The synthesis call runs once per prospect and the output is stored. None of the responses asked: what happens when the stored classification is stale? A prospect classified six weeks ago as "no dateable signal" may have published a relevant post last week. None of the five addressed classification TTL or re-enrichment triggers. At 200 prospects/client/week with multi-week sequences, a substantial fraction of stored classifications will be wrong not because the LLM failed, but because time passed. The schema needs either a `classified_at` timestamp or a recheck policy, and nobody mentioned it.

### Reviewer 2

**Strongest: E.** Gives a concrete Monday-morning action, names the validation gate (are the bridge sentences any good), holds the line on schema simplicity with a specific argument (every field = another LLM axis), and correctly separates qualification_status. It is the only response that converts the analysis into an executable next step with a verification criterion.

**Biggest blind spot: B.** B argues for adding `signal_topic` to enable future reply-rate analysis, but never addresses whether the LLM can reliably produce a consistent 4–5 bucket taxonomy at volume with no deterministic fallback. It treats data capture as free. It is not. B is recommending schema complexity on the basis of a downstream analytics use case that requires accurate classification to be worth anything — and the entire premise of the question is that the LLM is already failing at a simpler classification task.

**What all five missed:** The prompt is the sole tuning surface, but nobody asked who owns prompt consistency across 5+ clients with different ICP documents. If the synthesis call must evaluate ICP fit, it needs the client's ICP document injected at runtime. None of the responses addressed whether that injection is happening correctly now, or whether the all-tier3 batch result is a schema problem at all versus a missing-context-at-inference problem.

### Reviewer 3

**Strongest: E.** Gives a concrete, executable recommendation (exact field names, valid values, migration scope), names the real validation gate (are bridge sentences any good), and holds the line against premature complexity with a falsifiable sequencing logic. D is close but stops short of a concrete schema.

**Biggest blind spot: B.** B correctly identifies `signal_topic` as a valuable future field, but never addresses the core reliability problem: the LLM must now produce a third output axis correctly at volume before the first two axes have ever been validated. B's "capture the topic now" recommendation actively contradicts the workspace constraint it never engages with. It treats schema richness as free.

**What all five missed:** The synthesis prompt is the sole tuning surface, but none of the responses examined what makes the two-field schema actually LLM-reliable. Specifically: `has_dateable_signal` / `signal_available` is only as good as the prompt's definition of "dateable." None defined it. What counts? A LinkedIn post from 30 days ago? 90? A funding round from 6 months ago? Without a concrete recency threshold baked into the prompt rules, the LLM will apply inconsistent judgment and the boolean becomes as noisy as the tier label it replaced. The schema is incomplete without the prompt definition of its own terms.

### Reviewer 4

**Strongest: E.** Names the validation gate correctly, prescribes the minimum viable schema change, and gives a concrete next action. D is close but deletes `research_tier` without acknowledging the composition layer already depends on it in production code that needs to keep working.

**Biggest blind spot: B.** B advocates for `signal_topic` as a routing table for composition templates — but those templates don't exist yet. The entire argument for capturing topic now rests on a feedback loop that requires both a functioning tier1 path and multi-week reply data. B is designing infrastructure for a signal-to-performance correlation engine before a single bridge sentence has sent. It should have acknowledged this sequence problem directly.

**What all five missed:** The synthesis prompt is the sole tuning surface — but none of the advisors asked who wrote the current prompt and whether it explicitly instructs the LLM to treat ICP fit and signal availability as independent axes. The schema redesign is irrelevant if the prompt still conflates them. A prompt that says "classify as tier1 if strong fit AND dateable signal" will produce the same collapse on any schema. The first fix is a prompt audit, not a migration. Schema and prompt must be redesigned together or the new fields inherit the old failure mode.

### Reviewer 5

**Strongest: E.** Gives the most operationally executable answer: a specific two-field replacement, a concrete validation gate (20 prospects, check bridge sentence quality), and clear deferral rules for every tempting addition. D makes the same core argument more elegantly but stops before telling Doug what to actually do Monday morning.

**Biggest blind spot: B.** B advocates for `signal_topic` as a composition routing table and retroactive analysis enabler, but never addresses whether the LLM can produce a consistent taxonomy reliably. At 1,000+ prospects/week with no deterministic fallback, adding a coarse-bucket classifier before the binary signal path has ever fired is exactly the speculative complexity the other responses warn against. B identifies a real future value without acknowledging the precondition that must be true first.

**What all five missed:** The synthesis call is the wrong place to make this judgment at all. LinkedIn activity recency is deterministic data — a post date is a date. The LLM should not be classifying whether a dateable signal exists; a pre-synthesis deterministic step should check for source data recency and set `has_dateable_signal` before the LLM ever runs. This removes the most hallucination-prone output field from LLM control entirely and leaves synthesis to do what only LLMs can: interpret fit. Nobody said this.

---

## Chairman synthesis

### Where the council agrees

- All five advisors: Replace the single `research_tier` with two independent fields — one for ICP fit quality, one for signal availability. The conflation is the root problem.
- Contrarian, Outsider, Executor: LLM output surface must stay minimal until the tier1 path has actually executed on real data. Schema complexity compounds hallucination risk at 1,000+ prospects/week.
- First Principles, Executor, Outsider: Keep `qualification_status` as a separate, independent field. It is doing different work and merging it would create a new conflation.
- First Principles, Executor: Signal availability is best expressed as a binary (boolean + text observation), not a scored classification — reducing LLM judgment surface.

### Where the council clashes

- **Expansionist vs. Executor on `signal_topic` timing:** Expansionist argues capture signal topic now or face a 10,000+ row retroactive backfill. Executor argues speculative complexity before the basic path has ever fired. A sequencing bet, not a logical disagreement.
- **Contrarian vs. the rest on timing:** Contrarian says redesign feeds an unvalidated downstream consumer. All others proceed regardless. Contrarian position is correct as discipline but cannot hold a broken schema in place indefinitely.
- **First Principles vs. Executor on fit field structure:** First Principles says keep `qualification_status` as the fit signal and add only `has_dateable_signal` (boolean) + `signal_observation` (text). Executor says add an explicit `icp_fit` (strong/weak/disqualified) field. The question: does `qualification_status` already capture fit adequately?

### Blind spots the council caught

- **"Dateable" is undefined:** Without a concrete recency threshold in the prompt (30 days? 90?), the `has_dateable_signal` boolean inherits the same LLM variance as the tier label it replaces. The schema change is cosmetic unless the prompt specifies what "dateable" means in measurable terms.
- **Signal availability is deterministic data, not a judgment:** A post date is a date. A deterministic pre-synthesis step should check source timestamps and set `has_dateable_signal` before the LLM runs — removing the most hallucination-prone output from LLM control entirely.
- **The all-tier3 result may not be a schema problem:** The 10/10 tier3 dogfood result might indicate the synthesis prompt was not receiving the client's ICP document at inference. If so, the fix is a prompt change, not a migration. Verify root cause before writing any migration.
- **Classification staleness:** A stored classification ages. The schema needs a `classified_at` timestamp and a recheck policy for multi-week sequences.

### The recommendation

Replace `research_tier` with two fields: `icp_fit` (strong/moderate/weak) and `has_dateable_signal` (boolean) plus `signal_observation` (text, nullable). Delete `research_tier`. Keep `qualification_status` as-is. Do not add `signal_topic` yet. Critically: `has_dateable_signal` should be set by a deterministic pre-synthesis check on source data timestamps, not by the LLM — removing the most failure-prone classification from LLM control entirely and leaving synthesis to handle only what requires judgment. But verify root cause of the all-tier3 dogfood result before writing any migration.

### The one thing to do first

Before writing any migration, open the synthesis prompt and confirm the client's ICP document is being injected at runtime — because if the all-tier3 dogfood result was context starvation rather than schema collapse, the fix is a one-line prompt change, not a DB migration.
