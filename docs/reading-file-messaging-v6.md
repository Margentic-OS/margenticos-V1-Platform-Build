# Reading file — MargenticOS messaging v6

Document `a86bc945-e19c-4d74-a0df-1c9dba97cf9b`, status **active**, created 2026-09-21.
Measured 2026-09-23 with `src/lib/style/reading-grade.ts`.

Flesch-Kincaid grade. **Target: grade 5 or under per email.**

Two surfaces are reported per email and they differ:

- **prose** — greeting and both sign-off lines removed, by the agent's `emailProse()`.
- **authored** — the above, minus the held Email 2 and Email 3 CTAs. This is what the
  gate scores. It is the STRICTER number: the held CTAs grade near zero, so counting
  them lends an email credit for prose the agent was not asked to write.

Paragraph rows exclude the sign-off. A held CTA is marked `held`.

## Variant A

| email | prose | authored | words | sentences | syll/word |
|---|---|---|---|---|---|
| 1 | 9.43 | **9.43** **OVER** | 57 | 4 | 1.65 |
| 2 | 4.63 | **5.42** **OVER** | 62 | 5 | 1.37 |
| 3 | 4.36 | **5.54** **OVER** | 40 | 3 | 1.35 |
| 4 | 4.81 | **4.81** | 35 | 3 | 1.34 |

**Email 1** — subject: "pipeline after referrals"

| grade | paragraph | text |
|---|---|---|
| 11.07 **OVER** | observation (slot) | For most founders running consulting firms, new work still arrives almost entirely through referrals they can't predict or replace. |
| 8.41 **OVER** | consequence (slot) | When a referral source goes quiet, there's usually nothing else running to catch it. |
| 9.93 **OVER** | offer line | We run outbound so qualified meetings land in the diary without you touching the prospecting. |
| 8.90 **OVER** | CTA | Is pipeline consistency something you're actively trying to fix? |

**Email 2** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 10.49 **OVER** | body 1 | The cost that doesn't show up anywhere obvious: every month pipeline runs dry, the next few weeks go to catching up rather than delivering. |
| 5.50 **OVER** | body 2 | The swing isn't just uncomfortable. It makes it hard to hire, invest, or plan anything past the current project. |
| 2.40 | body 3 | Most founders I speak to have been living with that swing long enough that it feels normal. It isn't. |
| -1.06 | CTA `held` | Does that sound like where you are? |

**Email 3** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 3.92 | body 1 | Most founders who fix pipeline don't do it by carving out more hours for outreach. That lasts two weeks before a deadline pulls them back. |
| 8.35 **OVER** | body 2 | Consistency comes from removing yourself from the process, not from finding more time for it. |
| -0.28 | CTA `held` | Worth a quick call to see if it fits? |

**Email 4** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 4.81 | body 1 | Last one from me. If the pipeline swings aren't a live problem right now, no action needed. If a referral source goes quiet and there's nothing running behind it, happy to pick this up then. |

## Variant B

| email | prose | authored | words | sentences | syll/word |
|---|---|---|---|---|---|
| 1 | 10.44 | **10.44** **OVER** | 72 | 4 | 1.61 |
| 2 | 7.01 | **7.83** **OVER** | 53 | 4 | 1.55 |
| 3 | 7.84 | **9.87** **OVER** | 39 | 2 | 1.51 |
| 4 | 6.49 | **6.49** **OVER** | 29 | 3 | 1.55 |

**Email 1** — subject: "the referral ceiling"

| grade | paragraph | text |
|---|---|---|
| 13.98 **OVER** | observation (slot) | For most consulting founders at this stage, close rate is solid and delivery is strong, but conversations arrive almost entirely through one or two relationships. |
| 12.41 **OVER** | consequence (slot) | When those relationships are active the diary fills, and when they go quiet there's nothing else generating conversations. |
| 7.70 **OVER** | offer line | We fill the diary through outbound so the pipeline keeps moving regardless of which week you're in. |
| 6.79 **OVER** | CTA | Is getting more conversations in front of you something you're working on? |

**Email 2** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 7.96 **OVER** | body 1 | Talking to a lot of consulting founders at the moment. The ones stuck at the same revenue level for twelve months or more aren't lacking close skill or delivery quality. |
| 7.88 **OVER** | body 2 | They're just not in enough conversations. And because a referral lands every few weeks, the urgency to build anything else never quite arrives. |
| 2.48 | CTA `held` | Is that the pattern you're seeing? |

**Email 3** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 9.13 **OVER** | body 1 | Most founders who get past the referral ceiling don't do it by networking harder or staying more visible. |
| 10.58 **OVER** | body 2 | They add a channel that runs without them so conversations keep coming in regardless of what the delivery week looks like. |
| 2.28 | CTA `held` | Worth a call to see if that's relevant? |

**Email 4** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 6.49 **OVER** | body 1 | Last email. If the timing's off right now, that's completely fine. If conversations start feeling thin and you want another channel running, this is here whenever that moment arrives. |

## Variant C

| email | prose | authored | words | sentences | syll/word |
|---|---|---|---|---|---|
| 1 | 8.80 | **8.80** **OVER** | 72 | 4 | 1.47 |
| 2 | 5.53 | **6.63** **OVER** | 62 | 4 | 1.37 |
| 3 | 4.94 | **6.22** **OVER** | 44 | 3 | 1.36 |
| 4 | 5.14 | **5.14** **OVER** | 34 | 3 | 1.38 |

**Email 1** — subject: "when delivery takes over"

| grade | paragraph | text |
|---|---|---|
| 10.82 **OVER** | observation (slot) | The pattern with most consulting firms at this stage is that delivery takes the whole week and outreach sits on the list indefinitely. |
| 7.70 **OVER** | consequence (slot) | Referrals carry the pipeline when they land, and when they don't, there's nothing else running behind them. |
| 9.91 **OVER** | offer line | We handle outbound so qualified meetings keep showing up in the diary whether you're deep in a project or not. |
| 6.79 **OVER** | CTA | Is keeping pipeline moving through busy stretches something you're trying to solve? |

**Email 2** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 9.18 **OVER** | body 1 | The pattern I see most often with consulting founders right now: they've had a go at outreach before, usually through an agency. A few meetings came through, but the targeting was off and the people on the calls weren't the right fit. |
| 3.65 | body 2 | So the whole thing got shelved and referrals went back to carrying the weight. The issue was rarely the channel. |
| -1.06 | CTA `held` | Does that sound like where you are? |

**Email 3** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 11.47 **OVER** | body 1 | When outbound has failed before, it's almost always the same reason: the targeting and the messaging weren't pinned down before the emails went out. |
| 2.47 | body 2 | Get those right first and cold email works well for consulting firms. Shortcuts at that stage are what kill it. |
| -0.28 | CTA `held` | Worth a quick call to see if it fits? |

**Email 4** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 5.14 **OVER** | body 1 | Last one from me. Others in the same spot have found it worth a conversation once the delivery calendar cleared. If that's where you land, happy to pick this up whenever the timing works. |

## Variant D

| email | prose | authored | words | sentences | syll/word |
|---|---|---|---|---|---|
| 1 | 8.72 | **8.72** **OVER** | 65 | 4 | 1.52 |
| 2 | 5.32 | **6.18** **OVER** | 65 | 5 | 1.42 |
| 3 | 3.95 | **5.19** **OVER** | 31 | 3 | 1.42 |
| 4 | 4.53 | **4.53** | 37 | 3 | 1.30 |

**Email 1** — subject: "the outreach assumption"

| grade | paragraph | text |
|---|---|---|
| 10.44 **OVER** | observation (slot) | Most consulting founders run outreach only when the diary empties and a project ends with nothing behind it. |
| 10.58 **OVER** | consequence (slot) | That timing means outbound starts in panic mode, so it never builds real momentum before delivery pulls the founder back in. |
| 9.82 **OVER** | offer line | We run outbound continuously so meetings land in the diary before the gap arrives, not after. |
| 2.47 | CTA | Is that the cycle you're trying to get ahead of? |

**Email 2** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 7.03 **OVER** | body 1 | Talking to a lot of consulting founders right now who know the pipeline problem is real but haven't treated it as urgent. A referral lands, the diary fills, and the moment passes. Then a quiet month arrives and the scramble starts again from scratch. |
| 4.80 | body 2 | But the scramble is the symptom. The actual issue is that nothing was running in the background while things were good. |
| -1.06 | CTA `held` | Does that sound like where you are? |

**Email 3** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 5.19 **OVER** | body 1 | The counterintuitive part about fixing pipeline: the founders who solve it don't find more hours for outreach. They stop being the one who runs it. Ownership is the shift, not effort. |
| -0.28 | CTA `held` | Worth a quick call to see if it fits? |

**Email 4** — no subject, threads under Email 1

| grade | paragraph | text |
|---|---|---|
| 4.53 | body 1 | Last one from me. If the timing isn't right and outreach isn't the priority, that's completely fine. If a quiet patch shows up and you want pipeline running before it bites, happy to pick this up then. |

## Summary

| surface | mean | min | median | max | over grade 5 |
|---|---|---|---|---|---|
| prose | 6.37 | 3.95 | 5.53 | 10.44 | 10 of 16 |
| authored (what the gate scores) | 6.95 | 4.53 | 6.49 | 10.44 | **14 of 16** |


---

## The regeneration attempt of 2026-09-22, which did not produce a document

Run with the gate live and the Email 2 and Email 3 CTAs held. **The budget was spent
without a single variant passing, so nothing was written.** v6 above is still the active
document and was never touched. Recorded here rather than discarded, because what the
attempts reached is the useful part.

Budget: `MAX_API_CALLS_PER_RUN = 6`, unchanged. Spent as one four-variant call plus five
breadth-first repairs, 208s against the 240s guard. Nine variant-attempts were scored.

| attempt | Email 1 | Email 2 | Email 3 | Email 4 | other gates |
|---|---|---|---|---|---|
| A first pass | 8.0 | | | | |
| B first pass | 10.1 | 6.6 | 7.8 | 6.5 | 27-word sentence |
| C first pass | 7.7 | 5.2 | | 5.1 | |
| D first pass | 8.9 | | | | back-reference "that cycle" |
| A retry 1 | **6.1** | | | | |
| B retry 1 | 7.4 | 5.1 | 5.1 | | back-reference "those relationships" |
| C retry 1 | **5.6** | | 5.4 | | consequence paragraph ran to 2 sentences |
| D retry 1 | 7.0 | 6.2 | | | |
| A retry 2 | 8.1 | 5.4 | | | |

19 grade rejections in all, between **5.1 and 10.1**. The closest any Email 1 came was
**5.6**. Emails 2 and 3 got within 0.1.

The prompt moved the number: B went 10.1 to 7.4, C 7.7 to 5.6, D 8.9 to 7.0. It is not
being ignored. A regressed, 8.0 to 6.1 to 8.1, which is resampling rather than correcting.

### Why Email 1 in particular could not get there

**Every Email 1 attempt came back at exactly 4 sentences, and that is the frame, not a
choice.** Email 1 is an observation paragraph, a consequence paragraph, an offer line and
a CTA. The slot gate requires the observation and the consequence to be ONE SENTENCE EACH.
Four paragraphs, four sentences.

Flesch-Kincaid is `0.39 * words-per-sentence + 11.8 * syllables-per-word - 15.59`, so
fixing the sentence count at 4 fixes words-per-sentence at roughly 13 to 16 for an email in
the 40 to 90 word band, and the whole burden falls on syllables per word:

| sentences in Email 1 | words/sentence at 55 words | syllables/word needed for grade 5 |
|---|---|---|
| 3 | 18.3 | 1.139 |
| **4 — what the frame produces** | **13.8** | **1.290** |
| 5 | 11.0 | 1.381 |
| 6 | 9.2 | 1.442 |

The attempts reached 1.38 to 1.57 syllables per word. At 6 sentences, 1.44 would pass and
C already wrote 1.38. At the 4 sentences the frame mandates, they needed 1.29, which is
plainer than ordinary business English and plainer than the 7-percent-reply benchmark
manages over a full email.

**So the Email 1 frame and a grade-5 gate pull against each other, and the frame wins.**
The only paragraph free to become two short sentences is the offer line: the slot
paragraphs are gated to one sentence each, and the CTA is a single question by rule.

Nothing was loosened. This is recorded for the decision, not acted on.

---

## The second regeneration attempt, 2026-09-22 — blocked on billing, not on the gate

After the offer line and the CTA were allowed two sentences each, the regeneration was run
again. **It never reached the gate.** The first Anthropic call was rejected in four
seconds:

```
400 invalid_request_error — Your credit balance is too low to access the Anthropic API.
```

Retried once, same result, same class. **Zero model calls completed, so there are no grades
and no sentence counts from this run to report.** Nothing was written; v6 is still the
active document. The held CTAs were read correctly from v6 before the failure, so the
plumbing is proved up to the API boundary and no further.

### Sentence counts on the live v6, which is what there is to measure

| email | sentences | grade | Email 1 breakdown |
|---|---|---|---|
| A/E1 | 4 | 9.43 | slot 1, slot 1, offer 1, CTA 1 |
| A/E2 | 5 | 5.42 | |
| A/E3 | 3 | 5.54 | |
| A/E4 | 3 | 4.81 | |
| B/E1 | 4 | 10.44 | slot 1, slot 1, offer 1, CTA 1 |
| B/E2 | 4 | 7.83 | |
| B/E3 | 2 | 9.87 | |
| B/E4 | 3 | 6.49 | |
| C/E1 | 4 | 8.80 | slot 1, slot 1, offer 1, CTA 1 |
| C/E2 | 4 | 6.63 | |
| C/E3 | 3 | 6.22 | |
| C/E4 | 3 | 5.14 | |
| D/E1 | 4 | 8.72 | slot 1, slot 1, offer 1, CTA 1 |
| D/E2 | 5 | 6.18 | |
| D/E3 | 3 | 5.19 | |
| D/E4 | 3 | 4.53 | |

**Every live Email 1 sits at exactly four sentences**, one per paragraph, which is the
pattern the prompt change is meant to break. The new frame makes four to six legal.

### Splitting alone does NOT close the gap, and that is worth knowing before the next run

Holding each live Email 1's words and syllables constant and only re-splitting it:

| | words | syll/word | at 4 sentences | at 5 | at 6 |
|---|---|---|---|---|---|
| A/E1 | 57 | 1.65 | 9.43 | 8.32 | 7.57 |
| B/E1 | 72 | 1.61 | 10.44 | 9.04 | 8.10 |
| C/E1 | 72 | 1.47 | 8.80 | 7.40 | 6.46 |
| D/E1 | 65 | 1.52 | 8.72 | 7.45 | 6.61 |

**At six sentences they still land 6.46 to 8.10.** Splitting buys roughly 1.9 grades and
the gap is 3.7 to 5.4. So the sentence allowance is necessary and not sufficient: syllables
per word has to come down as well.

**The combination is reachable, and the model has already shown both halves separately.**
At six sentences and around 60 words, grade 5 needs about **1.41** syllables per word. On
the first run, variant C's Email 1 retry reached **1.38** — but at four sentences, where
1.29 was required. 1.38 syllables per word at six sentences scores about **4.6** and passes.

What no run has yet produced is both at once, and that is what the prompt change is asking
for. Whether the model can hold plain vocabulary and a six-sentence split in the same draft
is untested, because the run that would have tested it never made a call.

---

## The third regeneration attempt, 2026-09-22 — one variant passed, and the reuse gate never fired

Run with credits restored and the two-sentence allowance live. **1 of 4 variants passed**,
up from 0. Budget spent in 196s over 6 calls. Variant **C passed on retry 1**; A, B and D
ran out of budget before their next repair. Nothing was written, because the agent requires
all four variants. v6 is still active.

### What rejected the attempts

**Sixteen rejections: fifteen on reading grade, one on sentence length. Zero on
cross-variant sentence reuse.**

| attempt | email | grade | words | sentences | syll/word | syll/word needed |
|---|---|---|---|---|---|---|
| A first | 1 | 8.00 | 59 | 4 | 1.51 | 1.257 |
| A first | 4 | 5.80 | 38 | 3 | 1.39 | 1.326 |
| B first | 1 | 9.80 | 71 | 4 | 1.56 | 1.158 |
| B first | 2 | 6.60 | 59 | 5 | 1.49 | 1.355 |
| B first | 3 | 7.10 | 47 | 3 | 1.40 | 1.227 |
| B first | 4 | 6.50 | 29 | 3 | 1.55 | 1.425 |
| C first | 1 | 7.90 | 68 | 4 | 1.43 | 1.183 |
| C first | 2 | 5.30 | 68 | 5 | 1.32 | 1.295 |
| C first | 3 | 5.20 | 54 | 4 | 1.31 | 1.299 |
| C first | 4 | 5.10 | 34 | 3 | 1.38 | 1.370 |
| D first | 1 | 8.60 | 67 | 4 | 1.49 | 1.191 |
| A retry 1 | 2 | 5.40 | 63 | 5 | 1.37 | 1.328 |
| B retry 1 | 1 | **5.90** | 48 | **5** | 1.50 | 1.428 |
| D retry 1 | 1 | 5.80 | 48 | 4 | 1.42 | 1.348 |
| A retry 2 | 1 | 6.30 | 52 | 4 | 1.42 | 1.315 |

Best grade reached anywhere: **5.10**. Best Email 1: **5.80**.

### THE REUSE GATE DID NOT FIRE, AND THIS RUN COULD NOT HAVE SHOWN IT

Zero reuse violations and zero reuse log lines, against 19 lines mentioning a variant, so
the search is sound and the absence is real.

**But the absence is not evidence the trade is safe.** `findCrossVariantReuse` runs on
`result.passed`, that is, only on variants that have already cleared `validateEmails`, and
it compares each against the registry of variants that passed BEFORE it. **With exactly one
variant passing, there was nothing for it to collide with.** The gate was never given the
chance to fire.

The trade the two-sentence allowance introduces is real and remains unmeasured: two extra
sentences per variant are two more that must be distinct across all four. It cannot be
observed until at least two variants pass in the same run.

### The allowance is permitted but barely used

**Six of the seven Email 1 attempts still came back at FOUR sentences.** One, B's retry 1,
used five, and it is also the closest any Email 1 has come at 5.90. The prompt now permits
four to six and says six is easier; the model is mostly still writing four.

Where the sentence count did rise, the arithmetic moved as predicted: B's Email 1 at five
sentences needed 1.428 syllables per word rather than the ~1.16 its four-sentence first
pass needed. It reached 1.50 and missed by 0.07.

### Against the previous run

| | run 1 (four-sentence frame) | run 3 (four to six) |
|---|---|---|
| variants passed | 0 of 4 | **1 of 4** |
| grade rejections | 19 | 15 |
| best Email 1 | 5.6 | 5.8 |
| Email 1s at 5+ sentences | 0 | 1 of 7 |

Moving in the right direction, and not yet enough. Nothing loosened.

---

## The fourth regeneration attempt, 2026-09-23 — the 12-word cap worked, and exposed the next conflict

Run with Email 1's sentence cap at 12 words and the retry feedback naming the lever.
**0 of 4 variants passed inside the run**, 221s over 6 calls. All nine attempts were
captured to disk, so everything below cost no further model calls. Nothing was written and
v6 is still active.

### The cap did what it was built to do

| | run 3 (four to six permitted) | run 4 (12-word cap) |
|---|---|---|
| Email 1 retries at 5+ sentences | 1 of 7 | **5 of 5** |
| best Email 1 grade, any attempt | 5.80 | **3.60** |
| Email 1s passing grade 5 outright | 0 | **2** (B 3.92, C 3.60) |

Every first pass still arrives at four long sentences and is rejected on sentence length.
**Every retry, once told the cap, came back at five to seven sentences.** A cap moved what
permission did not.

Best Email 1 per variant: **A 5.36, B 3.92, C 3.60, D 5.08.**

### The fallback fired, and it was not enough

Per the rule agreed before the run, Email 1's ceiling moved to 6 and every captured attempt
was re-validated through the real `validateEmails` with no new calls.

**1 of 4 variants is clean: A, via A-retry-2.** Not enough to land a document, which needs
four.

### What blocks the other three, and it is NOT the grade

| variant | best attempt | what stops it |
|---|---|---|
| B | B-retry-1 | Email 1 slot paragraph has 2 sentences; Email 2 grade 6.50 |
| C | C-retry-1 | Email 1 has a 13-word sentence; observation AND consequence each have 2 sentences |
| D | D-retry-1 | Email 1 consequence has 2 sentences; Email 2 grade 6.18; Email 3 grade 6.17 |

**Three of the four retries now fail the slot one-sentence rule, and the 12-word cap is why.**
Told to keep sentences short, the model writes short ones and puts two of them in the slot
paragraph:

```
B-retry-1 observation:  "Close rate is solid."  "The work speaks for itself."     (4 and 5 words)
C-retry-1 observation:  "Delivery fills the week."  "Outreach sits on the list."  (4 and 5 words)
C-retry-1 consequence:  "Referrals carry things when they land."
                        "When they don't, the diary thins."                       (6 and 6 words)
D-retry-1 consequence:  "Outbound that starts in panic mode never builds momentum."
                        "Delivery pulls them back in before it does."             (9 and 8 words)
```

Every one of those sentences is well inside the cap. None is too long. They are rejected for
being **two sentences in a paragraph that must hold one**, because the slot is replaced per
prospect and each paragraph carries exactly one job.

**So the 12-word cap and the one-sentence slot rule now pull against each other, the same
shape as the frame-versus-grade conflict before it.** The slot has to carry an observation
in a single sentence of 12 words or fewer. That is a very small box, and the model keeps
reaching for a second sentence to fill it.

Nothing was loosened. The slot rule was not touched.

### Cross-variant sentence reuse: still cannot fire

One variant clean, so there is nothing for a second to collide with. The gate has now been
unable to fire on four consecutive runs, for the same structural reason each time:
`findCrossVariantReuse` compares a passing variant against the ones that passed before it.

### Every attempt, grade, words and sentences per email

| attempt | email | grade | cap | words | sentences | longest sentence | verdict |
|---|---|---|---|---|---|---|---|
| A-first | 1 | 7.22 | 6 | 50 | 4 | 15 / 12 | sentence len, sentence len, grade |
| A-first | 2 | 4.07 | 5 | 75 | 6 | 23 / 25 | clean |
| A-first | 3 | 5.04 | 5 | 42 | 3 | 17 / 25 | grade |
| A-first | 4 | 5.50 | 5 | 38 | 3 | 18 / 25 | grade |
| A-retry-1 | 1 | 5.36 | 6 | 46 | 6 | 11 / 12 | slot 1-sentence |
| A-retry-1 | 2 | 5.42 | 5 | 62 | 5 | 24 / 25 | grade |
| A-retry-1 | 3 | 4.24 | 5 | 40 | 4 | 15 / 25 | clean |
| A-retry-1 | 4 | 3.27 | 5 | 30 | 5 | 12 / 25 | clean |
| A-retry-2 | 1 | 5.82 | 6 | 40 | 5 | 10 / 12 | clean |
| A-retry-2 | 2 | 3.25 | 5 | 59 | 6 | 16 / 25 | clean |
| A-retry-2 | 3 | 4.88 | 5 | 38 | 3 | 14 / 25 | clean |
| A-retry-2 | 4 | 4.81 | 5 | 35 | 3 | 18 / 25 | clean |
| B-first | 1 | 7.99 | 6 | 65 | 4 | 19 / 12 | sentence len, sentence len, sentence len, grade |
| B-first | 2 | 5.32 | 5 | 67 | 6 | 23 / 25 | grade |
| B-first | 3 | 9.96 | 5 | 41 | 2 | 21 / 25 | grade |
| B-first | 4 | 6.33 | 5 | 31 | 3 | 18 / 25 | grade |
| B-retry-1 | 1 | 3.92 | 6 | 51 | 6 | 12 / 12 | slot 1-sentence |
| B-retry-1 | 2 | 6.50 | 5 | 51 | 4 | 19 / 25 | grade |
| B-retry-1 | 3 | 2.31 | 5 | 35 | 5 | 10 / 25 | clean |
| B-retry-1 | 4 | 3.22 | 5 | 27 | 3 | 17 / 25 | clean |
| C-first | 1 | 7.18 | 6 | 68 | 4 | 23 / 12 | sentence len, sentence len, sentence len, sentence len, grade |
| C-first | 2 | 6.04 | 5 | 69 | 5 | 21 / 25 | grade |
| C-first | 3 | 5.92 | 5 | 43 | 3 | 23 / 25 | grade |
| C-first | 4 | 5.84 | 5 | 34 | 3 | 16 / 25 | grade |
| C-retry-1 | 1 | 3.60 | 6 | 47 | 7 | 13 / 12 | sentence len, slot 1-sentence, slot 1-sentence |
| C-retry-1 | 2 | 3.44 | 5 | 61 | 8 | 14 / 25 | clean |
| C-retry-1 | 3 | 4.79 | 5 | 44 | 4 | 13 / 25 | clean |
| C-retry-1 | 4 | 1.69 | 5 | 36 | 4 | 13 / 25 | clean |
| D-first | 1 | 9.12 | 6 | 61 | 4 | 20 / 12 | back-ref, sentence len, sentence len, sentence len, grade |
| D-first | 2 | 5.81 | 5 | 64 | 5 | 20 / 25 | grade |
| D-first | 3 | 3.65 | 5 | 50 | 5 | 16 / 25 | firmographic |
| D-first | 4 | 4.88 | 5 | 38 | 3 | 21 / 25 | clean |
| D-retry-1 | 1 | 5.08 | 6 | 51 | 6 | 10 / 12 | slot 1-sentence |
| D-retry-1 | 2 | 6.18 | 5 | 64 | 5 | 21 / 25 | grade |
| D-retry-1 | 3 | 6.17 | 5 | 42 | 3 | 23 / 25 | grade |
| D-retry-1 | 4 | 4.53 | 5 | 37 | 3 | 20 / 25 | clean |

---

## 2026-09-23, cap raised to 15 and only the missing variants repaired

Two steps, no full regeneration.

### Step 1: re-validating the dumped attempts at cap 15 — still 1 of 4

Raising the cap removed every sentence-length violation from the stored attempts but left
the slot ones, which is the expected result and worth stating plainly: **a raised cap cannot
retroactively merge two sentences that were already written.** A remained the only clean
variant, via A-retry-2.

### Step 2: guarded single-variant repair on B, C and D only

Six calls, 158s, through the agent's own `scheduleRepairsBreadthFirst` and
`attemptSlotRepair`, with the sentence registry pre-seeded from A so a repaired variant
could not duplicate its Email 1 copy. **A was not regenerated.**

Result: **1 of 4.** B, C and D each took two attempts and none passed. Budget exhausted.

### THE CAP RAISE WORKED, AND THE PROBLEM MOVED AGAIN

| variant | Email 1 grade | Email 1 sentences | longest / cap |
|---|---|---|---|
| A | 5.82 | 5 | 10 / 15 |
| B | **4.80** | 5 | 12 / 15 |
| C | 5.80 | 4 | 14 / 15 |
| D | 6.53 | 4 | 15 / 15 |

At cap 12, three of four retries failed the slot one-sentence rule. **At 15 that is down to
one occurrence in one attempt.** Email 1 is no longer the thing standing in the way.

**What blocks the document now is EMAILS 2 AND 3**, which are held to grade 5 with a 25-word
sentence cap:

| variant | still failing | grade | longest sentence |
|---|---|---|---|
| A | nothing | | **CLEAN** |
| B | Email 2, Email 3 | 5.85, 5.06 | 19, 17 words |
| C | Email 2 only | 5.41 | 17 words |
| D | Email 1, Email 2, Email 3 | 6.53, 5.42, 6.52 | 15, 20, 24 words |

**C is one email away, by 0.41 of a grade. B's Email 3 is over by 0.06.**

### A DEFECT IN THE RETRY FEEDBACK, WHICH I INTRODUCED

The grade message names the sentence cap of the email's own position. For Email 1 that is
15 and it is the binding constraint, which is why it worked. **For emails 2 to 4 the cap is
25 and it is not binding at all**, so the message now contradicts itself:

> Your longest sentence is 19 words ... **against a cap of 25** ... break it.

It tells the model to break a sentence and in the same breath tells it the sentence is
comfortably legal. Every remaining failure is an email 2 or 3 whose longest sentence is 17
to 24 words: inside the cap, too long for grade 5.

This is the same shape as the original Email 1 problem one position over, and it has the
same two candidate answers: lower the sentence cap for emails 2 to 4, or stop quoting a
non-binding cap in the grade message and quote the words-per-sentence the grade actually
needs. **Neither is taken here.**

### Cross-variant sentence reuse: still cannot fire

One clean variant. Five consecutive runs now.

### Nothing landed

1 of 4 is below the agent's own minimum of **three** variants, so no suggestion row was
written and v6 is still active. The 3-variant floor is worth noting because earlier entries
in this file said a document needs four: it does not, it needs three, which makes B and C
the two that matter.

### Grade, words and sentences per email, best attempt per variant

| attempt | email | grade | cap | words | sentences | longest sentence | verdict |
|---|---|---|---|---|---|---|---|
| A-retry-2 | 1 | 5.82 | 6 | 40 | 5 | 10 / 15 | clean |
| A-retry-2 | 2 | 3.25 | 5 | 59 | 6 | 16 / 25 | clean |
| A-retry-2 | 3 | 4.88 | 5 | 38 | 3 | 14 / 25 | clean |
| A-retry-2 | 4 | 4.81 | 5 | 35 | 3 | 18 / 25 | clean |
| B-retry-2 | 1 | 4.80 | 6 | 53 | 5 | 12 / 15 | clean |
| B-retry-2 | 2 | 5.85 | 5 | 54 | 4 | 19 / 25 | grade |
| B-retry-2 | 3 | 5.06 | 5 | 47 | 4 | 17 / 25 | grade |
| B-retry-2 | 4 | 4.57 | 5 | 38 | 3 | 20 / 25 | clean |
| C-retry-2 | 1 | 5.80 | 6 | 50 | 4 | 14 / 15 | clean |
| C-retry-2 | 2 | 5.41 | 5 | 58 | 5 | 17 / 25 | grade |
| C-retry-2 | 3 | 2.59 | 5 | 38 | 5 | 13 / 25 | clean |
| C-retry-2 | 4 | 2.58 | 5 | 32 | 3 | 20 / 25 | clean |
| D-retry-2 | 1 | 6.53 | 6 | 49 | 4 | 15 / 15 | grade |
| D-retry-2 | 2 | 5.42 | 5 | 61 | 5 | 20 / 25 | grade |
| D-retry-2 | 3 | 6.52 | 5 | 45 | 3 | 24 / 25 | grade |
| D-retry-2 | 4 | 4.53 | 5 | 37 | 3 | 20 / 25 | clean |

---

## 2026-09-23, cap 15 everywhere — the grade problem is solved and nothing landed

### Step 1: re-validating the dumps under the uniform cap — 0 of 4, and it cost us A

Tightening emails 2 to 4 from 25 to 15 **broke the only variant that was passing.** A was
clean; under the new cap its Email 2 carries a 16-word sentence and its Email 4 an 18-word
sentence. One word over and three words over. Its grades were never in question (3.25 and
4.81).

**So "A stays untouched" stopped being available the moment the cap changed**, and all four
variants were missing rather than three. That is a direct consequence of the instruction and
is recorded rather than worked around.

### Step 2: one repair pass over all four, D capped at one round

Six calls, 152s. **0 of 4 passed.** Budget exhausted.

### THE GRADE PROBLEM IS ESSENTIALLY SOLVED

Across the closest attempt for each variant, **15 of 16 emails now pass the reading grade**,
and they pass it comfortably:

| | E1 | E2 | E3 | E4 |
|---|---|---|---|---|
| A | 5.82 | 3.25 | 4.88 | 4.81 |
| B | **7.62** | 4.37 | 2.48 | 3.71 |
| C | 3.60 | 3.44 | 4.79 | 1.69 |
| D | 5.96 | 1.70 | 2.04 | 3.75 |

Compare the live v6 document this started from: mean 6.95 on the same surface, 14 of 16
over. Only B's Email 1 is still over, and only there.

### WHAT ACTUALLY BLOCKS EACH VARIANT NOW IS MECHANICAL

| variant | closest attempt | violations | what they are |
|---|---|---|---|
| A | A-retry-2 | 2 | a 16-word and an 18-word sentence. Nothing else. |
| B | r7-B-retry-1 | 1 | Email 1 grade 7.62 |
| C | C-retry-1 | 2 | Email 1 observation AND consequence each hold 2 sentences |
| D | r6-D-retry-1 | 2 | the word "ICP" in Email 3, and a 21-word sentence in Email 4 |

**Every variant is one or two violations from clean, and three of the four are not grade
failures at all.** A needs two sentences broken. D needs one word replaced and one sentence
broken. Neither is a readability problem.

### The new feedback is doing its job

B's rejection now reads:

> reading grade 7.6 is above the maximum of 6. Your 46 words are split across 4 sentences,
> which averages 11.5 words each. To reach 6 at the vocabulary you have used, you need to
> average **7.3 words per sentence or fewer** ...

No cap is quoted anywhere in it. The old message would have said "against a cap of 15" beside
a longest sentence of 14 words, which is legal, and told the model nothing it could act on.

### Cross-variant sentence reuse: still cannot fire

Zero clean variants. Six consecutive runs.

### Nothing landed

0 of 4 is below the agent's minimum of three, so no suggestion row was written and v6 is
still active.

### Grade, words and sentences per email, closest attempt per variant

| attempt | email | grade | cap | words | sentences | longest sentence | verdict |
|---|---|---|---|---|---|---|---|
| A | 1 | 5.82 | 6 | 40 | 5 | 10 / 15 | clean |
| A | 2 | 3.25 | 5 | 59 | 6 | 16 / 15 | sentence len |
| A | 3 | 4.88 | 5 | 38 | 3 | 14 / 15 | clean |
| A | 4 | 4.81 | 5 | 35 | 3 | 18 / 15 | sentence len |
| B | 1 | 7.62 | 6 | 46 | 4 | 14 / 15 | grade |
| B | 2 | 4.37 | 5 | 51 | 7 | 12 / 15 | clean |
| B | 3 | 2.48 | 5 | 24 | 4 | 11 / 15 | clean |
| B | 4 | 3.71 | 5 | 25 | 3 | 15 / 15 | clean |
| C | 1 | 3.60 | 6 | 47 | 7 | 13 / 15 | slot 1-sentence, slot 1-sentence |
| C | 2 | 3.44 | 5 | 61 | 8 | 14 / 15 | clean |
| C | 3 | 4.79 | 5 | 44 | 4 | 13 / 15 | clean |
| C | 4 | 1.69 | 5 | 36 | 4 | 13 / 15 | clean |
| D | 1 | 5.96 | 6 | 41 | 4 | 11 / 15 | clean |
| D | 2 | 1.70 | 5 | 50 | 10 | 9 / 15 | clean |
| D | 3 | 2.04 | 5 | 41 | 6 | 10 / 15 | other |
| D | 4 | 3.75 | 5 | 34 | 3 | 21 / 15 | sentence len |
