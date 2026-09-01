# Writer gate discovery

> **HISTORICAL RECORD, NOT A CURRENT MAP.** Every line number and file path below is
> anchored to commit `b5c602c` on branch `sourcing-filter`, the tree this was read from.
> That branch was already behind `main` when this was written and is further behind now,
> and three files the report discusses (`vendor-name-gate.ts`, `ordinary-words.ts`,
> `sentence-initial-names.ts`) exist only on `main`. Treat every reference as a pointer to
> what was true on that tree on that day. Re-check against `main` before acting on any of
> it. Committed 2026-09-01 for the reasoning it records, not for its coordinates.

Read-only investigation. No code was edited. This file is the only thing created.

## What was inspected

- Working tree at `HEAD` = `b5c602cf0695432c538f5aafa6a0c59b9f940644`, branch `sourcing-filter`.
- All line numbers below refer to that tree **unless a line is explicitly marked
  `origin/main:`**, which is used only where the thing asked about does not exist on
  `sourcing-filter`.

### Branch divergence, established before anything else

`sourcing-filter` does not contain commit `bcd06dc`, which is where the gate mode
mechanism lives:

```
$ git merge-base --is-ancestor bcd06dc HEAD
bcd06dc is NOT ancestor of HEAD

$ git branch -a --contains bcd06dc
+ merge-to-main
  sentence-initial-gate
  remotes/origin/main
  remotes/origin/sentence-initial-gate
```

Three files present on `origin/main` and absent from the working tree are in the gate
path:

```
$ diff <(git ls-tree -r --name-only HEAD) <(git ls-tree -r --name-only origin/main)
> src/lib/agents/vendor-name-gate.ts
> src/lib/style/ordinary-words.ts
> src/lib/style/sentence-initial-names.ts
```

This matters for Section 3 and is the whole of Section 6.

### Redaction policy applied

The rule is applied to every person, prospect company and client organisation named in
comments, prompt strings, worked examples and fixtures. Replaced with
`[REDACTED-PERSON]`, `[REDACTED-COMPANY]`, `[REDACTED-ORG]`.

One stated exception, so it can be audited rather than discovered: the platform's own
registered tool vendors (`LinkedIn`, `Google`, `Apollo`, `Instantly`) are left unredacted
where they appear as integration names. They are already named in `CLAUDE.md`, they are
not client or prospect identities, and redacting them would make Sections 1 and 8
unreadable. Every other capitalised entity is redacted, including ones that are arguably
public institutions, per "if you are unsure, redact it".

---

# SECTION 1: SCOPE DISCOVERY

Discovery was run as pattern greps over `src/`, `scripts/` and `tests/`, not from the
names in later sections. The broad sweep was:

```
grep -rlniE "GATE_MODE|_GATE|gate\(|Gate\b|validat|checkFor|violation|banned|forbidden|scrub|score"
```

That returned 170 files, most of them unrelated (sourcing, suppression, deployment). It
was then narrowed by resolving every gate symbol to its definition and its callers:

```
for sym in checkOpeningGates findFirmographicFigures findClientBaseClaims \
           findBackReferences findAbstractNouns findFigurativeVerbs readabilityScore \
           nominalisationDensity scrubAITells scrubAITellsDeep assertNoDashes \
           validateEmails recomputeCounts applySignOffFix findCrossVariantReuse \
           SentenceRegistry FrameRegistry BatchUniquenessRegistry frameShingles \
           sentenceKey untraceableClaims parseFloor parseChoice parseWriterOutput \
           assertCompleteVariables; do grep -rln "\b$sym\b" src/ scripts/; done
```

## 1a. Files that DEFINE a validation, gate, check or score on generated email copy

| File | What it defines |
|---|---|
| `src/lib/style/readability.ts` | `readabilityScore`, `MAX_SENTENCE_WORDS`, `HEDGE_PHRASES` |
| `src/lib/style/nominalisation.ts` | `nominalisationDensity` (penalty input to the above) |
| `src/lib/style/firmographic.ts` | `BANNED_FIRMOGRAPHIC`, `findFirmographicFigures`, `FIRMOGRAPHIC_RULE_TEXT` |
| `src/lib/style/back-reference.ts` | `findBackReferences` (demonstratives, definite articles, pronouns) |
| `src/lib/style/abstract-nouns.ts` | `findAbstractNouns`, `findFigurativeVerbs` (both report-only) |
| `src/lib/style/sentence-frames.ts` | `frameSkeleton`, `frameShingles`, `sentenceKey`, `SentenceRegistry`, `FrameRegistry` |
| `src/lib/style/customer-facing-style-rules.ts` | `scrubAITells`, `scrubAITellsDeep`, `assertNoDashes` and the `Excluding` variants |
| `src/lib/agents/research/write-opening.ts` | `checkOpeningGates`, `untraceableClaims`, `findClientBaseClaims`, `parseWriterOutput`, `parseFloor`, `parseChoice` |
| `src/lib/agents/research/batch-uniqueness.ts` | `BatchUniquenessRegistry`, `uniquenessFeedback` |
| `src/lib/agents/research/synthesize.ts` | `applyTriggerReadabilityGate`, `selectCandidate`, `parseCandidate` |
| `src/agents/messaging-generation-agent.ts` | `validateEmails`, `recomputeCounts`, `applySignOffFix`, `findCrossVariantReuse`, `BANNED_PARAGRAPH_OPENERS`, `BANNED_JARGON`, `EMAIL_WORD_LIMITS`, `EMAIL_SUBJECT_LIMITS`, `WORD_BANDS`, `MAX_QUESTIONS_PER_EMAIL` |
| `src/lib/composition/custom-variables.ts` | `assertCompleteVariables` |

## 1b. Files that CALL one of the above against generated email copy

| File | Calls |
|---|---|
| `src/lib/agents/research/write-opening.ts` | `scrubAITells`, `findFirmographicFigures`, `checkOpeningGates`, `BatchUniquenessRegistry.reserve` |
| `src/lib/agents/research/produce-opening.ts` | `writeAndJudgeOpening`, `getVariantEmail1Frame`, `composeEmail1WithOpening` |
| `src/lib/agents/prospect-research-agent-v2.ts` | `produceOpening`, `FrameRegistry.register`, `findAbstractNouns`, `findFigurativeVerbs`, `frameShingles`, `sentenceKey` |
| `src/lib/agents/prospect-research-collect-agent.ts` | `produceOpening`, `findAbstractNouns`, `findFigurativeVerbs` |
| `src/lib/agents/research/synthesize.ts` | `readabilityScore`, `scrubAITells` |
| `src/lib/operator/research-batch-entry.ts` | `FrameRegistry`, `BatchUniquenessRegistry` construction for a batch |
| `src/agents/messaging-generation-agent.ts` | `scrubAITells`, `scrubAITellsDeep`, `assertNoDashes`, `nominalisationDensity`, `findBackReferences`, `BANNED_FIRMOGRAPHIC`, `SentenceRegistry` |
| `src/lib/agents/revision/run-revision.ts` | `validateEmails`, `recomputeCounts`, `scrubAITellsDeep`, `assertNoDashes`, `scrubAITells` |
| `src/lib/composition/compose-sequence.ts` | `countWords`, `applyTriggerToEmail1`, `applyQuestionToEmail1`, `appendOptOutFooter` |
| `src/lib/composition/personalization.ts` | `scrubAITells` on the (disabled) bridge |
| `src/app/dashboard/operator/clients/[id]/actions.ts` | `composeSequence`, `composedToVariables`, `assertCompleteVariables` |

## 1c. Prompt file that is a validator counterpart

`docs/prompts/messaging-agent.md` is loaded from disk and used as the system prompt:

```ts
// src/agents/messaging-generation-agent.ts:1198
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md')
```

## 1d. Diagnostics and scripts in the same path

- `src/lib/agents/rerun-three-prospects.ts` — calls `readabilityScore` and `FrameRegistry`
- `scripts/verify-signoff-block.ts` — calls `validateEmails`, `recomputeCounts`, `applySignOffFix`
- `scripts/score-nominalisation.ts` — calls `nominalisationDensity`

## 1e. Test files (definitions exercised, no production behaviour)

`src/lib/style/__tests__/readability.test.ts`, `back-reference.test.ts`,
`firmographic.test.ts`, `abstract-nouns.test.ts`, `sentence-frames.test.ts`,
`sentence-reuse.test.ts`, `gate.test.ts`;
`src/lib/agents/research/__tests__/write-opening.test.ts`, `batch-uniqueness.test.ts`;
`src/agents/__tests__/word-bands-and-firmographics.test.ts`;
`src/lib/composition/__tests__/compose-sequence.test.ts`.

## 1f. FILES FOUND THAT NO LATER SECTION MENTIONS

Stated explicitly, as required.

1. **`src/lib/agents/revision/run-revision.ts`** — runs the full `validateEmails` gate on
   revised messaging documents. It is a second, independent entry into the same gate that
   the messaging agent uses, and no later section covers it.

   ```ts
   // src/lib/agents/revision/run-revision.ts:263
       const violations = validateEmails(emails, senderFirstName ?? '', senderCompanyName)
   ```

2. **`src/lib/composition/personalization.ts`** — calls `scrubAITells` on a generated
   bridge sentence. Unreachable at runtime (`BRIDGE_ENABLED = false`, see Section 7) but it
   is a live call site in the source.

3. **`src/lib/style/abstract-nouns.ts`** and its two call sites — `findAbstractNouns` and
   `findFigurativeVerbs` run on the opening that shipped, and are REPORT ONLY. They appear
   in Section 3 only as non-gates.

4. **`src/lib/operator/research-batch-entry.ts`** — constructs the `FrameRegistry` and
   `BatchUniquenessRegistry` for a batch run. It is the owner of the registries Section 3
   describes, and no section names it.

5. **`src/lib/agents/rerun-three-prospects.ts`**, **`scripts/verify-signoff-block.ts`**,
   **`scripts/score-nominalisation.ts`** — diagnostics that call the gates. Only the first
   appears in a later section (Section 5).

6. **`src/lib/agents/vendor-name-gate.ts`** — exists on `origin/main` only. It gates
   generated **strategy documents**, not email copy, so it is out of scope for Sections
   2 to 7, but it was found by the same greps and is recorded here.

7. **`src/lib/style/ordinary-words.ts`** — exists on `origin/main` only. It is the
   discriminator for the Section 6 gate.

---

# SECTION 2: THE WRITER CALL PATH

## 2a. Entry point that generates the opening

Two production callers, both routing into one function.

```ts
// src/lib/agents/prospect-research-agent-v2.ts:489
    const opening = await produceOpening({
```

```ts
// src/lib/agents/prospect-research-collect-agent.ts:236
    const opening = await produceOpening({
```

`produceOpening` is a thin adapter:

```ts
// src/lib/agents/research/produce-opening.ts:77-105
export async function produceOpening({
  apiKey, clientName, ctx, candidates, messagingContent, variantId, uniqueness,
}: ProduceOpeningInput): Promise<OpeningResult> {
  const frame = getVariantEmail1Frame(messagingContent, variantId)

  return writeAndJudgeOpening({
    apiKey, clientName,
    prospectFirstName: ctx.first_name,
    candidates,
    p3: frame.p3,
    cta: frame.cta,
    templateOpening: frame.authoredOpening,
    composeEmail1: (text: string, question?: string | null) =>
      composeEmail1WithOpening(messagingContent, variantId, text, question ?? null, ctx.first_name).body,
    prospectId: ctx.id,
    uniqueness,
  })
}
```

The generating function is `writeAndJudgeOpening`:

```ts
// src/lib/agents/research/write-opening.ts:1275
export async function writeAndJudgeOpening(params: WriteAndJudgeParams): Promise<OpeningResult> {
```

The model call itself:

```ts
// src/lib/agents/research/write-opening.ts:1312
    const writerCall = await callModel(client, WRITER_MODEL, writerSystem, user, 700, `writer for prospect ${params.prospectId}`, true)
```

with `const WRITER_MODEL = 'claude-sonnet-4-6'` at `write-opening.ts:24`.

## 2b. How the model response is parsed into its labelled blocks

```ts
// src/lib/agents/research/write-opening.ts:1234-1263
export function parseWriterOutput(raw: string): {
  observation: string
  bridge: string
  question: string
  opening: string
} {
  const obsMatch = raw.match(/OBSERVATION:\s*([\s\S]*?)(?=\n\s*(?:BRIDGE|QUESTION):|$)/i)
  const bridgeMatch = raw.match(/BRIDGE:\s*([\s\S]*?)(?=\n\s*QUESTION:|$)/i)
  const legacyMatch = raw.match(/OPENING:\s*([\s\S]*?)(?=\n\s*QUESTION:|$)/i)
  const qMatch = raw.match(/QUESTION:\s*([\s\S]+)/i)

  const question = cleanOpening(qMatch?.[1] ?? '').split('\n')[0].trim()

  // Preferred path: both labels present.
  if (obsMatch && bridgeMatch) {
    const observation = collapseParagraph(cleanOpening(obsMatch[1]))
    const bridge = collapseParagraph(cleanOpening(bridgeMatch[1]))
    return { observation, bridge, question, opening: joinOpening(observation, bridge) }
  }

  // Fallback: the old single OPENING block, or an unlabelled reply. Split on the blank
  // line if the writer left one, otherwise treat the whole thing as the observation so
  // nothing is silently dropped. The bridge gate then sees an empty bridge and rejects,
  // which is the correct outcome: a malformed reply must not ship.
  const whole = cleanOpening(legacyMatch?.[1] ?? (obsMatch?.[1] ?? bridgeMatch?.[1] ?? raw))
  const parts = whole.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const observation = collapseParagraph(parts[0] ?? '')
  const bridge = collapseParagraph(parts.slice(1).join(' '))
  return { observation, bridge, question, opening: joinOpening(observation, bridge) }
}
```

The two helpers it leans on:

```ts
// src/lib/agents/research/write-opening.ts:1190-1195
function cleanOpening(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^(opening|here is the opening|draft)\s*:\s*/i, '')
  if (/^["'“]/.test(text) && /["'”]$/.test(text)) text = text.slice(1, -1).trim()
  return text
}
```

```ts
// src/lib/agents/research/write-opening.ts:1266-1273
function collapseParagraph(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

export function joinOpening(observation: string, bridge: string): string {
  return [observation.trim(), bridge.trim()].filter(Boolean).join('\n\n')
}
```

The format the parse expects is stated at the end of the writer prompt:

```
// src/lib/agents/research/write-opening.ts:802-806
Return your answer as exactly three labelled blocks and nothing else:

OBSERVATION: <the thing you noticed, its own paragraph>
BRIDGE: <the pattern, its own paragraph>
QUESTION: <the closing question, ending in a question mark>
```

## 2c. Behaviour when parsing fails

`parseWriterOutput` never throws and never returns null. It degrades in three steps:

1. **Both labels present** — normal path, line 1248.
2. **Labels missing** — line 1258 falls back to the legacy `OPENING:` block, then to
   whichever single label matched, then to the entire raw reply. It splits on a blank line;
   part 0 becomes the observation and everything after becomes the bridge.
3. **Nothing splittable** — the whole reply becomes the observation and the bridge is the
   empty string.

The rejection then happens downstream, in the caller, not in the parser:

```ts
// src/lib/agents/research/write-opening.ts:1328-1333
    if (!question) gates.push('writer returned no closing question')
    // A missing half means the reply was malformed. Failing here rather than shipping is
    // deliberate: a bridge with no observation reads as a generic line with no anchor, and
    // an observation with no bridge names a fact and then asks for a meeting.
    if (!observation) gates.push('writer returned no observation')
    if (!bridge) gates.push('writer returned no bridge')
```

An empty model reply is handled one level further up, in `callModel`, which substitutes
an empty string rather than failing:

```ts
// src/lib/agents/research/write-opening.ts:1160-1161
    const block = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    return { text: block?.text?.trim() ?? '', usage }
```

## 2d. The retry loop

### How max attempts is computed

```ts
// src/lib/agents/research/write-opening.ts:1371-1378
  // A SECOND RETRY, BUT ONLY WHERE THE MATERIAL DESERVES IT.
  //
  // [REDACTED-PERSON] and [REDACTED-PERSON] both had findings that scored well and lost on execution, then fell back
  // to template with good material unused. Retrying a prospect whose findings are thin
  // just spends calls to arrive at the same place, so the extra attempt is bought by the
  // evidence: at least one candidate that passed all six tests.
  const strongMaterial = params.candidates.some(c => c.passes_all)
  const maxAttempts = strongMaterial ? 3 : 2
```

So: 2 attempts normally, 3 when at least one candidate has `passes_all === true`.

### The loop

```ts
// src/lib/agents/research/write-opening.ts:1431-1448
  for (let i = 0; i < maxAttempts; i++) {
    const a = await attempt(feedback)
    last = a

    if (a.kind === 'compared') {
      comparisons.push(a.c)
      if (a.c.written_won) {
        return {
          usage,
          opening: a.c.opening, observation: a.c.observation, bridge: a.c.bridge,
          question: a.c.question, written_won: true,
          retry_used: i > 0, retries_used: i, strong_material: strongMaterial,
          comparisons, judge_reasoning: a.c.reason, gate_failures: [],
        }
      }
    }
    feedback = feedbackFrom(a)
  }
```

### What triggers a retry

Four outcomes, all of which fall through to the next iteration. They are the `Attempt`
union:

```ts
// src/lib/agents/research/write-opening.ts:1380-1384
  type Attempt =
    | { kind: 'gated'; gates: string[]; opening: string; question: string }
    | { kind: 'collided'; reason: string; opening: string; question: string }
    | { kind: 'floored'; floor: FloorCheck; opening: string; question: string }
    | { kind: 'compared'; c: JudgeComparison }
```

```ts
// src/lib/agents/research/write-opening.ts:1386-1417
  const attempt = async (feedback: string | null): Promise<Attempt> => {
    const w = await writeOnce(feedback)
    if (w.gates.length > 0) return { kind: 'gated', gates: w.gates, opening: w.opening, question: w.question }

    // THE BRIDGE GATE. Reserved synchronously, before either model call below, so two
    // prospects running concurrently cannot both pass a clean check and then both commit
    // the same frame. Released again the moment this attempt stops being a candidate.
    const collisions = params.uniqueness?.reserve(params.prospectId, w.bridge, w.question) ?? []
    if (collisions.length > 0) {
      logger.warn('research/write-opening: bridge or question collided with another prospect', {
        prospect_id: params.prospectId,
        kinds: [...new Set(collisions.map(c => c.kind))],
        keys: collisions.map(c => c.key).slice(0, 3),
      })
      return { kind: 'collided', reason: uniquenessFeedback(collisions), opening: w.opening, question: w.question }
    }

    const floor = await floorCheck(w.opening, w.question)
    if (floor.claims_private) {
      logger.warn('research/write-opening: floor disqualified the personalised version', {
        prospect_id: params.prospectId, reason: floor.reason,
      })
      params.uniqueness?.release(params.prospectId)
      return { kind: 'floored', floor, opening: w.opening, question: w.question }
    }

    const c = await compare(w.observation, w.bridge, w.opening, w.question, floor)
    // The template won, so nothing of this attempt ships. Holding the reservation would
    // block a later prospect from a shape that was never actually used.
    if (!c.written_won) params.uniqueness?.release(params.prospectId)
    return { kind: 'compared', c }
  }
```

A retry is therefore triggered by: any deterministic gate failure; a batch-uniqueness
collision on the bridge or the question; a floor disqualification; or the judge preferring
the approved template.

### What is fed back into the retry prompt

Feedback is a single string with a `|||` separator: the previous attempt's text on the
left, the reason on the right.

```ts
// src/lib/agents/research/write-opening.ts:1419-1426
  const feedbackFrom = (a: Attempt): string =>
    a.kind === 'gated'
      ? `${a.opening} ${a.question}|||${a.gates.join('; ')}`
      : a.kind === 'collided'
        ? `${a.opening} ${a.question}|||${a.reason}`
        : a.kind === 'floored'
          ? `${a.opening} ${a.question}|||A reviewer said this claims private knowledge about the prospect: ${a.floor.reason}. Say only what can be seen from outside.`
          : `${a.c.opening} ${a.c.question}|||${a.c.reason}`
```

It is split apart and rendered into the user message:

```ts
// src/lib/agents/research/write-opening.ts:1300-1309
    const taken = params.uniqueness?.takenQuestions(params.prospectId) ?? []
    const takenBlock = taken.length > 0
      ? `\n\n## Closing questions already taken in this batch\n\nDo not use any of these, and do not reword one slightly:\n${taken.map(q => `- ${q}`).join('\n')}`
      : ''

    const user = feedback
      ? `${assignment}\n\n## Findings\n\n${findings}${takenBlock}\n\n## Your previous attempt did not ship\n\nYou wrote:\n${feedback.split('|||')[0]}\n\nThe reason:\n${feedback.split('|||')[1]}\n\nWrite a different version that answers that. Return ONLY the three labelled blocks.`
      : `${assignment}\n\n## Findings\n\n${findings}\n\nWrite the observation, the bridge and the closing question. Return ONLY the three labelled blocks.`
```

So a retry prompt carries: the assignment block, the findings, the list of closing
questions already taken by other prospects in the batch, the writer's own previous text,
and the reason it did not ship.

## 2e. The exact line at which writer output is treated as final

```ts
// src/lib/agents/research/write-opening.ts:1437-1444
      if (a.c.written_won) {
        return {
          usage,
          opening: a.c.opening, observation: a.c.observation, bridge: a.c.bridge,
          question: a.c.question, written_won: true,
          retry_used: i > 0, retries_used: i, strong_material: strongMaterial,
          comparisons, judge_reasoning: a.c.reason, gate_failures: [],
        }
      }
```

`write-opening.ts:1437` is the branch, and `write-opening.ts:1438` is the `return` that
makes it final. Nothing in the function inspects the text after this point.

The other exit is the exhaustion path, which discards the writer's output entirely and
returns nulls so the approved template ships:

```ts
// src/lib/agents/research/write-opening.ts:1466-1472
  return {
    usage,
    opening: null, observation: null, bridge: null, question: null, written_won: false,
    retry_used: retries > 0, retries_used: retries, strong_material: strongMaterial,
    comparisons, judge_reasoning: reason,
    gate_failures: last?.kind === 'gated' ? last.gates : [],
  }
```

---

# SECTION 3: DETERMINISTIC GATES

## 3a. Execution order

Everything below runs inside one attempt, in this order. Gates 1 to 8 are all inside
`checkOpeningGates`, which is called once at `write-opening.ts:1324`.

Before any gate, the three parsed parts are scrubbed:

```ts
// src/lib/agents/research/write-opening.ts:1316-1327
    // Scrub each half separately, then rejoin. Scrubbing the joined text risks a
    // replacement spanning the blank line and collapsing the two paragraphs into one.
    const observation = scrubAITells(parsed.observation, `research/writer/${params.prospectId}`)
    const bridge = scrubAITells(parsed.bridge, `research/writer/${params.prospectId}`)
    const question = scrubAITells(parsed.question, `research/writer/${params.prospectId}`)
    const opening = joinOpening(observation, bridge)

    // The cap covers the whole written block, so gate the combined text.
    const gates = checkOpeningGates(
      `${opening} ${question}`.trim(), params.prospectFirstName, findings, params.p3,
      { observation, bridge, question },
    )
```

### Gate 0 — `scrubAITells` (a rewrite, not a gate)

- **File/line**: defined `src/lib/style/customer-facing-style-rules.ts:185`; called
  `src/lib/agents/research/write-opening.ts:1318`, `:1319`, `:1320`.
- **Inspects**: em dashes, en dashes, double hyphens, and a list of AI-tell phrases.
- **Returns**: a rewritten string. It cannot fail.
- **Caller on failure**: no failure path exists. AI tells are logged only.

```ts
// src/lib/style/customer-facing-style-rules.ts:185-208
export function scrubAITells(text: string, context?: string): string {
  const rangeFixed = text.replace(NUMERIC_RANGE_PATTERN, '$1-$2')
  const scrubbed = rangeFixed.replace(DASH_PATTERN, (match, offset, str) => {
    const firstCharAfter = str.slice(offset + match.length).trimStart()[0] ?? ''
    const isLower =
      firstCharAfter.length > 0 &&
      firstCharAfter === firstCharAfter.toLowerCase() &&
      firstCharAfter !== firstCharAfter.toUpperCase()
    return isLower ? ', ' : '. '
  })

  for (const { label, pattern } of AI_TELL_PATTERNS) {
    if (pattern.test(scrubbed)) {
      logger.warn('customer-facing-style: AI tell detected', { ... })
    }
  }

  return scrubbed.trim()
}
```

- **Runs on**: the writer's raw blocks, each part separately.

### Gate 1 — word cap on the whole block

- **File/line**: `src/lib/agents/research/write-opening.ts:1021-1031`.
- **Inspects**: whitespace-delimited word count of `${opening} ${question}` against
  `OPENING_MAX_WORDS = 67` (`write-opening.ts:52`).
- **Returns**: pushes a failure string; with the three parts supplied it names the part
  that is over.

```ts
// src/lib/agents/research/write-opening.ts:1021-1031
  const wordCount = opening.trim().split(/\s+/).filter(Boolean).length
  if (wordCount > OPENING_MAX_WORDS) {
    // WITH THE PARTS, SAY WHICH ONE IS OVER. "78 words, cap is 67" was the whole message
    // for two rounds, it was delivered twice to the same prospect, and the rewrite came
    // back over both times. A total tells the writer to cut something without saying what.
    failures.push(
      params?.observation !== undefined
        ? lengthFailureByPart(wordCount, params)
        : `opening is ${wordCount} words, cap is ${OPENING_MAX_WORDS}`,
    )
  }
```

```ts
// src/lib/agents/research/write-opening.ts:975-995
function lengthFailureByPart(
  total: number,
  parts: { observation: string; bridge: string; question: string },
): string {
  const rows = [
    { name: 'observation', words: wordsIn(parts.observation), target: OPENING_BUDGET.observation },
    { name: 'bridge',      words: wordsIn(parts.bridge),      target: OPENING_BUDGET.bridge },
    { name: 'question',    words: wordsIn(parts.question),    target: OPENING_BUDGET.question },
  ]
  ...
  return `the whole block is ${total} words against a hard cap of ${OPENING_MAX_WORDS} and a target of ${OPENING_TARGET_WORDS}: ${detail}. ${instruction}`
}
```

- **Runs on**: the writer's raw blocks (joined), not the composed email.
- **Caller on failure**: `kind: 'gated'` → retry with the failure string as feedback.

### Gate 2 — prospect first name in the opening

- **File/line**: `src/lib/agents/research/write-opening.ts:1033-1038`.

```ts
  if (prospectFirstName && prospectFirstName.trim().length > 1) {
    const re = new RegExp(`\\b${prospectFirstName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(opening)) {
      failures.push(`opening names the prospect ("${prospectFirstName}"), which reads as third person: the greeting above already names them`)
    }
  }
```

- **Inspects**: a word-boundary match of the prospect's first name.
- **Runs on**: the writer's raw blocks.

### Gate 3 — untraceable claims

- **File/line**: called `write-opening.ts:1040-1043`; defined `write-opening.ts:911-936`.

```ts
// src/lib/agents/research/write-opening.ts:911-936
function untraceableClaims(opening: string, findingsText: string): string[] {
  const haystack = findingsText.toLowerCase()
  const untraceable: string[] = []

  // Every number and year must come from somewhere.
  for (const token of opening.match(/\b\d[\d,.]*\b/g) ?? []) {
    const bare = token.replace(/[.,]$/, '')
    if (!haystack.includes(bare.toLowerCase())) untraceable.push(bare)
  }

  // Capitalised words that are not sentence-initial read as names of things.
  const words = opening.split(/\s+/)
  words.forEach((word, i) => {
    // Strip the possessive before comparing: "[REDACTED-COMPANY]'s" is the same claim as "[REDACTED-COMPANY]", and the
    // findings will only ever contain the bare form. This fired as a false positive.
    const clean = word.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/'s$/i, '')
    if (clean.length < 3) return
    if (i === 0) return
    if (!/^\p{Lu}/u.test(clean)) return
    // A capital straight after a full stop is sentence-initial, not a name.
    if (i > 0 && /[.!?]$/.test(words[i - 1])) return
    if (!haystack.includes(clean.toLowerCase())) untraceable.push(clean)
  })

  return [...new Set(untraceable)]
}
```

- **Inspects**: every number, and every capitalised token that is neither index 0 nor
  preceded by terminal punctuation, against the findings text.
- **Returns**: a deduplicated list of untraceable tokens.
- **Runs on**: the writer's raw blocks.

### Gate 4 — firmographic figures

- **File/line**: called `write-opening.ts:1051-1054`; patterns in
  `src/lib/style/firmographic.ts:26-59`; matcher `firmographic.ts:62-66`.

```ts
// src/lib/agents/research/write-opening.ts:1051-1054
  const figures = findFirmographicFigures(opening)
  if (figures.length > 0) {
    failures.push(`quotes ${figures.join(' and ')} from the prospect's record: qualify by role, stage or situation instead`)
  }
```

```ts
// src/lib/style/firmographic.ts:62-66
export function findFirmographicFigures(text: string): string[] {
  return [...new Set(
    BANNED_FIRMOGRAPHIC.filter(t => t.pattern.test(text)).map(t => t.label),
  )]
}
```

- **Inspects**: currency amounts, `500K`/`5M` shapes, headcounts, team sizes, oblique size
  references and headcount-of-one phrasings.
- **Runs on**: the writer's raw blocks.

### Gate 5 — question-mark count

- **File/line**: `src/lib/agents/research/write-opening.ts:1068-1071`.

```ts
  const questionMarks = (opening.match(/\?/g) ?? []).length
  if (questionMarks > 1) {
    failures.push(`contains ${questionMarks} question marks: the closing question is the only question, and the observation and bridge must not ask one`)
  }
```

- **Inspects**: literal `?` characters in `${opening} ${question}`.
- **Runs on**: the writer's raw blocks.

### Gate 6 — client-base claims

- **File/line**: called `write-opening.ts:1090-1093`; defined `write-opening.ts:952-963`.

```ts
// src/lib/agents/research/write-opening.ts:952-963
const CLIENT_BASE_CLAIMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bour (?:clients|customers)\b/i,                                        label: '"our clients"' },
  { pattern: /\bclients of ours\b/i,                                                  label: '"clients of ours"' },
  { pattern: /\b(?:firms|companies|founders|businesses|teams|clients) we (?:work with|serve|help|support)\b/i, label: 'a claimed client relationship' },
  { pattern: /\bwe(?:'ve|\s+have)\s+(?:helped|worked with|seen this with|seen it with)\b/i, label: 'a claimed track record' },
  { pattern: /\bevery (?:client|customer) (?:we|of ours)\b/i,                          label: 'a claimed client base' },
]

export function findClientBaseClaims(text: string): string[] {
  return [...new Set(CLIENT_BASE_CLAIMS.filter(c => c.pattern.test(text)).map(c => c.label))]
}
```

- **Runs on**: the writer's raw blocks.

### Gate 7 — echo of the approved offer line

- **File/line**: `src/lib/agents/research/write-opening.ts:1095-1101`.

```ts
  if (approvedP3) {
    const p3Words = normaliseForEcho(approvedP3).split(' ').filter(Boolean)
    const needle = p3Words.slice(0, 6).join(' ')
    if (p3Words.length >= 6 && normaliseForEcho(opening).includes(needle)) {
      failures.push('repeats the approved offer line, which is already in the email: write only the observation, the bridge and the closing question')
    }
  }
```

```ts
// src/lib/agents/research/write-opening.ts:998-1000
function normaliseForEcho(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}
```

- **Inspects**: the first six normalised words of the variant's approved P3.
- **Runs on**: the writer's raw blocks, compared against the messaging document's P3.

### Gate 8 — presence of each part

- **File/line**: `src/lib/agents/research/write-opening.ts:1328-1333` (quoted in 2c).
- **Runs on**: the writer's raw blocks.

### Gate 9 — batch uniqueness on bridge and question

- **File/line**: called `src/lib/agents/research/write-opening.ts:1393`; defined
  `src/lib/agents/research/batch-uniqueness.ts:58-90`.

```ts
// src/lib/agents/research/batch-uniqueness.ts:58-90
  reserve(id: string, bridge: string, question: string): UniquenessCollision[] {
    this.release(id)

    const frames = frameShingles(bridge)
    const qKey = sentenceKey(question)
    const collisions: UniquenessCollision[] = []

    for (const frame of frames) {
      const firstSeenId = this.bridgeFrames.get(frame)
      if (firstSeenId !== undefined && firstSeenId !== id) {
        collisions.push({ kind: 'bridge', key: frame, firstSeenId })
      }
    }

    if (qKey) {
      const firstSeenId = this.questions.get(qKey)
      if (firstSeenId !== undefined && firstSeenId !== id) {
        collisions.push({ kind: 'question', key: qKey, firstSeenId })
      }
    }

    if (collisions.length > 0) return collisions
    ...
  }
```

- **Inspects**: 5-token skeleton n-grams of the bridge, and the normalised skeleton of the
  question, against every other prospect in the same in-process batch.
- **Returns**: a list of collisions; records nothing when non-empty.
- **Caller on failure**: `kind: 'collided'` → retry, with `uniquenessFeedback(collisions)`
  as the reason.
- **Runs on**: the writer's raw blocks (bridge and question, separately).
- **Absent on the collect path**: `prospect-research-collect-agent.ts:236-247` passes no
  registry, so this gate does not run there.

### Gate 10 — the floor (LLM, not deterministic)

Covered in Section 4. Listed here for order: it runs at `write-opening.ts:1403`, after
gate 9 and before the judge.

### Gate 11 — the judge (LLM, not deterministic)

`write-opening.ts:1412`. Comparative, not a gate in the pass/fail sense.

## 3b. REPORT-ONLY checks that are NOT gates

Both run after `writeAndJudgeOpening` has returned, on the opening that won.

```ts
// src/lib/agents/prospect-research-agent-v2.ts:538-552
    // Abstract-noun count on what shipped. REPORT ONLY: logged and rolled into the batch
    // summary, never acted on. See src/lib/style/abstract-nouns.ts for why it does not gate.
    if (opening.written_won && opening.opening) {
      const copy = `${opening.opening} ${opening.question ?? ''}`
      const nouns = findAbstractNouns(copy)
      const verbs = findFigurativeVerbs(copy)
      if (nouns.length > 0 || verbs.length > 0) {
        logger.info('prospect-research-v2: unfilmable language in shipped opening', { ... })
      }
    }
```

The same block is duplicated at `src/lib/agents/prospect-research-collect-agent.ts:259-272`.

Cross-batch frame reporting on the observation, also never acted on:

```ts
// src/lib/agents/prospect-research-agent-v2.ts:526-536
    if (frameRegistry && opening.observation) {
      const collisions = frameRegistry.register(ctx.id, opening.observation)
      for (const collision of collisions) {
        logger.warn('prospect-research-v2: repeated sentence frame across batch', { ... })
      }
    }
```

## 3c. Gate present on `origin/main` and absent here

`checkSentenceInitialNames` is wired in as an eighth gate on `origin/main` and does not
exist on `sourcing-filter`:

```ts
// origin/main:src/lib/agents/research/write-opening.ts:1061-1063
  failures.push(...checkSentenceInitialNames(
    opening, findingsText, { prospectId: context?.prospectId ?? 'unknown' },
  ))
```

It returns an empty array today. See Section 6.

## 3d. Does any gate inspect sentence structure, verbs, or punctuation?

- **Sentence structure: NO.** No gate in the writer path measures sentence length, clause
  count, subject position or relative clauses. `readabilityScore` does measure sentence
  length, but it is never called on writer output (Section 5). Sentence *shape* is compared
  across prospects by gate 9, but that is a collision test between two texts, not an
  inspection of one text's structure.
- **Verbs: NO.** `findFigurativeVerbs` (`src/lib/style/abstract-nouns.ts:107`) is the only
  verb check and it is report-only, called after the result is final
  (`prospect-research-agent-v2.ts:543`).
- **Punctuation: YES.** One gate. Gate 5, `write-opening.ts:1068-1071`, counts `?`
  characters and fails at more than one. Two other places touch punctuation without gating:
  `untraceableClaims` uses `/[.!?]$/` at `write-opening.ts:931` as an *exemption* test, and
  `applyTriggerToEmail1` appends a full stop at `compose-sequence.ts:830-832`.

---

# SECTION 4: THE FLOOR CALL

## 4a. File and line of the call

```ts
// src/lib/agents/research/write-opening.ts:1340-1345
  const floorCheck = async (opening: string, question: string): Promise<FloorCheck> => {
    const email = params.composeEmail1(opening, question)
    const floorCall = await callModel(client, JUDGE_MODEL, floorSystem, email, 300, `floor for prospect ${params.prospectId}`)
    record(floorCall.usage)
    return parseFloor(floorCall.text)
  }
```

The call is `write-opening.ts:1342`. It is invoked from the attempt at
`write-opening.ts:1403`:

```ts
    const floor = await floorCheck(w.opening, w.question)
    if (floor.claims_private) {
```

Model: `const JUDGE_MODEL = 'claude-sonnet-4-6'` (`write-opening.ts:25`). `max_tokens` 300.

## 4b. The full prompt text sent

**System prompt**, built by `buildFloorPrompt()` at `write-opening.ts:832-847`, verbatim.
It contains no names, so nothing is redacted:

```
You are reviewing a cold email before it goes to a real person.

Does this email state something about the prospect's business that could not be known from
public information? Their pipeline, their diary, their results, whether their marketing
works.

Answer YES or NO, then one sentence.

YES means it claims private knowledge. NO means everything it asserts could be seen from
outside.

Reply in exactly this format:
CLAIMS_PRIVATE: NO
REASON: one sentence.
```

**User message**: there is no fixed user prompt. The user message is the whole composed
Email 1 for this prospect, produced by the callback:

```ts
// src/lib/agents/research/write-opening.ts:1341
    const email = params.composeEmail1(opening, question)
```

which resolves to:

```ts
// src/lib/agents/research/produce-opening.ts:101-102
    composeEmail1: (text: string, question?: string | null) =>
      composeEmail1WithOpening(messagingContent, variantId, text, question ?? null, ctx.first_name).body,
```

So the user message is: the greeting with `{{first_name}}` already substituted, the
writer's observation, the writer's bridge, the client's approved P3, the writer's closing
question, the two-line sign-off, and the opt-out footer. Every one of those parts is
per-client and per-prospect.

The comment above the prompt records why it exists:

```ts
// src/lib/agents/research/write-opening.ts:823-831
// THE FLOOR, run on the personalised version ALONE, before any comparison.
//
// The comparison picks a winner, which means a flawed personalised email still ships
// whenever its template happens to be worse. [REDACTED-PERSON]'s shipped claiming "the pipeline runs
// warm until the UK entity needs to feed it cold", asserting two things about her business
// nobody outside it could know. It beat its template and went out.
//
// So this runs first and can only disqualify. It is not a comparison and it has no
// opinion about quality: one question, about knowability.
```

## 4c. What the response is parsed into

```ts
// src/lib/agents/research/write-opening.ts:849-867
/** The floor verdict on one attempt. Disqualifying, never comparative. */
export interface FloorCheck {
  claims_private: boolean
  reason: string
}

/**
 * Reads the floor verdict. An unreadable reply resolves to DISQUALIFIED, so ambiguity can
 * only ever fall back to the approved template.
 */
export function parseFloor(raw: string): FloorCheck {
  const m = raw.match(/CLAIMS_PRIVATE:\s*(YES|NO)/i)
  const r = raw.match(/REASON:\s*([\s\S]+)/i)
  const claims_private = m ? /yes/i.test(m[1]) : true
  return {
    claims_private,
    reason: (r?.[1] ?? raw).trim().split('\n')[0].trim() || 'No reasoning returned.',
  }
}
```

## 4d. Behaviour on an unparseable response

`write-opening.ts:862`: `const claims_private = m ? /yes/i.test(m[1]) : true`.

No `CLAIMS_PRIVATE:` match means `claims_private` is `true`, which is the disqualifying
value. The attempt becomes `kind: 'floored'` at `write-opening.ts:1409`, the batch
reservation is released at `:1408`, and the prospect retries or falls back to the approved
template. An empty reply from `callModel` (`write-opening.ts:1161` returns `''`) reaches
the same outcome, and `reason` falls back to `'No reasoning returned.'`.

## 4e. Prompt caching

**Not cached.** `callModel` is called at `write-opening.ts:1342` with six arguments; the
seventh parameter `cacheSystem` defaults to `false`:

```ts
// src/lib/agents/research/write-opening.ts:1129-1137
async function callModel(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  context: string,
  cacheSystem = false,
): Promise<{ text: string; usage: TokenUsage }> {
```

```ts
// src/lib/agents/research/write-opening.ts:1150-1152
      system: cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system,
```

The reason is recorded on the function:

```ts
// src/lib/agents/research/write-opening.ts:1119-1128
/**
 * `cacheSystem` marks the system prompt as a cache breakpoint. Set it ONLY for prompts
 * that are byte-stable across calls and large enough to cache.
 *
 * The writer prompt qualifies on both counts: ~9,300 tokens and, since the assignment
 * block moved to the user message, identical on every call. The floor and judge prompts
 * qualify on neither: they are ~124 tokens each, far below Anthropic's ~1,024-token
 * minimum cacheable prefix, so a breakpoint on them would be silently ignored while still
 * spending one of the four breakpoints a request is allowed.
 */
```

**Which portion is constant across prospects**: the system prompt only. `buildFloorPrompt()`
takes no parameters (`write-opening.ts:832`) and returns a template literal with no
interpolation, so it is byte-identical for every prospect, every variant and every client.
The user message is entirely variable.

For contrast, the writer call is the one that does opt in:

```ts
// src/lib/agents/research/write-opening.ts:1310-1312
    // cacheSystem: the writer prompt is the big stable one, and this is the call that runs
    // up to three times per prospect.
    const writerCall = await callModel(client, WRITER_MODEL, writerSystem, user, 700, `writer for prospect ${params.prospectId}`, true)
```

---

# SECTION 5: readabilityScore

## 5a. Definition

- **File**: `src/lib/style/readability.ts`
- **Line**: 107

```ts
// src/lib/style/readability.ts:107-110
export function readabilityScore(
  text: string,
  maxSentenceWords: number = MAX_SENTENCE_WORDS,
): ReadabilityScore {
```

**Return type**, `src/lib/style/readability.ts:72-91`:

```ts
export interface ReadabilityScore {
  /** Sentences as split for scoring. */
  sentences: string[]
  /** Word count of the longest sentence. 0 for empty text. */
  maxSentenceWords: number
  /** Sentences over MAX_SENTENCE_WORDS, verbatim. */
  longSentences: string[]
  /** Hedge phrases found, deduplicated, in order of first appearance. */
  hedges: string[]
  nominalisation: NominalisationScore
  /**
   * True when an unambiguous rule was broken: an over-length sentence or a hedge.
   * Gates selection. Never set by nominalisation density alone.
   */
  hardFail: boolean
  /** Demerits, lower is better. Ranks candidates that all pass the hard gate. */
  penalty: number
  /** Plain-English reasons, one per problem found. Empty when the text is clean. */
  reasons: string[]
}
```

**What it computes**:

```ts
// src/lib/style/readability.ts:111-176
  const clean = (text ?? '').trim()
  const sentences = splitSentences(clean)
  const reasons: string[] = []

  const sentenceWordCounts = sentences.map(countWords)
  const maxWords = sentenceWordCounts.length > 0 ? Math.max(...sentenceWordCounts) : 0
  const longSentences = sentences.filter((_, i) => sentenceWordCounts[i] > maxSentenceWords)

  const seenHedges = new Set<string>()
  const hedges: string[] = []
  for (const phrase of HEDGE_PHRASES) {
    const re = new RegExp(`\\b${phrase}\\b`, 'i')
    if (re.test(clean) && !seenHedges.has(phrase)) {
      seenHedges.add(phrase)
      hedges.push(phrase)
    }
  }

  const nominalisation = nominalisationDensity(clean)

  let penalty = 0

  for (const sentence of longSentences) {
    const over = countWords(sentence) - maxSentenceWords
    // Scaled so a 37-word sentence ranks clearly worse than a 26-word one.
    penalty += 3 + over
    reasons.push(`Sentence runs ${countWords(sentence)} words, cap is ${maxSentenceWords}.`)
  }

  const longButLegal = sentences.filter(
    (s, i) => sentenceWordCounts[i] >= LONG_SENTENCE_WORDS && sentenceWordCounts[i] <= maxSentenceWords,
  )
  for (const sentence of longButLegal) {
    penalty += 1
    reasons.push(`Sentence runs ${countWords(sentence)} words, under the cap but long.`)
  }

  for (const hedge of hedges) {
    penalty += 2
    reasons.push(`Hedging phrase "${hedge}" commits to nothing.`)
  }

  // Penalty only, never a hard fail. See the header note on false positives.
  if (nominalisation.exceedsThreshold) {
    penalty += 2
    reasons.push(...)
  }

  const hardFail = longSentences.length > 0 || hedges.length > 0
```

Thresholds: `MAX_SENTENCE_WORDS = 25` (`readability.ts:40`), `LONG_SENTENCE_WORDS = 21`
(`readability.ts:44`), and a 30-entry closed list `HEDGE_PHRASES` (`readability.ts:60-70`).

Sentence splitting:

```ts
// src/lib/style/readability.ts:96-101
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}
```

## 5b. Every call site

Four in non-test code. There are no others.

| # | File:line | Context |
|---|---|---|
| 1 | `src/lib/agents/research/synthesize.ts:380` | inside `parseCandidate` |
| 2 | `src/lib/agents/research/synthesize.ts:497` | inside `applyTriggerReadabilityGate` |
| 3 | `src/lib/agents/research/synthesize.ts:716` | inside `buildFallbackSynthesis` |
| 4 | `src/lib/agents/rerun-three-prospects.ts:103` | diagnostic script |

Test-only call sites: `src/lib/style/__tests__/readability.test.ts` lines 21, 26, 33, 40,
41, 46, 53, 61, 69, 75, 80, 94, 100, 109, 113, 117, 130, 138, 143.

**Note for Section 3**: none of these four is in the writer path. `readabilityScore` is
never called on writer output.

## 5c. Does the return value change behaviour, per call site?

### Call site 1 — `synthesize.ts:380`. CHANGES BEHAVIOUR.

```ts
// src/lib/agents/research/synthesize.ts:378-387
  // Readability is MEASURED here, never read from the model. The model's own claim is
  // kept alongside so a disagreement is visible rather than silent.
  const readability = toCandidateReadability(readabilityScore(observation))
  const { opposite_reading, inference_direction } = parseInferenceDirection(o)

  // A candidate is demoted when it clears the six tests but fails one of the two gates
  // added on top of them. Recorded per candidate so the reason is auditable.
  const blockedByReadability = readability.hard_fail
  const blockedByInference   = inference_direction === 'ambiguous_unhandled'
  const demoted = passes_all && (blockedByReadability || blockedByInference)
```

`hard_fail` removes the candidate from hook eligibility, and `penalty` orders the survivors:

```ts
// src/lib/agents/research/synthesize.ts:440-453
  const allPass = candidates.filter(c => c.passes_all)
  // Among the six-out-of-six candidates, only those clearing both gates are hook-eligible.
  const hookEligible = allPass
    .filter(c => !c.readability.hard_fail && c.inference_direction !== 'ambiguous_unhandled')
    // Lower readability penalty first: of two legal sentences, the plainer one wins.
    .sort((a, b) => a.readability.penalty - b.readability.penalty)

  if (hookEligible.length > 0) {
    const preferred = hookEligible.find(c => c.id === modelPreferredId)
    // Honour the model's pick only when it is no less readable than the best alternative.
    const winner = preferred && preferred.readability.penalty === hookEligible[0].readability.penalty
      ? preferred
      : hookEligible[0]
    return { winner, relevance: 'use_as_hook', demotionReason: null }
  }
```

### Call site 2 — `synthesize.ts:497`. CHANGES BEHAVIOUR.

```ts
// src/lib/agents/research/synthesize.ts:488-513
function applyTriggerReadabilityGate(
  triggerText: string,
  relevance: SignalRelevance,
  existingDemotionReason: string | null,
): {
  signal_relevance: SignalRelevance
  demotion_reason: string | null
  trigger_readability: CandidateReadability
} {
  const score = readabilityScore(triggerText)

  if (relevance !== 'use_as_hook' || !score.hardFail) {
    return {
      signal_relevance: relevance,
      demotion_reason: existingDemotionReason,
      trigger_readability: toCandidateReadability(score),
    }
  }

  const triggerNote = `trigger_text failed readability: ${score.reasons.join(' ')}`
  return {
    signal_relevance: 'mention_only',
    demotion_reason: existingDemotionReason ? `${existingDemotionReason} | ${triggerNote}` : triggerNote,
    trigger_readability: toCandidateReadability(score),
  }
}
```

`hardFail` demotes `use_as_hook` to `mention_only`. Called at `synthesize.ts:933`:

```ts
// src/lib/agents/research/synthesize.ts:928-937
  // Scrubbing rewrites the trigger (em dashes become full stops, AI tells are replaced),
  // so the readability verdict is recomputed on the text that actually ships.
  const scrubbedTrigger = result.trigger_text === null
    ? null
    : scrubAITells(result.trigger_text, `research/prospect/${prospect.id}`)
  const rescored = applyTriggerReadabilityGate(
    scrubbedTrigger ?? '',
    result.signal_relevance,
    result.demotion_reason,
  )
```

The `trigger_readability` field it returns is additionally logged at `synthesize.ts:964-966`.

### Call site 3 — `synthesize.ts:716`. DOES NOT CHANGE BEHAVIOUR.

```ts
// src/lib/agents/research/synthesize.ts:715-717
    // Measured on the proxy so the audit row still records its readability.
    trigger_readability: toCandidateReadability(readabilityScore(icp_pain_proxy)),
    demotion_reason: null,
```

This is inside `buildFallbackSynthesis`, which has already set `signal_relevance:
'no_signal'` (`synthesize.ts:704`) and `trigger_text: null` (`:708`). The score is stored on
the audit row and read by nothing.

### Call site 4 — `rerun-three-prospects.ts:103`. LOGGED ONLY.

```ts
// src/lib/agents/rerun-three-prospects.ts:103-107
    const ts = readabilityScore(result.trigger_text ?? '')
    console.log(`  sentences: ${ts.sentences.length}`)
    ts.sentences.forEach((s, i) => console.log(`    ${i + 1}. (${s.trim().split(/\s+/).length} words) ${s}`))
    console.log(`  hardFail=${ts.hardFail} penalty=${ts.penalty} maxSentenceWords=${ts.maxSentenceWords} hedges=[${ts.hedges.join(', ') || 'none'}]`)
    console.log(`  nominalisation=${(ts.nominalisation.density * 100).toFixed(1)}% over=${ts.nominalisation.exceedsThreshold} matches=[${ts.nominalisation.matches.join(', ') || 'none'}]`)
```

Printed to stdout in a diagnostic. Nothing branches on it.

---

# SECTION 6: THE GATE MODE MECHANISM

## 6a. On the checked-out tree

**NOT FOUND.**

```
$ grep -rni "SENTENCE_INITIAL" --exclude-dir=node_modules --exclude-dir=.git .
$ echo $?
1
```

No file named `sentence-initial-names.ts` or `ordinary-words.ts` exists at `HEAD`. The
`checkOpeningGates` function on this branch (`write-opening.ts:1002-1104`) has no mode
parameter, no `context` parameter, and seven gates rather than eight.

## 6b. On `origin/main`, where it does exist

All line numbers in this subsection are `origin/main`, retrieved with
`git show origin/main:<path>`. They are not valid against the working tree.

### How it is defined

```ts
// origin/main:src/lib/style/sentence-initial-names.ts:103-117
// REPORT-ONLY FIRST, BY INSTRUCTION. [REDACTED-PERSON], 2026-08-28: "One week in report-only, logging
// what it would have rejected with the prospect, the word and the sentence. Then I flip it
// manually after reading what it caught. A gate nobody has watched fire is a gate nobody
// has tested, and this one can cost quality if it is wrong."
//
// A CONSTANT, NOT A DATE. This file does not roll over on its own. An automatic flip would
// put the gate into blocking mode without anyone having read what it caught, which is the
// only thing the observation week is for.
//
// TO FLIP: change this to 'block', and record in BACKLOG what the week's logs showed.
export type SentenceInitialGateMode = 'report' | 'block'
export const SENTENCE_INITIAL_GATE_MODE: SentenceInitialGateMode = 'report'

/** Review date, for the BACKLOG entry and for whoever finds this later. */
export const SENTENCE_INITIAL_GATE_REVIEW_AFTER = '2026-09-04'
```

A module-level `const`. No environment variable, no database column, no feature-flag table.

### How it is read

```ts
// origin/main:src/lib/style/sentence-initial-names.ts:215-246
export function checkSentenceInitialNames(
  text: string,
  findingsText: string,
  context: { prospectId: string },
  /**
   * Defaulted to the module constant, which is what production uses. A PARAMETER ONLY SO
   * THE BLOCKING PATH CAN BE EXECUTED BY A TEST while the constant says 'report'.
   *
   * That is the point of the observation week, taken seriously: a flip that has never been
   * run is a flip nobody has tested, and finding out it was broken at the moment of
   * flipping is the worst time to find out. Production never passes this.
   */
  mode: SentenceInitialGateMode = SENTENCE_INITIAL_GATE_MODE,
): string[] {
  const hits = findSentenceInitialNames(text, findingsText)
  if (hits.length === 0) return []

  logger.warn('sentence-initial-gate: name-shaped word opening a sentence, not in findings', {
    ...context,
    mode,
    count: hits.length,
    hits: hits.map(h => ({ word: h.word, run: h.run, signal: h.signal, sentence: h.sentence })),
  })

  if (mode !== 'block') return []

  return [
    `opens a sentence with a name nothing in the findings supplied: ` +
    hits.map(h => `"${h.run}"`).join(', ') +
    `. Every name must come from the findings. Rewrite the sentence to open with what you ` +
    `can point to, or drop the name.`,
  ]
}
```

### How it is switched

By editing the literal on line 114 from `'report'` to `'block'` and redeploying. There is
no runtime switch. Production never passes the `mode` argument:

```ts
// origin/main:src/lib/agents/research/write-opening.ts:1061-1063
  failures.push(...checkSentenceInitialNames(
    opening, findingsText, { prospectId: context?.prospectId ?? 'unknown' },
  ))
```

Three arguments, so `mode` takes its default.

### Every place a mode value is read

| Location | Read |
|---|---|
| `origin/main:src/lib/style/sentence-initial-names.ts:227` | default-parameter read of `SENTENCE_INITIAL_GATE_MODE` |
| `origin/main:src/lib/style/sentence-initial-names.ts:234` | `mode` written into the log payload |
| `origin/main:src/lib/style/sentence-initial-names.ts:239` | `if (mode !== 'block') return []` — the only branch |
| `origin/main:src/lib/style/__tests__/sentence-initial-names.test.ts:264` | `expect(SENTENCE_INITIAL_GATE_MODE).toBe('report')` |
| `origin/main:src/lib/style/__tests__/sentence-initial-names.test.ts:280` | passes `'block'` explicitly to exercise the flip |
| `origin/main:src/lib/style/__tests__/sentence-initial-names.test.ts:337` | asserts the logged payload contains `mode: 'report'` |

That is the complete set. `checkOpeningGates` never reads a mode value; it reads only the
returned array.

## 6c. Is the mechanism generic and reusable by a second gate, or welded to that one gate?

**Welded to that one gate.** Three things decide it, all quoted.

**1. The type and the constant are both named for this gate, and the type is a closed
two-member union defined in the same file as the gate it serves:**

```ts
// origin/main:src/lib/style/sentence-initial-names.ts:113-114
export type SentenceInitialGateMode = 'report' | 'block'
export const SENTENCE_INITIAL_GATE_MODE: SentenceInitialGateMode = 'report'
```

There is no `GateMode` type, no registry keyed by gate name, and no shared module. A second
gate wanting the same behaviour would have to import a type called
`SentenceInitialGateMode` from a file called `sentence-initial-names.ts`, or declare its own.

**2. The mode is consumed inside the gate's own function body, not by a wrapper:**

```ts
// origin/main:src/lib/style/sentence-initial-names.ts:239
  if (mode !== 'block') return []
```

The report-versus-block decision is one line inside `checkSentenceInitialNames`. There is
no higher-order function, no `runGate(gate, mode)`, nothing another gate could be passed
into. The pattern is copyable but not callable.

**3. The caller has no mode-awareness at all.** `checkOpeningGates` appends the return
value to the same `failures` array every other gate pushes to:

```ts
// origin/main:src/lib/agents/research/write-opening.ts:1061-1063
  failures.push(...checkSentenceInitialNames(
    opening, findingsText, { prospectId: context?.prospectId ?? 'unknown' },
  ))
```

Compare with the adjacent gates, which push directly and have no mode concept whatsoever:

```ts
// origin/main:src/lib/agents/research/write-opening.ts:1046-1049  (same lines as HEAD:1040-1043)
  const untraceable = untraceableClaims(opening, findingsText)
  if (untraceable.length > 0) {
    failures.push(`claims not traceable to any finding: ${untraceable.join(', ')}`)
  }
```

Report-only is expressed as "return an empty array", which every other gate would have to
reimplement for itself. Nothing in `checkOpeningGates`, `writeAndJudgeOpening` or the style
modules provides a shared switch.

---

# SECTION 7: COMPOSITION

## 7a. Where the composed Email 1 body is assembled

Two functions assemble it, and they are deliberately kept side by side in the same file.

**Production send path** — `composeSequence`:

```ts
// src/lib/composition/compose-sequence.ts:220-232
  const variantEmails = getVariantEmails(messagingDoc, variantId)
  const afterTrigger: ComposedEmail[] = trigger.source === 'research'
    ? applyTriggerToEmail1(variantEmails, trigger.text)
    : variantEmails.map(email => ({ ...email }))

  // The written closing question, when research produced one. It replaces the approved
  // CTA and nothing else: the P3 offer line is the client's positioning and stays fixed.
  // Gated on the researched path for the same reason the opener is: without research
  // there is no prospect-specific question to ask, and the approved CTA is good copy.
  const afterQuestion: ComposedEmail[] =
    trigger.source === 'research' && prospect.personalisation_question
      ? applyQuestionToEmail1(afterTrigger, prospect.personalisation_question)
      : afterTrigger
```

**Research judge path** — `composeEmail1WithOpening`, `compose-sequence.ts:325`:

```ts
// src/lib/composition/compose-sequence.ts:343-358
): ComposedEmail {
  const variantEmails = getVariantEmails(messagingDoc, variantId)
  const withOpening = applyTriggerToEmail1(variantEmails, opening)
  const withQuestion = question ? applyQuestionToEmail1(withOpening, question) : withOpening
  const counted = withQuestion.map(email => ({ ...email, word_count: countWords(email.body) }))
  const withFooter = appendOptOutFooter(counted)

  const email1 = withFooter.find(e => e.sequence_position === 1)
  if (!email1) {
    throw new Error(`composeEmail1WithOpening: variant "${variantId}" has no email at position 1`)
  }

  if (firstName === undefined) return email1
  // Same substitution as composedToVariables, including the empty-string fallback.
  return { ...email1, body: email1.body.replace(/\{\{first_name\}\}/g, firstName ?? '') }
}
```

The messaging document supplies the frame; `getVariantEmails` (`compose-sequence.ts:791`)
reads `messagingDoc.variants[variantId].emails`. The observation and bridge replace the P2
slot:

```ts
// src/lib/composition/compose-sequence.ts:818-855
function applyTriggerToEmail1(emails: StoredEmail[], trigger: string): ComposedEmail[] {
  return emails.map(email => {
    if (email.sequence_position !== 1) return email

    // Ensure the trigger ends with terminal punctuation.
    //
    // Tested for a full stop ONLY until 2026-08-20, which appended one after any other
    // ending. The trigger is now the observation and the bridge, and the bridge is last, so
    // a bridge closing on '?' or '!' shipped as "...after that hire?.". The writer is now
    // gated against a question mark in the opening, which stops it at the source; this is
    // the second line of defence and mirrors applyQuestionToEmail1, which has always
    // accepted the punctuation it was looking for.
    const formattedTrigger = /[.!?]$/.test(trigger.trimEnd())
      ? trigger.trimEnd()
      : trigger.trimEnd() + '.'

    const lines = email.body.split('\n')

    // Find {{first_name}} line and the opener (first non-empty line after it).
    let firstNameIdx = lines.findIndex(l => l.trim() === '{{first_name}}')
    if (firstNameIdx === -1) firstNameIdx = -1

    const openerIdx = lines.findIndex(
      (l, i) => i > firstNameIdx && l.trim().length > 0
    )

    if (openerIdx === -1) {
      return {
        ...email,
        body: `{{first_name}}\n\n${formattedTrigger}\n\n${email.body}`.trim(),
      }
    }

    const newLines = [...lines]
    newLines[openerIdx] = formattedTrigger

    return { ...email, body: newLines.join('\n') }
  })
}
```

Note the selection rule here: the opener is the **first non-empty line after the
`{{first_name}}` line**, found by index.

The P3 the writer was briefed with comes from the same document:

```ts
// src/lib/composition/compose-sequence.ts:362-383
export function getVariantEmail1Frame(
  messagingDoc: MessagingContent,
  variantId: string,
): { subject: string | null; p3: string; cta: string; authoredOpening: string } {
  const emails = getVariantEmails(messagingDoc, variantId)
  const email1 = emails.find(e => e.sequence_position === 1)
  if (!email1) throw new Error(`getVariantEmail1Frame: variant "${variantId}" has no email at position 1`)

  // P1 greeting, P2 slot, P3 what changes, P4 CTA, P5 sign-off.
  const paras = email1.body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !/^\{\{first_name\}\},?\s*$/.test(p))

  return {
    subject: email1.subject_line,
    authoredOpening: paras[0] ?? '',
    p3: paras[1] ?? '',
    cta: paras[2] ?? '',
  }
}
```

## 7b. The function that substitutes the closing question, and how it selects the paragraph

```ts
// src/lib/composition/compose-sequence.ts:288-311
// Replaces Email 1's CTA paragraph with a written question.
//
// The CTA is the paragraph immediately before the sign-off block, and the sign-off is
// always last with nothing after it (the opt-out footer is appended later, downstream of
// this). So the CTA is the second-to-last paragraph, which is a structural fact rather
// than a guess about content.
//
// The approved P3 offer line is never touched: it is the client's positioning and what
// they approved. Only the closing question moves.
function applyQuestionToEmail1(emails: ComposedEmail[], question: string): ComposedEmail[] {
  return emails.map(email => {
    if (email.sequence_position !== 1) return email

    const paras = email.body.split(/\n{2,}/)
    if (paras.length < 3) return email   // nothing that looks like a CTA to replace

    const ctaIdx = paras.length - 2
    const formatted = question.trim().endsWith('?') ? question.trim() : `${question.trim()}?`

    const next = [...paras]
    next[ctaIdx] = formatted
    return { ...email, body: next.join('\n\n') }
  })
}
```

**Selection rule, stated precisely:** the body is split on runs of two or more newlines.
If fewer than three chunks result, nothing is replaced and the email is returned unchanged.
Otherwise the target is `paras.length - 2`, the second-to-last chunk, chosen positionally
on the structural claim that the sign-off block is always last. Nothing about the
paragraph's content is inspected. The only content operation is appending a `?` if the
question does not already end with one.

## 7c. Does any validation run after composition and before persistence or dispatch?

**NOT FOUND** for any validation of the copy.

Between `composeSequence` and the upload there are exactly two checks, and neither
inspects the text.

Composition, then the two checks, then dispatch:

```ts
// src/app/dashboard/operator/clients/[id]/actions.ts:609-616
        const composed = await composeSequence({
          prospect_id: row.id,
          client_id: orgId,
          preloadedDocs: composeDocs,
        })

        const vars = composedToVariables(composed.emails, row.first_name ?? null)
        assertCompleteVariables(vars, docStepCount)
```

`assertCompleteVariables` checks key presence and non-emptiness only:

```ts
// src/lib/composition/custom-variables.ts:41-57
export function assertCompleteVariables(
  vars: Record<string, string>,
  stepCount: number,
): void {
  for (let n = 1; n <= stepCount; n++) {
    if (!(`m_subject_${n}` in vars)) {
      throw new Error(
        `compose-variables: missing m_subject_${n} (step ${n} of ${stepCount})`
      )
    }
    if (!(`m_body_${n}` in vars) || vars[`m_body_${n}`].trim() === '') {
      throw new Error(
        `compose-variables: missing or empty m_body_${n} (step ${n} of ${stepCount})`
      )
    }
  }
}
```

The second check is a suppression gate on recipients, not on copy:

```ts
// src/app/dashboard/operator/clients/[id]/actions.ts:668-682
  // ── FINAL SAFETY CHECK — the gate that owns correctness ───────────────────
  // Last checkpoint before the Instantly upload. Checks BOTH suppression gates in one
  // function (findBlockedProspects): the per-organisation one (prospects.suppressed and
  // client_review_status) and the global bounce/unsubscribe list (suppressed_emails).
  ...
  const finalGate = await findBlockedProspects(
    supabase,
    orgId,
    (rawRows ?? []).filter(r => claimedIdSet.has(r.id)).map(r => ({ id: r.id, email: r.email }))
  )
```

Dispatch:

```ts
// src/app/dashboard/operator/clients/[id]/actions.ts:766
      const result = await uploadLeads(orgId, campaignExternalId, leads, campaignId)
```

`grep -n "validate\|assert\|check\|gate" src/lib/integrations/handlers/instantly/uploadLeads.ts`
returns two lines, one about an environment-misconfiguration flag (`uploadLeads.ts:40`) and
one about row-update failures (`:120`). Neither reads the body.

Word count is recomputed at composition, but it is stored, not gated:

```ts
// src/lib/composition/compose-sequence.ts:269-272
    // Recompute word_count from the body rather than trusting the stored count. On this
    // path P2 was not replaced, so the stored count should already agree; recomputing
    // keeps one source of truth and costs nothing.
    composedEmails = afterQuestion.map(email => ({ ...email, word_count: countWords(email.body) }))
```

The word-count ceiling that exists in this file governs nothing, by its own comment:

```ts
// src/lib/composition/compose-sequence.ts:880-886
// While BRIDGE_ENABLED is false, BRIDGE_HEADROOM and EMAIL1_MAX_WORDS govern NOTHING.
// They are reachable only inside the disabled branch. The live Email 1 word ceiling is
// EMAIL_WORD_LIMITS.email1MaxWords in the messaging agent, enforced at generation.
const BRIDGE_ENABLED    = false

const EMAIL1_MAX_WORDS  = 90
const BRIDGE_HEADROOM   = Math.floor(EMAIL1_MAX_WORDS * 0.9)  // 81 words
```

```ts
// src/lib/composition/compose-sequence.ts:904-905
      const useBridgePath = prospect.has_dateable_signal === true && prospect.signal_relevance === 'use_as_hook'
      if (!BRIDGE_ENABLED || !useBridgePath) return withCount(email.body)
```

---

# SECTION 8: CLIENT-SPECIFIC CONTENT IN THE GATE PATH

Limited to the files listed in Section 1. Report only.

## 8a. `src/lib/agents/research/write-opening.ts`

The writer system prompt is the largest concentration. Every literal below is inside the
string returned by `buildWriterPrompt()` (lines 163-807) or in comments in the same file,
and is therefore sent to the model on every writer call.

### Named people

| Line | Literal, redacted |
|---|---|
| 6, 31, 32, 764 | `[REDACTED-PERSON]` (one first name, four occurrences) |
| 31 | `[REDACTED-PERSON]` (a second first name) |
| 826 | `[REDACTED-PERSON]'s` |
| 1048, 1073 | `[REDACTED-PERSON]'s` |
| 1373 | `[REDACTED-PERSON] and [REDACTED-PERSON]` |

### Named companies and organisations

| Line | Literal, redacted |
|---|---|
| 6, 764 | `[REDACTED-COMPANY]` (prospect's former employer) |
| 270 | `[REDACTED-COMPANY]` |
| 290, 518 | `[REDACTED-COMPANY]` |
| 335, 764 | `[REDACTED-COMPANY]` |
| 512, 518-519 | `[REDACTED-ORG]`, `[REDACTED-ORG]`, `[REDACTED-ORG]` (three institutions in one worked example) |
| 524, 530 | `[REDACTED-ORG]` and `[REDACTED-ORG]` (two named board seats) |
| 525, 531, 924 | `[REDACTED-COMPANY]` (and its possessive form in the gate comment) |
| 666, 705, 707, 724 | `[REDACTED-ORG]` (a named business school programme) |
| 674, 719, 724 | `[REDACTED-ORG]` (a named trade show) |
| 769 | `[REDACTED-COMPANY]` and `[REDACTED-COMPANY]` |
| 270, 272 | `Chamber event` / `chamber event` — a named organisation type |

### Sector and buyer-type vocabulary

| Line | Literal |
|---|---|
| 164 | `You are a senior BDR with fifteen years behind you` |
| 167 | `You are writing to a founder you respect` |
| 258 | `a founder who reads a wrong claim` |
| 272 | `exactly how a great many consultancies fill capacity` |
| 298 | `"The founders who need you next are not reading your feed yet."` |
| 337 | `Never tell a founder what he has decided to put first.` |
| 358-359 | `"A product shop builds an audience of people who browse. The founders ready to hire a consultant rarely find you through the same door."` |
| 361 | `so this also tells her the thing she just built is not` (worked example, consulting shop) |
| 364 | `"The founders who need you next are reading that feed."` |
| 389 | `"Outreach for the consulting side sits until it does not."` |
| 395 | `"the advisory work fills the diary, ..."` |
| 412 | `"Here's the assumption most consulting founders make"` and `"Most firms at this stage find"` |
| 434 | `"The founders I speak to describe the same split. Board dates are fixed. Selling is what moves."` |
| 452 | `None of them is about consulting, agencies or outbound.` |
| 600 | `"A day job and active delivery leave the consulting pipeline running on whatever is left..."` |
| 647 | `"Outreach for the consulting side gets whatever hours remain..."` |
| 654 | `"The founders who hear it and are ready to buy tend to need a nudge..."` |
| 757 | `A senior seller does not tell a founder their website is thin.` |
| 873 | `Which one could a busy founder read once, at speed` (judge prompt) |
| 955 | `/\b(?:firms|companies|founders|businesses|teams|clients) we (?:work with|serve|help|support)\b/i` — buyer nouns in a gate regex |

### Named industries used as worked examples

Lines 458-472 name six industries explicitly, and line 275 a seventh:

| Line | Literal |
|---|---|
| 275 | `deliberately about a PRINT SHOP` |
| 459 | `A dentist:` |
| 463 | `A commercial builder:` |
| 467 | `A freight broker:` |
| 471 | `A wedding photographer:` |

These are labelled in the prompt as deliberately foreign to the target industry
(`write-opening.ts:451-456`), which is the opposite intent from the consulting vocabulary
above.

### Currency and revenue bands

| Line | Literal, redacted |
|---|---|
| 1048 | `"a $5M consulting firm" in [REDACTED-PERSON]'s opening` |

The currency and band patterns themselves are in `firmographic.ts`, below.

## 8b. `src/lib/style/firmographic.ts`

| Line | Literal, redacted |
|---|---|
| 5-6 | `"Most B2B consulting firms at the £500K to £5M mark"` and `"For most consulting founders billing north of £500K"` |
| 7 | `consulting firm" in [REDACTED-PERSON]'s opening` |
| 44 | `"You launched [REDACTED-COMPANY] within three months of leaving [REDACTED-COMPANY] and have been running it solo since"` |
| 27 | `{ pattern: /[£$€]\s?\d/, label: 'a currency amount' }` — three currency symbols, hardcoded |
| 28 | `/\b\d+(?:\.\d+)?\s*[km]\b/i` with the label `'a figure like 500K or 5M'` |
| 24 | `NUMBER_WORD` list, English only |
| 76-87 | `FIRMOGRAPHIC_RULE_TEXT`, sent into the writer prompt at `write-opening.ts:759`. Contains `"5M"`, `"team of 12"`, `"a two-person firm"`, `"a team of five"`, `"a firm that size"`, `"a one-man band"` |

## 8c. `src/agents/messaging-generation-agent.ts`

| Line | Literal, redacted |
|---|---|
| 50 | `Do not assume the prospect is a founder or runs a consulting firm unless the ICP document explicitly says so.` — names both the buyer type and the industry inside a variant-angle instruction |
| 487, 503, 506 | `founder_first_name` column, and the operator-facing error `'Founder first name is missing.'` |
| 800 | `"We get more conversations into your diary."` |
| 810 | `it tells a consultant what happens` |
| 813 | `"We keep the diary filled without you writing anything."` |
| 840 | `A researched prospect got: "You ran [REDACTED-COMPANY] and the [REDACTED-ORG]` |
| 855 | `"We break that ceiling by running outbound that puts conversations in your diary."` |
| 858 | `"We run the outbound so the diary fills without you writing anything."` |
| 876-879 | `"Most B2B consulting founders at your stage are in the same spot: delivery is solid, ... referrals they can't control. One warm intro every few weeks keeps the lights on..."` |
| 884 | `"A project ends and the diary empties. No referrals lined up, no outreach running,"` |
| 889 | `"Most founders we speak to find...", "The pattern with firms` |
| 893 | `"Most of the pipeline comes from referrals"` |
| 940-941 | `"Most B2B consulting firms at the £500K to £5M mark"` / `"For most consulting founders billing north of £500K"` |
| 1127 | `"at the £500K to £5M mark" and "billing north of £500K" both fail.` |
| 1629-1637 | `BANNED_JARGON` — `ICP`, `top of funnel`, `TOFU`, `buyer persona`, `value prop`, `go-to-market`, `funnel metrics`. B2B-marketing vocabulary, English only |

## 8d. `src/lib/agents/research/prompts/synthesis-prompt.ts`

| Line | Literal, redacted |
|---|---|
| 105 | `founder's revenue and pipeline situation. Always generate it as a candidate.` |
| 185-187 | `"Running [REDACTED-COMPANY] alongside the [REDACTED-ORG] Director engagement from mid-2024 through ... the pipeline question for [REDACTED-COMPANY] tends to land differently."` |
| 196 | `"Read through your last 30 reviews on Google. Front desk hold times keep` — a dental/clinic worked example |
| 207 | `as "Apollo employment_history: Director at [REDACTED-ORG], Jul 2024 to Aug 2025"` |
| 219 | `Worked case. The fact: a founder ran their own firm alongside a second role` |
| 282-285 | `performance review coaching, HR policy for founders. [REDACTED-COMPANY] has been a solo operation since 2018.` and the paired trigger naming `[REDACTED-COMPANY]` again |
| 289 | `"Most founders of boutique DEI consultancies at this stage hit the same wall"` |
| 317 | `The prospect posted about their own pipeline going quiet between referrals.` |
| 321, 325 | `A consultant whose entire practice is built around solving Problem X publishes` / `A consultant publishes a framework for their clients' architecture.` |
| 396 | `✗ "Taking a job at [REDACTED-ORG] suggests your pipeline was thin."` |
| 454 | `Trigger: "Given your work in consulting, I'm sure you're dealing with feast-or-famine."` |

## 8e. `src/lib/style/readability.ts`

| Line | Literal, redacted |
|---|---|
| 8-10 | `"Running [REDACTED-COMPANY] alongside the [REDACTED-ORG] Director engagement from mid-2024 through mid-2025 is a particular kind of balancing act, and with that role now wrapped, the pipeline question for [REDACTED-COMPANY] tends to land differently."` |
| 15-16 | `"Read through your last 30 reviews on Google. Front desk hold times keep coming up, 4 of the most recent 10."` — dental/clinic vocabulary, described at line 13 as `from a campaign that replied at 7 percent` |
| 60-70 | `HEDGE_PHRASES` — 30 English-only literal phrases |
| 57-58 | `SPECIFIC pushes observations to carry dates, so "since May 2024" would fire a false hedge` — English month names |

## 8f. `src/lib/style/back-reference.ts`

| Line | Literal, redacted |
|---|---|
| 7-9 | `P2 "Referrals feel like the safe channel. But they're not a pipeline. They're a ceiling. The size of your network sets your revenue cap..."` / `P3 "We break that ceiling by running outbound that puts the right conversations in your diary."` |
| 12-13 | `the email reads: "You ran [REDACTED-COMPANY] and the [REDACTED-ORG] Director role side by side for 13 months. That wrapped in August 2025..."` |
| 104-105 | `"at this stage" and "founders in that position"` |
| 163-165 | `"it" is outbound, named in P2. ... a researched D prospect received: "You ran [REDACTED-COMPANY] and the [REDACTED-ORG] Director role..."` |
| 183 | `("founders find THAT doing more never helps")` |
| 52-101 | `NON_NOUN_FOLLOWERS` — 200+ English word forms. The whole gate is English-only |
| 77-81 | verbs added `because they are essentially never nouns in this register`: `outsource`, `delegate`, `prioritise` — B2B-services register |
| 107-109 | `IDIOMATIC_NOUNS` — `stage`, `point`, `position`, `spot`, `days`, `week`, `month`, `year` |

## 8g. `src/lib/style/sentence-frames.ts`

| Line | Literal, redacted |
|---|---|
| 5-6 | `the research synthesist produced "is a particular kind of balancing act" and "is a particular kind of juggle"` |
| 17-18 | `"Running [REDACTED-COMPANY] alongside the [REDACTED-ORG] engagement" and "Running [REDACTED-COMPANY] alongside the [REDACTED-ORG] role"` |
| 100-101 | `phrases like "most consultants at your stage" are legitimate shared vocabulary` |
| 104-105 | `"We book meetings for [REDACTED-COMPANY]" and "We book meetings for [REDACTED-COMPANY]"` (placeholder company names) |
| 96-97 | `variants A, B and C all ended Email 1 with "You take the calls and close them."` |
| 68 | `if (index > 0 && /^\p{Lu}/u.test(word)) return MASK` — capitalisation-as-proper-noun, an assumption about Latin-script prose |

## 8h. `src/lib/style/nominalisation.ts`

| Line | Literal, redacted |
|---|---|
| 6-7 | `the failure mode in a line like "the pipeline question for [REDACTED-COMPANY] tends to land differently"` |

## 8i. `src/lib/style/abstract-nouns.ts`

| Line | Literal |
|---|---|
| 27-36 | `ABSTRACT_NOUNS` — `remainder`, `engine`, `momentum`, `capacity`, `bandwidth`, `cadence`, `motion`, `flow`. English-only; `capacity`, `bandwidth` and `cadence` are B2B-services register |
| 22-25 | `"a real operational load"` / `"that output shows"` |
| 70-73 | `"business development is the thing that moves when something has to"`, `"tend to need a nudge before they become a conversation"` |
| 85-93 | `FIGURATIVE_VERBS` — `move`, `shrink`, `become`, `convert`, `translate`, `materialise`, `materialize` |

## 8j. `src/lib/composition/compose-sequence.ts`

| Line | Literal |
|---|---|
| 246 | `?? 'consistent outbound pipeline without founder involvement'` — a hardcoded default value hook naming the buyer type |
| 786 | `` return `Most ${subject} I speak to at this stage are dealing with the same pipeline problem.` `` — hardcoded pain vocabulary in the role proxy |
| 721-722 | `The previous version hardcoded "founders", which is wrong for any client whose buyer is not a founder and violates the industry-agnosticism rule in CLAUDE.md.` |
| 756-759 | `"Chief Executive Officer and Managing Partner"`, `"CEO"`, `"VP of Operations"`, `"Head of Logistics"` — buyer titles in worked examples |
| 873 | `pipeline", which restates P2 in vaguer words and fails the picture test.` |

`compose-sequence.ts:786` is reachable only through `buildRoleProxy`, which sits below
`TRIGGER_FALLBACKS_ENABLED = false` (`compose-sequence.ts:588`). `compose-sequence.ts:246`
is live on the researched path.

## 8k. `src/lib/composition/personalization.ts`

| Line | Literal |
|---|---|
| 44 | `` `You write short personalization sentences for B2B cold email.`` |
| 55 | `"[10-20 word sentence connecting the trigger to the pain the sender solves...]"` |

Unreachable at runtime (`BRIDGE_ENABLED = false`), but present in source.

## 8l. `src/lib/agents/research/types.ts`

| Line | Literal, redacted |
|---|---|
| 41-42 | `"[REDACTED-PERSON]'s [REDACTED-ORG] role ended, so he needs pipeline" reads the same facts as "[REDACTED-PERSON] left [REDACTED-ORG] because [REDACTED-COMPANY] got busy"` |

## 8m. `src/lib/agents/research/synthesize.ts`

| Line | Literal, redacted |
|---|---|
| 431 | `the [REDACTED-ORG] fact should still be FOUND, it just may not be used as written.` |

## 8n. `src/lib/style/ordinary-words.ts` — `origin/main` only

This file is the discriminator for the Section 6 gate. Its third vocabulary block is
B2B-services specific.

| Line (`origin/main`) | Literal |
|---|---|
| 17 | `"[REDACTED-COMPANY]" is not English, and no edit to any prompt changes that.` |
| 24 | `It contains "[REDACTED-COMPANY]" and "[REDACTED-PERSON]".` (both lowercased in the original) |
| 30-31 | `That is why "treasury" and "cave" are absent. Both are real words, and both appear in the writer prompt as parts of names.` |
| 42-46 | `ONE WORD IN THIS LIST TRIPS THE TOOL-NAME PRE-COMMIT SCAN: "instantly", the adverb` |
| 207-225 | The business vocabulary block: `advisory`, `billing`, `bottleneck`, `churn`, `coach`, `coaching`, `commission`, `consultancy`, `consultant`, `consulting`, `copywriting`, `diary`, `enquiry`, `freelance`, `funnel`, `governance`, `headcount`, `inbound`, `nurture`, `outbound`, `outreach`, `outsourcing`, `pitch`, `positioning`, `prospecting`, `quota`, `referral`, `retainer`, `testimonial`, `upsell`, `webinar` and roughly 150 others |
| 121, 125, 127 | `pipeline`, `prospect`, `referral` in the general-noun block |
| 50-225 | The entire list is English lemmas. A non-English-language client's copy would be treated as names throughout |

## 8o. `src/lib/agents/vendor-name-gate.ts` — `origin/main` only

Out of scope for email copy (it gates strategy documents) but found by the Section 1 greps.

| Line (`origin/main`) | Literal |
|---|---|
| 6-10 | `The vendor name "Apollo" appeared TWICE in icp-agent.md and THIRTY-THREE times in stored generated documents ... including twice in tier_3.disqualifiers` |
| 38-40 | `"apollo" and "instantly" appear ZERO times in intake_responses and intake_website_pages across all five organisations` |
| 44 | `A client who mentions a vendor incidentally ("we tried Apollo once" in intake)` |
| 50-51 | `"Apollo-detectable:", "Checkable via Apollo revenue estimates", and "no visible team beyond the founder on Apollo or LinkedIn"` |
| 60 | `VENDOR_NAMES` list |
