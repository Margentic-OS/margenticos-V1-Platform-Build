# PART 2 — Proof the prompt still works

## `npx tsc --noEmit`

Clean. `tsconfig.tsbuildinfo` deleted first, because the incremental cache reports a stale
pass.

## Full suite, with `.env.test.local`

```
Test Files  160 passed | 2 skipped (162)
     Tests  2435 passed | 2 expected fail | 2 skipped (2439)
  Duration  27.26s
```

**No failure to trace.** The 2 expected-fail are the two `it.fails` GOAL tests in
`prompt-names.test.ts` and `prompt-forbidden-content.test.ts`, red on purpose on `main` too,
and each records the state it is waiting for. Neither flipped to passing, which would itself
be a failure: `prompt-names` still has 6 unvouched tokens across other sources and
`prompt-forbidden-content` still has 34.

**One real failure was found and fixed during the work, and it was mine.** The measurement
script I wrote to read the scan counts lived at `scripts/measure-prompt-scans.ts` and
imported `prompt-forbidden-content.data.ts`. That tripped `no module outside this test
imports it`, a guard whose stated reason is that the deny list holds the exact banned
strings, so importing it into anything that assembles prompt text would inject the ban list
into a prompt. The guard scans all of `src/` and `scripts/`. Both measurement scripts were
moved out of the repository into the session scratchpad. The guard was right.

## `buildWriterPrompt` is still zero-argument and byte-identical across prospects

```
arity 0
system prompt sha256[0:16] per prospect: a0ce96a0d26c1c5d a0ce96a0d26c1c5d a0ce96a0d26c1c5d
all identical: true
assignment hashes (must differ): 24f8e29f1a19cced ce1cfa081942334d 5e0087f3a708e57b
leaks any per-prospect value: false
```

Three prospects with different client names, buyer titles, offer lines and CTAs. The system
prompt hashes identically for all three; the assignment blocks differ, which is where the
variation belongs. The cache prefix is intact.

## Token count

| | main | no-examples |
|---|---|---|
| chars | 45,355 | 32,830 |
| **tokens** | **11,054** | **7,984** |

**−3,070 tokens, −27.8%.** Live `messages.countTokens`, `claude-sonnet-4-6`, system prompt
plus a one-character user turn, measured the same way both times.

This prompt is sent up to three times per prospect on the retry path and is marked as a
cache breakpoint, so the saving is on the cache WRITE, not on every call.

## Both prompt scans, per source and total

### Forbidden content

| source | main | no-examples |
|---|---|---|
| docs/prompts/icp-agent.md | 9 | 9 |
| docs/prompts/positioning-agent.md | 4 | 4 |
| docs/prompts/tov-agent.md | 1 | 1 |
| docs/prompts/messaging-agent.md | 11 | 11 |
| docs/prompts/faq-extraction-agent.md | 2 | 2 |
| docs/prompts/reply-draft-agent.md | 3 | 3 |
| docs/prompts/shared-voice-spec.md | 0 | 0 |
| **write-opening.ts:buildWriterPrompt** | **1** | **0** |
| write-opening.ts:buildFloorPrompt | 0 | 0 |
| write-opening.ts:buildJudgePrompt | 0 | 0 |
| synthesis-prompt.ts:buildSynthesisPrompt | 3 | 3 |
| reply-classifier.ts:SYSTEM_PROMPT | 0 | 0 |
| faq-seed-agent.ts:buildSystemPrompt | 0 | 0 |
| personalization.ts:systemPrompt | 0 | 0 |
| run-revision.ts:buildRevisionPrompt | 1 | 1 |
| **TOTAL** | **35** | **34** |

The single hit was `"consultancies"`, in the gloss under the Chamber-event verdict example:
*"A chamber event and a strong network is exactly how a great many consultancies fill
capacity."* It went with the example.

### Names

| source | main | no-examples |
|---|---|---|
| docs/prompts/positioning-agent.md | 1 | 1 |
| docs/prompts/messaging-agent.md | 2 | 2 |
| docs/prompts/shared-voice-spec.md | 2 | 2 |
| **write-opening.ts:buildWriterPrompt** | **33** | **0** |
| synthesis-prompt.ts:buildSynthesisPrompt | 1 | 1 |
| all other sources | 0 | 0 |
| **TOTAL** | **39** | **6** |

**All 33 went, and the prediction was measured rather than assumed before the change.** The
full list, read off the scanner on `main`: Chamber, Sky, HydrospherIQ, London, Peak, DTCC×2,
Treasury×2, SEC, SEC's, Taffet, Hollywood×2, Coalition×2, Sovern×2, LA×2, SCG×2, Stanford×3,
GSB×3, CAVE, Jason, Pani, Visteon. Every one of them lived inside a worked example. None
was in rule text.

`buildWriterPrompt` is now the only template-literal prompt source in the registry reading
zero on both scans.

Both baselines are `toBeLessThanOrEqual` ratchets, so the drops pass without editing the
baseline maps. The maps were left untouched deliberately: lowering a recorded baseline is a
separate change from removing the hits, and this branch may be deleted.
