# Prospect Research Agent v2 — Current State

Last updated: April 24 2026.

## Summary

Phase 1 complete. Production-ready for client zero scale (50–500 prospects per batch). Not yet tested on real dogfood data.

## Key files

- `src/agents/research/synthesize.ts` — Sonnet-powered synthesis with value prop alignment filter
- `src/agents/research/synthesis-prompt.ts` — Full prompt with examples (Garrett, Bruce, Rich)
- `src/lib/agents/tools/` — Source handlers (Apify LinkedIn, Apollo, Brave+Anthropic web search, website fetcher with Jina.ai fallback)
- `src/lib/agents/prospect-research-agent-v2.ts` — Batch orchestrator with parallelism
- `src/lib/style/customer-facing-style-rules.ts` — Shared style enforcement (em dashes, AI tells)
- `src/lib/composition/compose-sequence.ts` — Composition with bridge + personalized CTA
- `src/lib/composition/personalize.ts` — Haiku-powered bridge + CTA generator

## Key architectural decisions

- Per-client config, never hardcoded to MargenticOS. Synthesis reads client positioning at runtime.
- Tier 1 requires a specific dateable observation; Tier 3 is honest ICP pain framing, never fake personalization.
- Value prop alignment filter — signals about a prospect's clients (wrong audience) do not qualify for Tier 1.
- Parallelism at concurrency=5 (per-provider limits respected).
- LinkedIn via Apify (no account needed, $4–13/month at scale).
- Shared style module enforces no em dashes, no AI tells across all customer-facing agents.

## Tests verified clean April 24

- Ginny research result: Tier 3 classification with honest framing, no fallbacks triggered.
- All 5 pre-flight bug fixes committed and tested:
  - Bug 2A: `max_tokens` 1500→3000 (synthesis was hitting ceiling mid-reasoning)
  - Bug 2B: web search `limited` gate removed (thin-but-real results now reach synthesis)
  - Bug 2C: `buildTier3TriggerText()` grammar fixed (gerund/modal-negative/noun phrase detection)
  - Bug 8A: CSV FK disambiguation fixed (`prospects!prospect_id` to resolve ambiguous join)
  - Bug 6: `HAIKU_PERSONALIZATION_USD` added to cost estimate (was running 12–25% low)
- 36 commits pushed to main.

## Not yet tested on real data

- Tier 1 composition path (bridge generation + CTA)
- Parallelism at >5 prospects
- Full dogfood batch with diverse prospects

## Dogfood batch 1 prepped

- 11 real founder-led consulting firm prospects compiled in `dogfood-prospects-batch-1.csv` (project root)
- Pending Doug review and DB seeding

---

## Copy-quality rubric added (2026-08-19)

### What changed and why

The six tests (SPECIFIC, VERIFIABLE, INFERENTIAL, RELEVANT, USEFUL, NON_JUDGEMENTAL) all ask
whether an observation is TRUE and RELEVANT. None asked whether it was READABLE. This trigger
scored 6 out of 6 and shipped:

> "Running Taffet alongside the CRC Director engagement from mid-2024 through mid-2025 is a
> particular kind of balancing act, and with that role now wrapped, the pipeline question for
> Taffet tends to land differently."

37 words in one sentence, two hedges, ending on an abstraction. The messaging document was NOT
the source: it scores 1.4 percent nominalisation across all 716 words. Every bad line traced
back to this agent, which writes the observation that fills the Email 1 P2 slot.

### Four changes

1. READABLE is now a seventh scored test in the prompt, with four questions (say it aloud,
   picture test, buyer vocabulary, any other email), a 25-word sentence cap, a no-hedging rule,
   and both real examples included verbatim and labelled: the failing one above and the
   benchmark from a campaign that replied at 7 percent.

2. `src/lib/style/readability.ts` measures it deterministically. Sentence length and hedge
   phrases HARD-GATE hook selection because both are unambiguous. Nominalisation density
   (reusing `src/lib/style/nominalisation.ts`) only ever adds demerits, because suffix matching
   cannot tell "attention" from "question" and a hard gate on a check with known false
   positives would reject good copy.

3. `src/lib/style/sentence-frames.ts` detects repeated sentence frames ACROSS a batch. The tic
   ("is a particular kind of balancing act" / "juggle") came from the prompt itself, which
   handed the model that exact frame as a worked GOOD example. That example is deleted and
   stock frames are banned outright. Detection masks names and numbers, then compares 5-gram
   skeletons, so a template is caught even when every noun is swapped.

4. Inference direction is a distinct gate, not a tightened test. Every candidate must state the
   opposite reading of its own evidence. Where both readings are plausible, the observation must
   be phrased compatibly with both, or it is demoted out of hook use.

### What happens on a failure

A demoted candidate does not vanish. It falls from Tier 1 to `mention_only`, so the fact still
surfaces and is still stored, it just does not fill the P2 slot. Composition falls back to ICP
pain framing, which is good copy. `compose-sequence.ts:756` gates the bridge path on
`signal_relevance === 'use_as_hook'`, so demotion is the lever that stops bad copy shipping.

Frame collisions are logged and reported in `ResearchBatchSummary.frame_collisions`. They do
not trigger an automatic rewrite: see BACKLOG.md.

### Verification, 2026-08-19

Re-ran all three dogfood prospects (org 0ed34697-0fa9-4f08-ac15-d3504ac45caf) on commit be1bcb6.

| Prospect | Winning trigger | Max sentence | Hedges | Frame collision |
|---|---|---|---|---|
| Robert | "You ran Taffet and the CRC Director role side by side for 13 months. That wrapped in August 2025." | 14 words | none | none |
| Udo | "Bröskamp, Schumpeter Ventures, and FineVest have all been running under your name at the same time since 2023. Most founders at that stage find Bröskamp's pipeline gets whatever bandwidth is left." | 18 words | none | none |
| Alma | "Full Bloom has been running since September 2023. You've held a full-time Stanford GSB role alongside it since January 2024." | 12 words | none | none |

The CRC concurrent-role fact still surfaces as Robert's c1 winner, as required: what changed is
how it is written, not what is found. The readability gate visibly fired on three candidates
(Robert c4 at 29 words, Udo c4 at 30 words, Alma c5 at 34 words), all demoted out of hook use.

Re-run harness: `src/lib/agents/rerun-three-prospects.ts`. It costs real API spend per run.


---

## Callable from the application (2026-08-20)

### What changed

The agent had one caller in the repository: `src/lib/agents/run-dogfood-batch-2.ts`,
hardcoded to organisation `74243c62` and eleven prospect ids. A search of `src/app` found
nothing. So the live 15-prospect batch was not reproducible from the repository, and a
client could not be onboarded without hand-running a script. Writing a throwaway script per
batch is also what cost 22 USD in redundant research on 2026-08-20.

Research is now started from `/dashboard/operator/sourcing-review`, or from
`scripts/run-research.ts`, both through one shared entry point:
`src/lib/operator/research-batch-entry.ts`. Full documentation is in `docs/agents.md` under
"Pipeline entry points". `run-dogfood-batch-2.ts` is deleted.

`rerun-three-prospects.ts` is still the re-run harness referenced above, and still costs real
API spend per run, but it no longer hardcodes the organisation or the prospect ids:

    npx tsx --env-file=.env.local src/lib/agents/rerun-three-prospects.ts \
      --org <uuid> --ids <uuid>,<uuid>,<uuid>

It calls the agent directly and therefore has NO overwrite guard. Do not point it at
prospects whose copy has already been sent.

### The thing to know before running any batch

`updateProspect` writes `personalisation_trigger` and `personalisation_question` on every
run. On a SEND verdict it replaces the stored opening with new wording. On a HOLD verdict it
writes NULL, deleting it. Of the 15 researched prospects in the client-zero organisation, 12
hold a trigger and 3 hold NULL, so the HOLD path is not rare.

The entry point refuses any batch containing a prospect that already holds a trigger, unless
the caller passes `allow_overwrite_trigger`. The dashboard cannot pass it and does not read
it from the request body. Only `scripts/run-research.ts --allow-overwrite-trigger` can.

### Reuse is not free

`use_stored_findings: true` skips all four sources and the Sonnet synthesis call, but the
writer, the floor check and the judge still run on `claude-sonnet-4-6`. Roughly 0.05 to 0.06
USD per prospect, measured across 156 reuse runs on 2026-08-20. Reuse also does not guarantee
that a prospect skips its sources: one with nothing usable on file falls back to a full
fetching run, which is why the entry point counts the real mix before admitting a batch.

### Verified 2026-08-20, on one prospect

The acceptance run on the 15 client-zero prospects was cancelled: a run would rewrite the
openings that are about to be sent. Verified instead on one prospect
(`63ea6c82`, `newperson@example.com`) in the DRY RUN TEST org, unarchived for the run and
reverted byte-for-byte afterwards.

| Check | Result |
|---|---|
| Selected | 1 of 1, the only live prospect |
| Duration | 29.2s against a 47s estimate |
| Result row | `c0f35d3a` written, 4 sources attempted, 0 successful |
| Prospect update | `current_research_result_id` points at the new row, `research_ran_at` and `classified_at` stamped, `trigger_data` written |
| Judge | HOLD, so `personalisation_trigger` and `personalisation_question` are both NULL |
| Other prospects | zero rows written |
| Cost | 0.03 USD |

The HOLD is the correct outcome. The fixture has no name, no company and a fake email, so
synthesis returned zero candidates and the writer had nothing to work with. Composition would
fall back to the variant's authored opener, which is approved copy.

Not proven by this run: the browser-to-route hop. The routes' auth gate is verified separately
(403 without a session), and the route calls the same shared entry point, so what remains
untested is the route's JSON body parsing.
