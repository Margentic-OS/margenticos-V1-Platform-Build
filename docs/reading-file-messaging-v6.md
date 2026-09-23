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
