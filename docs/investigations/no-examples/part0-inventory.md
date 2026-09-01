# PART 0 — Inventory of worked examples in `buildWriterPrompt`

Branch `no-examples`, worktree `/Users/douglaspettit/Projects/margenticos/no-examples`,
cut from `origin/main` at `c5ab836`. Nothing removed yet; this is the pre-state.

`buildWriterPrompt` spans `src/lib/agents/research/write-opening.ts:189-1002`.
Measured before any change: 45,355 chars, 823 lines, 7,951 words, **11,054 tokens**
(live `messages.countTokens`, sonnet-4-6, system + a one-character user turn).

---

## (a) My count, and the rule that produced it

**A worked example is one quoted specimen of prospect-facing copy** — a sentence or a
sentence pair, shown under a verdict label (`FAILING`, `WORKING`, `WORKS`, `FAILS`,
`CRAMPED`, `CLEAN`, `ABSTRACT`, `CONCRETE`, `HARD`, `EASY`, `PLAIN`, `VERDICT`, `PATTERN`,
`CORRECTED`, `AIMED WRONG/RIGHT`, `Generic`, `This shipped`) or as an endorsed anchor.
One quoted slot counts as one, so a block quoting both an observation and a bridge counts
as **two**, because the recorded harm is a whole sentence being lifted.

**Count: 77 quoted specimens, 68 of them distinct.** Nine are restatements of a specimen
already given earlier in the prompt.

**Deliberately NOT counted, and left in place by Part 1:**

- **Sub-sentence fragments naming a banned shape.** `"when X, that tends to be Y"`,
  `"because"`, `"there is no"`, `"nothing about"`, `"with no case studies"`,
  `"Firms that X often find Y"`, `"until it does not"`, `"around their dates"`,
  `"your posts"` / `"your diary"` / `"you took"`, `"every LinkedIn post"` /
  `"board dates"` / `"exhibitions"` / `"outreach"`, `"The next conversation"`,
  `"New work"`, `"a real operational load"`, `"goes to whoever was in the room last"` /
  `"rather than from anything systematic"`, the `PLAIN VERBS` use/do-not lists, and the
  banned-noun list. These are the extension of a rule, not a sendable sentence. Removing
  them would remove the rules themselves, which this experiment is not testing.
- **`FIRMOGRAPHIC_RULE_TEXT`** (interpolated at L931). It is an imported constant from
  `src/lib/style/firmographic.ts` with its own test file. Editing it would change a shared
  module and confound the experiment.
- **Structural placeholders**: `[YOUR OBSERVATION GOES HERE]`, `[YOUR BRIDGE GOES HERE]`,
  `[YOUR CLOSING QUESTION GOES HERE]`, and the four output labels.

**Why this differs from the prior count of 58.** The gap is 10, and it is accounted for by
choices of rule rather than by disagreement about the text: the 4 approved-CTA register
anchors (specimens 1-4), the 2 observation specimens given as prose rather than in quotes
(18, 26), the 2 quoted peer-group offenders (31, 32 below), `"Hours shrink before they
grow"` and `"that output shows where your thinking is"`. A count that treats those as rule
vocabulary rather than as examples lands on 58 exactly.

---

## (b) Every example, and what it teaches

Line numbers are absolute in `write-opening.ts`. `=n` marks a restatement of an earlier
specimen.

### Register anchors — the four approved closing questions
| # | Line | Teaches |
|---|------|---------|
| 1 | 254 | Closing-question register and length. |
| 2 | 255 | Same. |
| 3 | 256 | Same. |
| 4 | 257 | Same. |

### THE QUESTION MUST ASK ABOUT THE PROBLEM YOU JUST NAMED
| # | Line | Teaches |
|---|------|---------|
| 5 | 277 | The bridge that diagnosed "wrong audience", so the mismatch has a subject. |
| 6 | 279 | The question it ran into, showing the mismatch. (=2) |
| 7 | 286 | A question rewritten to ask about the problem actually named. |

### THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT
| # | Line | Teaches |
|---|------|---------|
| 8 | 304 | An observation that is fine, so the fault is isolated to the bridge. |
| 9 | 306 | A verdict telling the reader the thing that works does not work. |
| 10 | 312 | A print-shop observation, chosen so its words cannot travel to a real prospect. |
| 11 | 313 | The corrected bridge: states a fact and stops. |
| 12 | 324 | A verdict invented outright, with no finding under it. |

### THE BRIDGE STATES ONE TRUE THING. IT NEVER EXPLAINS WHY
| # | Line | Teaches |
|---|------|---------|
| 13 | 334 | A bridge that says one true thing and stops. |
| 14 | 335 | Same, second instance. |
| 15 | 339 | A causal `when X, that tends to be Y` construction. |
| 16 | 340 | A held-clause construction the reader must assemble. |
| 17 | 342 | A trailing hedged consequence. |

### Contradiction check
| # | Line | Teaches |
|---|------|---------|
| 18 | 381 | The observation half of a self-contradicting pair (given as prose). |
| 19 | 382 | The bridge half that contradicts it. (=15) |

### DO NOT ASSUME THEY HAVE NOBODY
| # | Line | Teaches |
|---|------|---------|
| 20 | 387 | Inferring from a role count that nobody is doing the follow-up. |

### THE BAN COVERS IMPLIED CHOICE
| # | Line | Teaches |
|---|------|---------|
| 21 | 417 | An absence recast as a decision the reader made. |

### THE CONSEQUENCE MUST NOT TURN THE OFFER LINE INTO A DIFFERENT JOB
| # | Line | Teaches |
|---|------|---------|
| 22 | 437 | A gap aimed at a room that already met him. |
| 23 | 441 | A gap aimed at an audience she already built, and a verdict on it. |
| 24 | 447 | A sentence with no gap in it at all. |
| 25 | 450 | A gap aimed at strangers, which the offer line can answer. |

### THE BRIDGE MUST FOLLOW FROM ITS OWN OBSERVATION
| # | Line | Teaches |
|---|------|---------|
| 26 | 499 | The observation half of a subject-change (given as prose). |
| 27 | 500 | A bridge on a different subject from its observation. |

### Two smaller bridge faults
| # | Line | Teaches |
|---|------|---------|
| 28 | 511 | A change-of-state gesture standing where a fact belongs. |
| 29 | 517 | The longest bridge in the batch, still explaining, over budget. |

### YOU MAY ATTRIBUTE THE PATTERN, BUT ONLY TO YOURSELF
| # | Line | Teaches |
|---|------|---------|
| 30 | 525 | A pattern delivered as flat fact about the reader's category. |

### NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME — the four constructions
| # | Line | Teaches |
|---|------|---------|
| 33 | 609 | A conditional, put on a dentist so the words cannot travel. |
| 34 | 613 | Plain sequence, on a commercial builder. |
| 35 | 617 | A contrast, on a freight broker. |
| 36 | 621 | A consequence, on a wedding photographer. |

### PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC
| # | Line | Teaches |
|---|------|---------|
| 37 | 639 | A bridge that obeys every rule and says nothing. |

### ONE FACT PER SENTENCE
| # | Line | Teaches |
|---|------|---------|
| 38 | 658 | Eight easy words that describe nothing, so reading age is the wrong test. |
| 39 | 662 | Fragment, then list, then a verb three clauses from its subject. |
| 40 | 668 | The same facts with the joins fixed. |
| 41 | 674 | An appositive list swallowing the subject. |
| 42 | 680 | The same facts with a clean subject and verb. |

### EVERY SENTENCE MUST BE CLEAR ON ONE READING
| # | Line | Teaches |
|---|------|---------|
| 43 | 694 | Correctly pattern-framed and still a riddle: stance alone is not enough. |
| 44 | 697 | The same idea said plainly. |

### DIGESTIBILITY / LOAD BEFORE RESOLUTION
| # | Line | Teaches |
|---|------|---------|
| 45 | 715 | Ten words before the verb, three relative clauses, one nested. |
| 46 | 722 | Barely shorter and effortless, so the fix is not "make it shorter". |
| 47 | 727 | The hard one rewritten, nothing dropped. |

### CONCRETE NOUNS ONLY / NO METAPHORS
| # | Line | Teaches |
|---|------|---------|
| 48 | 743 | A bare abstract subject, versus the same noun attached to something concrete. |
| 49 | 750 | "Remainder" as a subject nobody can picture. |
| 50 | 755 | The same idea in hours. |
| 51 | 760 | A metaphor ("engine") doing a plain sentence's work. |
| 52 | 764 | The same claim naming the country, the people and what is missing. |
| 53 | 769 | The endorsed standard bridge. |

### THE CAMERA TEST
| # | Line | Teaches |
|---|------|---------|
| 54 | 776 | The unfilmable sentence. (=38) |
| 55 | 777 | The filmable one, with what the camera would see. (=53) |
| 56 | 797 | Concrete nouns throughout and still unfilmable. |
| 57 | 800 | The plain rewrite you can point a camera at. |
| 58 | 804 | "Become a conversation": a verb nobody performs. |
| 59 | 807 | The plain rewrite: an inbox with nothing in it. |

### POINT EVERY SENTENCE AT THE PERSON
| # | Line | Teaches |
|---|------|---------|
| 60 | 816 | Subject is a category, verb is "is". |
| 61 | 818 | A subject that cannot perform its verb. |
| 62 | 819 | An unowned noun: whose diary. |
| 63 | 820 | A compressed phrase doing a clause's work. |
| 64 | 831 | The same fault, restated for SAY YOUR. (=62) |
| 65 | 832 | The fix: possessive, owned, filmable. |

### THE THREE WORKED PAIRS
| # | Line | Teaches |
|---|------|---------|
| 66 | 856 | (=60) |
| 67 | 858 | Subject becomes hers, verb becomes what her posts did. |
| 68 | 863 | (=61) |
| 69 | 864 | Subject becomes him, verb becomes something watchable. |
| 70 | 869 | (=63) |
| 71 | 870 | Three fixes at once, including qualifying "conversation". |

### THE AIM TEST
| # | Line | Teaches |
|---|------|---------|
| 72 | 890 | The observation the failure was built on. |
| 73 | 892 | A bridge diagnosing "wrong conversations". |
| 74 | 894 | The question asking for "more". (=2) |
| 75 | 900 | The bridge re-aimed at what that question answers. |

### TWO MORE FAILURES WORTH KNOWING
| # | Line | Teaches |
|---|------|---------|
| 76 | 936 | Third-person dossier entry. |
| 77 | 941 | Second person and still a CV recital. |

### Counted, then reclassified as fragments and KEPT
| # | Line | Why kept |
|---|------|----------|
| 31 | 533 | `"Here's the assumption most founders make"` — a quoted offender that IS the ban. |
| 32 | 534 | `"Most firms at this stage find"` — same. |

---

## (c) Examples whose surrounding RULE TEXT does not stand without them

Twenty-three places. Each is prose that names, glosses or counts an example, so deleting
the example leaves a dangling reference. Every one is repaired in Part 1(b) and the
before/after is reported there.

| Line | The dependent rule text | Kind of dependency |
|------|------------------------|--------------------|
| 275 | "This is where a fixed question used to go wrong, and the failure is worth reading:" | colon with nothing after it |
| 281-283 | "The bridge diagnoses her correctly... asks about somebody else's problem." | gloss on 5-6 |
| 285 | "CORRECTED, same bridge, asking about what was actually named" | "same bridge" points at 5 |
| 308-309 | "A chamber event and a strong network is exactly how a great many consultancies fill capacity. We told him the thing that works does not work." | gloss on 9 |
| 316-321 | "Nothing here claims anyone's network has failed... Take the move." | gloss on 10-11, plus the copy-incident note |
| 326-327 | "We have no idea how Taffet fills its diary. We made it up and then built on it." | gloss on 12 |
| 333 | "WORKS, and both of these say one true thing and then stop:" | "both of these" |
| 337-338 | "FAILS, and all three are causal constructions..." | "all three" |
| 380, 383-384 | "This shipped:" / "The observation says his feed is regulatory news... Both cannot be true" | gloss on 18-19 |
| 387-390 | "This shipped: ... It assumes that because he holds three roles..." | gloss on 20 |
| 417-421 | "This shipped: ... That is not 'you have no posts'. It is..." | gloss on 21 |
| 439-440, 443-446, 448, 452-453 | "The gap is the room that already saw him speak." etc., four glosses | one per 22-25 |
| 498, 501-504 | "FAILING, and both halves are fine on their own:" / "Board seats and LinkedIn posts are two different subjects." | gloss on 26-27 |
| 512-513 | "'Until it does not' is a shape where a fact should be." | gloss on 28 |
| 515-516, 519-520 | "The longest bridge in the last batch was 32 words and it was also the one still explaining:" / "One sentence carrying a clause..." | gloss on 29 |
| 523-527 | "A bridge stated flatly as how the world works is the bluntness that reads presumptuous. '...' is delivered as fact" | the example IS the sentence's subject |
| 404-406 | "it used to be the shape of nearly every worked example on this page" | meta-reference to the examples |
| 605-608 | "EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY..." whole paragraph | exists only to introduce 33-36 |
| 624-627 | "There are more shapes than these four:" | "these four" |
| 639-643 | "Generic, and therefore useless: '...'" / "It is safe, it obeys every rule above, and it says nothing." | gloss on 37 |
| 656-659 | "'Hours shrink before they grow' is eight easy words and it describes nothing." | the example IS the sentence's subject |
| 663-666, 671, 675-678, 682-684, 686-688 | the CRAMPED/CLEAN glosses, and "Note what did NOT change in either rewrite... Only the joins moved." | gloss on 39-42 |
| 691-693, 695-698 | "FAILING on clarity, and note this one is correctly pattern-framed" / "Who is uncontested, what contest" | gloss on 43-44 |
| 714, 717-720, 723-726, 728-731 | "HARD, and this shipped:" / "Ten words before the verb" / "Barely shorter" / "Nothing was dropped and nothing was softened." | gloss on 45-47 |
| 741-744 | "Attached to something concrete they are fine: '...'. As a bare subject they are not: '...'" | the examples ARE the rule |
| 748-767 | the ABSTRACT/CONCRETE glosses: "Nobody can picture a remainder." / "Which regions, and what engine." / "Same claim, and now it names the country" | gloss on 49-52 |
| 768, 770 | "CONCRETE, already working, and this is the standard:" / "Deadline. Waits." | gloss on 53 |
| 775-779 | the camera-test worked pair and its "a calendar with a date on it" gloss | gloss on 54-55 |
| 793 | the FINISH ON A CONCRETE THING contrast line | illustration only |
| 795-808 | "Two of these shipped last week. Both have concrete nouns throughout and both fail:" plus four glosses | "Two of these" |
| 812-815 | "Four from the last batch, all of which shipped:" | "Four from the last batch" |
| 635-637 | "The stand they took at a show, with the show named from the findings rather than left as 'the stand'." | points at the CAVE example (63/71) |
| 646-648 | "Delivery cannot answer. Exhibitions cannot fill a diary." | points at 61 and 63 |
| 650-651 | "'around their dates' is a sentence folded into four words" | points at 63 |
| 654 | "THE THREE WORKED PAIRS. Read these for the MOVE, not for the words." | heading names them |
| 686-693 | "THESE THREE ARE ABOUT STANFORD GSB, TWO CEO ROLES AND THE CAVE STAND... Take the move." | names 66-71 |
| 887-888, 896-903 | "Here is that failure, from real output:" / "The bridge says she already has plenty..." | gloss on 72-75 |
| 933-943 | "TWO MORE FAILURES WORTH KNOWING, both about who you are writing to:" plus two glosses | "TWO MORE FAILURES" |

**Two places already say a rule stands with NO example, and they are the model for the
repairs.** L182-184 (`NO EXAMPLE IS GIVEN, AND THE ABSENCE IS DELIBERATE`) and L364-368
(`NO EXAMPLE OF A PERMITTED ATTRIBUTION IS GIVEN`). Both are prior instances of this same
removal, made one rule at a time.

---

## (d) Tests that pin the examples

Every one asserts the prompt **contains** an example verbatim, so every one goes red on
removal. Grouped by file. "Purpose" is the test's own stated reason where it gives one.

### `src/lib/agents/research/__tests__/write-opening.test.ts` — 24 tests

| Line | Test | Purpose as stated | Examples pinned |
|------|------|-------------------|-----------------|
| 213 | bans verdicts and carries both real failures verbatim | keep the two real verdict failures in the prompt | 9, 11, 12 |
| 239 | blocks generic patterns with the standalone test | keep the generic specimen beside the standalone test | 37 |
| 247 | requires clarity on one reading, with the Stephen riddle | the correctly-framed riddle | 43 |
| 255 | aims the bridge at the offer, with the Shevonne failure verbatim | the real aim failure | 73, 74 |
| 306 | both FAILING examples are retained | the two dossier failures | 76, 77 |
| 381 | passes the four approved CTAs as register anchors | register anchoring | 1-4 |
| 389 | carries the Shevonne browsers-versus-buyers failure verbatim, with a correction | the question-aim failure | 5, 7 |
| 420 | carries both real cramped examples verbatim | one-fact-per-sentence | 39, 41 |
| 430 | pairs each cramped example with a clean rewrite of the same facts | shows only the joins moved | 40, 42 |
| 487 | carries the hard and easy pair verbatim, plus a rewrite of the hard one | shows the fix is not "make it shorter" | 45, 46, 47 |
| 507 | names the frame that collapsed and says why it matters | the collapsed frame | (fragment only) |
| 514 | offers four genuinely different shapes, each labelled | the four constructions | 33-36 |
| 594 | offers no worked example of a permitted attribution, and says so | ABSENCE assertion — survives | none |
| 899 | uses four industries deliberately foreign to the prospect | cross-industry labels | 33-36 |
| 906 | keeps the four constructions and labels none as preferred | four labels | 33-36 |
| 917 | no longer carries the two phrases that were lifted and then rejected | ABSENCE, but slices between two example anchors | 33-36 boundaries |
| 934 | the four examples do not collide with each other under the batch gate | the examples are themselves unique | 33-36 (inlined copies) |
| 953 | the examples themselves are concrete | an example must obey the rule below it | 33-36 boundaries |
| 977 | keeps load and output as judgement calls with both readings shown | judgement-call readings | 48 |
| 987 | carries both real abstract failures verbatim, each with a concrete rewrite | abstract → concrete | 49, 50, 51, 52 |
| 995 | keeps the working bridge as the standard to aim at | the endorsed standard | 53 |
| 1216 | carries the filmable and unfilmable pair | camera test | 54, 55 |
| 1234 | requires a concrete ending, with the contrast the brief gave | ending shape | (fragment only) |
| 1240 | carries two real failures verbatim, each with a plain rewrite | camera failures | 56, 57, 58, 59 |
| 1284 | carries both working bridges verbatim as the standard | state-not-explain | 13, 14 |
| 1290 | carries all three causal failures verbatim | causal constructions | 15, 16, 17 |
| 1318 | requires the observation and bridge to be read together, with the real contradiction | contradiction | 18, 19 |
| 1330 | bans assuming they have nobody, and ties it to the pipeline ban | | 20 |
| 1338 | extends the absence ban to implied choice, with Jason verbatim | | 21 |
| 1352 | is about a print shop, not a hire and a network | the re-welded corrected example | 10, 11 |
| 1358 | no longer carries the phrasing that was reproduced almost verbatim | ABSENCE — survives | none |
| 1365 | records why it was re-welded, so it is not quietly reverted | the copy-incident note | gloss on 10-11 |
| 1371 | the corrected bridge obeys every rule it now sits under | inlined copy, not a prompt read | none |
| 1381 | does not collide with the other worked examples under the batch gate | inlined copies | none |
| 1443 | carries all three failing bridges verbatim, each with what is wrong | offer-line destination | 22, 23, 24 |
| 1457 | carries the working example and says why it works | | 25 |
| 1499 | states the rule and carries the Daedra mismatch | bridge-follows-observation | 27 gloss |
| 1512 | carries the empty change-of-state construction verbatim | | 28 |
| 1518 | carries the longest and still-explaining bridge, with the fix | | 29 |
| 1526 | every quoted FAILING bridge is labelled as failing, not as a model | the anti-copy guard: a quoted bridge must sit under FAILING | 22, 23, 24, 28 |
| 1541 | the one WORKING bridge quoted here is Makesha's own | same guard, other direction | 25 |
| 1189 | drops the reading-age line and says why it failed | | 38 |
| 1256 | the plain rewrites obey every rule they sit under | inlined copies | none |
| 1004 | the concrete rewrites in the prompt score zero | inlined copies | none |

Also in this file, asserting on the **peer-group offenders** (31, 32), which Part 1 keeps:
line 1150, "rules out the peer group as fact".

### `src/lib/agents/research/__tests__/writer-four-rules.test.ts` — 2 tests, both ABSENCE

`RULE ZERO: the four rules illustrate nothing` (line 120) asserts the four newest rule
blocks carry **no** quoted span of 25+ chars and name no industry, buyer title, revenue band
or currency. Its header states the reason: "write-opening.ts has eight recorded instances of
a worked example being copied verbatim into a prospect's email."

**This is the test the whole experiment generalises.** It survives removal and gets
stronger, and it is the only test in the suite that already encodes the hypothesis.

### `src/lib/agents/research/__tests__/write-opening-subject.test.ts` — 1 test, ABSENCE

`carries no example subject line` (line 238). Asserts the only text after a `SUBJECT:` label
anywhere in the prompt is the placeholder, and that the subject rules block contains no
quotation marks at all. Survives; unaffected.

### `src/agents/__tests__/prompt-names.test.ts` — ratchet

`src/lib/agents/research/write-opening.ts:buildWriterPrompt: 33`, asserted with
`toBeLessThanOrEqual`. **All 33 unvouched names sit inside worked examples** — measured, not
assumed: Chamber, Sky, HydrospherIQ, London, Peak, DTCC×2, Treasury×2, SEC, SEC's, Taffet,
Hollywood×2, Coalition×2, Sovern×2, LA×2, SCG×2, Stanford×3, GSB×3, CAVE, Jason, Pani,
Visteon. The ratchet permits a drop, so this passes after removal.

### `src/agents/__tests__/prompt-forbidden-content.test.ts` — ratchet

`buildWriterPrompt: 1`, also `toBeLessThanOrEqual`. The single hit is L308, `"consultancies"`
— the gloss under example 9. It goes with the example, taking this source to 0.

### `src/lib/agents/research/__tests__/resolve-buyer.test.ts` and `cache-receipt.test.ts`

Neither pins an example. They assert the prompt is a zero-argument constant and byte-identical
across prospects, which Part 2 re-proves.

---

## Summary of what Part 1 has to do

- Remove 77 quoted specimens (68 distinct).
- Repair ~23 passages of dependent rule text.
- Update 24 tests in `write-opening.test.ts` plus the two ratchets.
- The three ABSENCE tests and `RULE ZERO` survive untouched.
