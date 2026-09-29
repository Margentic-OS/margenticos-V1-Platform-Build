# Copy-writing work: handover

Written 2026-09-29 so a fresh session can continue without the originating conversation.

**RULE ZERO, AND IT APPLIES TO THIS FILE.** This repository is PUBLIC. No prospect or client
name appears below. Every example is referred to by prospect id. If you add an example, add the
id, not the name, and check `src/__tests__/redacted-identities.test.ts` passes before pushing:
a real name in a worked example is the exact mistake CI caught on this branch's predecessor.

---

## 1. Branch state

Branch `copy-writing`, cut from `main`. Both commits are PUSHED; `local == remote` was confirmed
by SHA after each push.

| SHA | what it does |
| --- | --- |
| `5acb2ea3e9b06a5d4b7f2b0afe551d4e9747fbfa` | Item 1. The Email 1 writer's PROMPT carries only the chosen candidate plus a supporting event. The gate corpus stays wide. |
| `e3cae9d363b6cd71fc372712ff235fc233ebf797` | Item 2. A candidate whose content is an absence ABOUT THE PROSPECT is not eligible to be a hook. |

`e3cae9d` is the branch tip. Nothing is merged, and nothing should be merged until the operator
has read the item 6 A/B.

**MAIN MOVES UNDER YOU.** It moved four times during this work, twice mid-merge. Always
`git fetch origin` and read `git rev-parse origin/main` rather than trusting a SHA written
anywhere, including here. At the time of writing the merge base was
`a9f6f68158e5cc4dc7ae142197da5aed6b3fe60e`, and it will not be that for long. If taking main in
creates a merge commit, CI must be green on THAT commit, not on the one it superseded.

---

## 2. Done

### Item 1 — the Email 1 prompt sees one fact

`write-opening.ts` builds two corpus strings. `buildFindingsBlock` is the writer's prompt;
`buildFindingsEvidence` is what the gates substring-match against. Only the prompt narrowed, via
`narrowToChosen(candidates, selectedCandidateId, supportingCandidateId)`.

Why: one prospect's Email 1 shipped a sentence that appears in no part of its chosen candidate.
It came from another finding in the block. A numbered list of facts invites the writer to draw on
all of them, and synthesis has already chosen, with a reason recorded.

The asymmetry is deliberate. Traceability asks where a phrase COULD have come from, so its corpus
must include everything the writer was ever shown. Narrowing both would turn a name half
remembered from a previous attempt into an invented one.

**Controls** (`src/lib/agents/research/__tests__/narrow-to-chosen.test.ts`, 10): the leaked
sentence cannot appear in the narrowed block; the SAME builder demonstrably carried it before
narrowing; the gate corpus still carries it; a higher-scoring runner-up is dropped; and all four
fallback paths return the full list rather than nothing. Mutation-proved: disabling the narrowing
turns 5 red.

**A predicted hazard that was imaginary, recorded so nobody re-derives it.** It looked as though
narrowing the prompt would cause new NUMBER rejections, because `untraceableClaims` checks numbers
against prompt-block-plus-evidence. It cannot: the evidence half is still the full candidate array.
Measured 0 lost numbers across 60 stored Email 1s. That zero was not trusted — a positive control
was built to force a detected loss and it FAILED, and it failed because the instrument faithfully
copies the real gate. The blindness was the evidence the hazard did not exist.

### Item 2 — an absence is not a hook

`absenceAboutThem` in `src/lib/style/absence-about-them.ts`, wired into `isHookEligible` in
`synthesize.ts` via `namesAnAbsence`.

The trigger gate's own `findEvidenceAbsences` finds absence LANGUAGE anywhere in a string. Used to
DISQUALIFY a candidate it over-fires: measured across 601 real candidates it flagged 13, three
wrongly. All three were dated things the prospect DID, with the absence belonging elsewhere —
inside a relative clause about a third-party group, inside a quoted article title they published, and as
the published topic. The wrapper removes quoted spans, then requires the absence to sit in a clause
naming them, their firm, one of their own surfaces, or a second-person possessive.

**Measured after narrowing:** 13 of 230 eligible candidates excluded (5.7%); 4 prospects lose every
candidate and correctly decline to write; 6 had an absence as their chosen fact.

**Controls** (`absence-not-a-hook.test.ts`, 13) cover all three false-positive shapes and the
list-comma case. Mutation-proved: removing the anchor test turns the third-party case red.

**Reach is partial, and this is the most important thing to know before testing it.**
`isHookEligible` runs inside synthesis. A FRESH run excludes the candidate from selection. A REUSE
run reads `selected_candidate_id` off the row and does not re-select, so it does NOT retroactively
change a prospect already researched. What a reuse run does get is `hasUsableCandidate`, which
routes through this predicate, so a prospect whose only eligible candidate was an absence now
declines to write rather than writing an absence hook. The item 6 harness re-synthesises, so the
test WILL show the full effect; production reuse runs will not.

---

## 3. Still to do, in order

### Item 3 — the need must match the offer

A check that the need an email names (Email 1's bridge and its question; the follow-up arguments)
is one the client's POSITIONING document says the service addresses, citing the supporting line.
Code verifies the cite is a real substring. Failures retry, then fall back to template.

- Positioning lives in `strategy_documents`, `document_type='positioning'`, `status='active'`,
  `content` jsonb. The live active document has 9 top-level keys and **71 string leaves**. There is
  no TypeScript type for it; every reader casts.
- `loadClientContext` (`synthesize.ts`) currently reduces it to TWO strings. Add a
  `positioningText` built by flattening all leaves, and mark it optional for the same reason
  `fitDimensions` is: batch rows written before the field read back undefined.
- Model the verifier on `scripts/derive-trigger-reasons.ts`, which already exports
  `checkQuotesAreReal`. Do NOT copy its bare `JSON.parse`; wrap in the never-throws shape of
  `fact-check-opening.ts` so a verifier outage cannot take copy down.
- Wire it into the existing closure in `produce-opening.ts` that already injects the Email 1
  fact-check. No edit to `write-opening.ts` is needed.
- **It must cover the QUESTION, not only the bridge.** The operator's failing example was a CTA.

### Item 4 — guess detectors on Email 1: MEASURE FIRST, DO NOT SWITCH ON

Run `findAssumedCapacityClaims` and `checkActivityVerdict` over every stored Email 1 from the last
two weeks with NO model calls. Quote every hit, mark it true or false positive, and recommend
blocking ONLY if false positives are rare. **Do not enable it until the operator agrees.**

Controls: a line about the reader's hours competing with their second company is a hit; an offer
line in second person ("You stop chasing the calendar") is not.

### Item 5 — the reviewer, report only

An automated reviewer applying the operator's hard-fail rubric: invented fact; guess about the
reader's time, money, clients or who sells; claim about their audience; wrong or mismatched fact;
third person; follow-up about a different fact; a need the offer does not serve. It records verdicts
and NEVER blocks. Score "bridge does not follow from the fact" **separately, as soft, never a fail**.

**STORAGE IS SERVICE-ONLY AND THIS IS NOT NEGOTIABLE.** Not on `prospect_research_results`, which
clients can reach. A new table, modelled on `research_usage`. Follow the database-security rules in
CLAUDE.md exactly: enable RLS, then `REVOKE` BY NAME from `anon` and `authenticated`, `GRANT` to
`service_role`, and read `has_table_privilege` back for all three roles in BOTH directions before
committing. RLS with no policies is not sufficient on its own — the grant underneath it is what the
2026-08-25 incident was about.

Calibrate against the operator's marks: the 15-prospect sample in `READING-FINAL-20260928.md` and
the prospects flagged during the week. Report agreement on BOTH the fails and the passes — a
reviewer that agrees only on fails is a reviewer that rejects everything.

### The rule on lines about strangers

Decided by the operator, and it must be ENCODED, because the fact-check currently rejects the
allowed form:

- **ALLOWED** — defines a group and says what it will not do: "Buyers who have never heard of X
  won't find this on their own."
- **A CLAIM NEEDING A FINDING** — asserts a fact about the market's awareness: "Buyers have not
  heard of X yet."

Syntactically: the allowed form is a restrictive relative clause plus a modal about future
behaviour; the rejected form asserts a present state of awareness. Four prospects were templated on
2026-09-28 by the rejected form and one by the allowed form, i.e. one false positive, so this is
worth getting right before item 3 leans on the same sentences.

### Two factual checks

- **(a) Relative time at UPLOAD, not only at writing time.** "this week", "last month" are written
  days before a sequence sends, and the interval is set by the sending tool. `findRelativeTimeFaults`
  exists (`src/lib/style/relative-time.ts`) and runs at writing time. The check has to run against
  the SEND date at upload.
- **(b) No past tense for an upcoming event.** Where the research says "is leading", the copy must
  not say "You led". The candidate carries `date`; compare against the run clock and the tense used.

### Item 6 — the A/B on 40

`scripts/run-cost-arm.ts` ALREADY re-synthesises from stored raw sources. That capability is missing
from the production research agent, not from the harness — a Backlog row says it is missing and is
about the agent; do not read it as meaning the harness lacks it.

**FIX THE CEILING FIRST.** `spent` omits follow-up cost, so `--ceiling 25` permits roughly a third
more than it states and the cap is not enforced. Add
`const followupUsd = opening.followup_usage ? usdForUsage(opening.followup_usage) : 0` to the sum;
`scripts/export-writer-run.ts` has the precedent.

Then add follow-ups to the replay (`writeFollowupEmails: true` inside the existing `produceOpening`
call) — better as a CLI flag, so both arms are provably the same binary differing by one boolean.
The replay holds no Supabase client for the writer, so follow-up copy exists only in memory and in
the output files. Nothing reaches the database.

**The 40 must include these ids**, plus random others:

```
  a17aee8a-72b9-4e48-9521-22c829e42616
  0988c671-1068-4822-b768-e4028a78b039
  1d48ae98-cb02-472a-81bc-413c2e678172
  2e4a36ef-bf84-41dd-b953-5c833947d621
  59c53e88-5ad0-46c6-a1e7-51349a7f3f9b
  31ebdeaf-6102-4f03-9a76-ed21efeefd67
```

The operator named twelve prospects for the 40. Resolve them from
`READING-FINAL-20260928.md` and the cohort list rather than from names in this file. All twelve were
verified present, researched, and `outbound_upload_status = 'pending'`.

**Pass bar, fixed by the operator in advance:** hard fails in their read near zero for the new code;
the personalised rate no more than 10 points below current; every new rejection quoted with its
cause so over-tightening is visible. **Report the rate against the bar; do not tune a gate to meet
it.** Blind reading file, arms hidden. Spend cap $25.

---

## 4. Decisions already settled, and dead ends

Do not reopen these, and do not restate them here. They are recorded in Notion:

**MargenticOS — Company Brain → "Messaging and Copy: The Record"**
<https://app.notion.com/p/3e613d8aec6781a0b64fe12fe14858e9>

Its subpages carry: how an email is made today; principles and dead ends (including approaches that
made copy WORSE, such as giving the writer a client brief or voice samples); the experiment and
decision log; the open agenda; and the cost picture. Read "2. Principles and dead ends" before
proposing any change to how the writer is prompted — several obvious ideas have been tried and
measured as worse.

Two dead ends found in THIS session and recorded in code comments rather than Notion:

- Date precision does not separate a true absence hook from a false one. Day-precise dates appear
  on both, so a date rule keeps the absence survey and drops the dated post.
- Splitting an observation on every comma to find clause boundaries breaks list commas, which is
  where absence phrases usually sit.

---

## 5. Traps from this session

1. **COMMIT BEFORE MUTATION TESTING.** `git checkout --` reverts the WHOLE file. Mutation-testing
   uncommitted work destroyed a completed change once here and cost a re-implementation.
2. **SHAs ONLY FROM `git`.** A fabricated SHA was typed into a deploy poll and would have run 20
   minutes to a false timeout. Derive them: `TARGET="sentry-release=$(git rev-parse HEAD)"`.
3. **EMAIL 1 AND ITS FOLLOW-UPS MUST READ THE SAME RESEARCH ROW.** Email 1 is written by the
   research run from the row it produced; `current_research_result_id` IS that row. Follow-ups were
   written by the backfill from whatever `loadStoredFindings` scored highest, and those differed for
   35 of 69 prospects holding follow-up copy, always an OLDER row, median 76 hours behind. Fixed by
   the `pinnedResultId` parameter. Any new caller that writes follow-ups must pass the pin.
4. **THE FACT-CHECK CAN DECOMPOSE A SENTENCE AND CHECK ONLY PART OF IT.** One verifier rejected a
   trailing clause while asserting a premise that no finding contained. The sentence-coverage rule
   exists for that. `covers()` cannot detect it — a claim that is a FRAGMENT of the sentence reads as
   covering the whole of it — which is why `coversOpening` asks whether the SUBJECT and VERB were
   checked.
5. **A CHECK CAN BE THE THING THAT IS WRONG.** In this session four checkers were broken and each was
   caught by something other than reading: an audit judged copy against the wrong research row; a
   coverage rule flagged the offer line the writer is REQUIRED to produce; a `FACT_MARKER` matching
   `\w+ed` treated "focus·ed" as a past-tense fact; and a symbol strip did nothing at all. Verify
   every instrument with a positive control before trusting a negative result, and when a mutation
   survives, suspect the test before the code.
6. **AN AUDIT CATEGORY IS NOT A GATE.** Copy is cleared only when a real gate fails it. The one
   exception the operator granted was invented facts, which were cleared whether or not a gate
   caught them.
7. **`git stash -u` / `pop` IS SHARED ACROSS WORKTREES.** It pulled another session's stash into this
   tree. Two untracked files, `architecture.md` and `docs/Archive.zip`, belong to that session and
   must be LEFT ALONE. Commit by explicit path, never `git add -A`.

---

## 6. Where the files are

`.writer-export/` is gitignored, so none of this is in the repository and it holds real names.
Never copy its contents into a tracked file.

**Reading files** (`.writer-export/sel-20260925/`)

| file | what it is |
| --- | --- |
| `READING-FINAL-20260928.md` | the 105 after the clear-and-rewrite; the 15-prospect sample the reviewer calibrates against is at the top |
| `READING-EMAIL1-REST-20260928.md` | Email 1 only, the 42 personalised prospects outside that sample |
| `QC-AUDIT-104.md` | the audit that started this work. **Its invented-fact evidence was computed against the wrong research row** — see trap 3 — so re-derive before citing it |
| `READING-104-final.md`, `READING-104-afterfix.md` | earlier states, kept for the before/after counts |

**Verdict files** (same directory): `recheck-v3.json` is the verdict the 2026-09-28 clearing acted
on; `final-scan.json` is the state after the rewrite. `recheck-full.json` and `recheck-v2.json` are
superseded and were produced with the broken coverage rule.

**Cohort id lists**: `cohort104.json` (the original batch) and `cohort105.json` (plus one prospect
added later). Use 105.

**Snapshots, OUTSIDE the repository**, in `~/margenticos-copy-snapshots/`:

- `copy-before-clear-20260928.json` — every copy field for all 104 before a single position was
  cleared. This is the recovery point for the whole clear-and-rewrite.
- `copy-before-cleanup-six-20260928.json` — six prospects before their positions were templated by
  hand.

**Tools built for this work** (also under `.writer-export/sel-20260925/`, untracked):
`recheck-gates.ts` re-runs every current gate over stored copy, free gates first and paid ones only
where the free ones pass; `clear-from-verdict.ts` clears exactly what a saved verdict names;
`reading-file-final.ts` and `reading-email1-only.ts` build the reading files; `lost-numbers.ts` and
`scan-followup-names.ts` are measurement scripts. All are read-only unless given `--commit`.
