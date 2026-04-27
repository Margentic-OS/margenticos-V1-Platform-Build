# Session Handoff — 2026-04-27: Tier Model Redesign

## What changed

`research_tier` ('tier1'/'tier3') dropped from `prospects` and
`prospect_research_results`. Replaced with five independent fields:

| Field | Type | Where | Set by |
|---|---|---|---|
| `icp_fit` | text ('strong'/'moderate'/'weak') | both tables | LLM |
| `has_dateable_signal` | boolean | both tables | deterministic pre-synthesis check |
| `signal_observation` | text nullable | both tables | deterministic pre-synthesis check |
| `signal_relevance` | text ('use_as_hook'/'ignore') | both tables | LLM |
| `classified_at` | timestamptz | prospects only | agent on write |

Council verdict document: `docs/council-2026-04-27-tier-redesign.md`

---

## Migration sequence

**Step 1 — Schema** (Supabase MCP, no git SHA for DDL)
Two migrations applied directly:
- Drop `research_tier`, add `icp_fit`, `has_dateable_signal`, `signal_observation`, `classified_at`
- Add `signal_relevance` to both tables (added mid-step-3 when compose-sequence gap identified)
- TypeScript Database types: `ce6a3e5`

**Step 2 — Prompt + synthesize** `9762784`
- `synthesis-prompt.ts`: replaced TIER CRITERIA with ICP FIT ASSESSMENT + SIGNAL DIMENSION sections; output JSON schema updated; all role-specific examples replaced with structural placeholders; ICP-agnostic throughout
- `synthesize.ts`: new `detectRecencySignal()` deterministic check runs before LLM; `tovRules` object-coercion bug fixed; `parseSynthesisResponse()` and fallback rewritten for new schema
- `types.ts`: `IcpFit`, `SignalRelevance` types added; `SynthesisOutput` and `ResearchResult` updated

**Step 3 — Orchestrator + composition + test runner** `a6d5120`
- `prospect-research-agent-v2.ts`: all `research_tier` writes replaced; `storeResearchResult` and `updateProspect` updated
- `compose-sequence.ts`: `ProspectRow` interface updated; bridge gate rewritten (see below)
- `test-prospect-research-run.ts`: console output and DB verification selects updated

**Step 4 — Export CSV** `4fe4806`
- `export-csv.ts`: 14-column schema; `qualification_reason` added (was missing); `trigger_source_type` dropped

**Tidy** `e216507`
- Removed `ResearchTier` dead type, unused `IcpFit`/`SignalRelevance` imports, `mapToV1ResearchSource` shim, dead trigger_source print block

---

## Deterministic recency check architecture

Runs in `detectRecencySignal()` in `synthesize.ts` before the LLM call.

**Source priority:**
1. LinkedIn posts (Apify): reads `post.postedAt.date` (ISO string nested in object) or `post.postedAt.timestamp`. Window: **60 days**. Any post within window → `has_dateable_signal=true`.
2. Web search / website text: regex extracts ISO dates (`2025-YYYY-MM-DD`) and Month+Year patterns. Gated on content keywords (podcast, episode, article, published, etc.). Window: **180 days**.

**Threshold note:** 60d and 180d are hardcoded constants. Flagged for per-client config — BACKLOG when client settings UI is built.

**Liberal by design:** if LinkedIn returns a post with no parseable date, treated as recent and passed to LLM. `signal_relevance` is the quality gate, not `has_dateable_signal`.

Confirmed Apify post shape (2026-04-27): `post.postedAt = { date: "ISO", timestamp: ms }`, `post.content = plain text`.

---

## Composition gate logic

In `compose-sequence.ts` `applyPersonalization()`:

```typescript
const useBridgePath = prospect.has_dateable_signal === true
                   && prospect.signal_relevance === 'use_as_hook'
const tier = useBridgePath ? 'tier1' : 'tier3'
```

Bridge sentence inserted only when both true AND word count fits within 81-word headroom.
ICP-pain framing path runs for all other combinations (no signal, signal rejected, signal found but LLM said ignore).

---

## Bug fixes shipped this session

| Bug | Fix | Commit |
|---|---|---|
| `tovRules` rendered as `[object Object]` — `writing_rules` is `object[]` not `string[]` | Extract `.rule` property via map in `loadClientContext` | `9762784` |
| UTF-16 surrogate crash in LinkedIn and website source slicing | Spread string to code points before slicing | `4a36031` |
| `website_url` null for all dogfood prospects | `website_url` seeded from CSV batch runner | `3003977` |

**Known unfixed (BACKLOG):** `formatPostsData` in `linkedin.ts:79` uses `post.postedAt` as scalar — dates render as `[object Object]` in the LLM's research view. Low severity (content still readable). Fix when next touching `linkedin.ts`.

---

## Dogfood batch 2 results

11/11 succeeded. Total cost: ~$0.32.

| Result | Count |
|---|---|
| `strong` / `use_as_hook` | 1 (Anya Dayson — LinkedIn post within 60d, passed both filter tests) |
| `moderate` / `ignore` | 9 |
| `moderate` / no dateable signal | 1 |

**Anya Dayson is the designated test case** for the composition layer end-to-end run when reply handling work begins. She is the only batch 2 prospect who will hit the bridge-sentence path.

---

## What is NOT yet tested

**Composition layer end-to-end with new schema.** The bridge + CTA generation path in `compose-sequence.ts` (the `tier1` / `use_as_hook` branch) has never executed against a real prospect under the new schema. `generatePersonalization()` behaviour on the bridge path is unverified. Anya Dayson is the test case.

---

## BACKLOG entries added today

| Tag | Title | Trigger |
|---|---|---|
| `[pre-c0]` | Tier 1 / use_as_hook composition path untested on real data | When reply handling work starts; Anya Dayson is the test case |
| `[monitor]` | Promote estimate-batch-cost.ts to a committed CLI | Before any batch over 50 prospects |
| `[research]` | trigger_data column overloaded — synthesis output overwrites seed metadata | Before any code reads trigger_data for non-synthesis purposes |
