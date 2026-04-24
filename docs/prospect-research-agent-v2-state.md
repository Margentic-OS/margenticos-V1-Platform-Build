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
