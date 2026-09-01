# PART 1 — Removal, repairs, and what removal cost

Branch `no-examples`. `buildWriterPrompt` only. Nothing else in the prompt pipeline changed.

| | main | no-examples | delta |
|---|---|---|---|
| chars | 45,355 | 32,830 | −12,525 |
| lines | 823 | 600 | −223 |
| words | 7,951 | 5,846 | −2,105 |
| **tokens** | **11,054** | **7,984** | **−3,070 (−27.8%)** |
| `write-opening.ts` file lines | 2,001 | 1,779 | −222 |

Token counts are live `messages.countTokens` against `claude-sonnet-4-6`, system prompt
plus a one-character user turn, measured identically before and after.

---

## (b) Every rewrite, verbatim, before and after

Twenty-seven excisions. Where a rule's own words survived untouched they are not reproduced
here; only the passages whose WORDING changed appear below. Excisions that removed a block
outright and repaired nothing are listed at the end.

### 1. The four approved closing questions

**Before**
```
These four are the client's own approved closing questions. They are here to show you
REGISTER AND LENGTH. They are not a menu and they are not four options to choose between:
  "Is pipeline consistency something you're actively trying to fix?"
  "Is getting more conversations in front of you something you're working on?"
  "Is this a gap you're looking to close?"
  "Worth a look to see if it fits where you are?"

The approved question for this particular variant is named in the ASSIGNMENT block, and the
same applies to it.

Your default is to WRITE a question for this prospect. Using one of the four verbatim is
permitted only when it genuinely is the right question for this person, which will be rare,
because a question written for the problem you just named will almost always beat a generic
one. Twelve prospects came back and six of them carried the same approved question word for
word. That is what happens when register anchors get read as a shortlist, and it undoes the
work the observation and the bridge just did.
```

**After**
```
The approved question for this particular variant is named in the ASSIGNMENT block. It is
there to show you REGISTER AND LENGTH. It is not a menu and it is not an instruction to
reuse it.

Your default is to WRITE a question for this prospect. Using the approved one verbatim is
permitted only when it genuinely is the right question for this person, which will be rare,
because a question written for the problem you just named will almost always beat a generic
one. Twelve prospects came back and six of them carried the same approved question word for
word. That is what happens when a register anchor gets read as a shortlist, and it undoes the
work the observation and the bridge just did.
```

**A JUDGEMENT CALL, FLAGGED SO IT CAN BE REVERSED.** These four are the specimens the prior
count of 58 most likely excluded, so removing them may go one step past the experiment as
posed. Three reasons for removing them anyway, and the third is the one that decides it:
they are prospect-facing copy quoted verbatim in the prompt; the prompt's own text records
six of twelve prospects returning one word for word, which is the largest measured instance
of the very harm under test; and **removing them costs no register**, because the variant's
own approved CTA still reaches the writer through the ASSIGNMENT block, which is
per-prospect text outside the cached system prompt. Leaving the most-copied specimens in
while removing everything else would confound the experiment in the other direction.

### 2. The question-aim rule

**Before**
```
THE QUESTION MUST ASK ABOUT THE PROBLEM YOU JUST NAMED. This is where a fixed question
used to go wrong, and the failure is worth reading:
[FAILING pair + CORRECTED question]
```

**After**
```
THE QUESTION MUST ASK ABOUT THE PROBLEM YOU JUST NAMED.
```

### 3. The contradiction check

**Before**
```
READ THE OBSERVATION AND THE BRIDGE TOGETHER BEFORE YOU RETURN THEM. THEY MUST NOT
CONTRADICT EACH OTHER. This shipped:
  observation: his LinkedIn posts for the last 60 days are all external regulatory news.
  bridge: "When delivery runs first for 13 months, that tends to be what stays visible."
The observation says his feed is regulatory news. The bridge says what stays visible is
delivery. Both cannot be true, and the reader is the one who notices.
```

**After**
```
READ THE OBSERVATION AND THE BRIDGE TOGETHER BEFORE YOU RETURN THEM. THEY MUST NOT
CONTRADICT EACH OTHER. The reader is the one who notices.
```

### 4. Do not assume they have nobody

**Before**
```
DO NOT ASSUME THEY HAVE NOBODY.
This shipped: "With three active CEO roles, the follow-up after a moment like that rarely
gets its own slot." It assumes that because he holds three roles, nobody is doing the
follow-up. He probably has people. Claiming to know their CAPACITY, ...
```

**After**
```
DO NOT ASSUME THEY HAVE NOBODY.
They probably have people. Claiming to know their CAPACITY, ...
```

`He` became `They` because its antecedent was the deleted specimen's subject.

### 5. The ban covers implied choice

**Before**
```
THE BAN COVERS IMPLIED CHOICE.
This shipped: "When your feed points elsewhere, the people who might hire you do not know
HydrospherIQ exists."
That is not "you have no posts". It is "your posts are for somebody else's company", which
is worse, because it implies he chose that. Never tell the reader what they have decided
to put first.
```

**After**
```
THE BAN COVERS IMPLIED CHOICE.
Never tell the reader what they have decided to put first.
```

### 6. The bridge must follow from its own observation

**Before**
```
The bridge is about the same thing the observation named. Not a second, unrelated point that
happens to be true of the same person.

FAILING, and both halves are fine on their own:
  observation: two board seats in early 2026, on top of running the firm full time.
  bridge: "Your LinkedIn posts reach people who already respect the work."
Board seats and LinkedIn posts are two different subjects. The second paragraph does not
follow from the first, so the reader arrives at it wondering when the subject changed. If
the observation is board seats, the bridge is about what board commitments do to the week.
```

**After**
```
The bridge is about the same thing the observation named. Not a second, unrelated point that
happens to be true of the same person. Where it names a different subject, the reader arrives
at it wondering when the subject changed.
```

### 7. The change-of-state gesture

**Before**
```
FAILING: "Outreach for the new-business side sits until it does not."
"Until it does not" is a shape where a fact should be. Nothing is named: ...
```

**After**
```
A construction like "until it does not" is a shape where a fact should be. Nothing is named: ...
```

The banned SHAPE stays, quoted as a fragment. The sentence built on it does not.

### 8. Keep it inside the budget

**Before**
```
AND KEEP IT INSIDE THE BUDGET. The longest bridge in the last batch was 32 words and it was
also the one still explaining:
FAILING: "the advisory work fills the diary, and the question of who to go after next stays
 unresolved long after the call ends."
One sentence carrying a clause, a second clause and a trailing qualifier. Two sentences, each
standing on its own, and inside the bridge budget.
```

**After**
```
AND KEEP IT INSIDE THE BUDGET. The longest bridge in the last batch was 32 words and it was
also the one still explaining: one sentence carrying a clause, a second clause and a trailing
qualifier. Two sentences, each standing on its own, and inside the bridge budget.
```

### 9. Attribution as flat fact

**Before**
```
A bridge stated flatly as how the world works is the bluntness that reads presumptuous.
"Governance work has fixed dates and shows up on a calendar. Business development does not."
is delivered as fact about their category, and the reader either agrees or has been told
they are wrong about their own week.
```

**After**
```
A bridge stated flatly as how the world works is the bluntness that reads presumptuous. It is
delivered as fact about their category, and the reader either agrees or has been told they
are wrong about their own week.
```

### 10. The four bridge constructions

**Before** — an introductory paragraph plus four labelled shapes, each with a quoted
sentence attributed to a dentist, a commercial builder, a freight broker and a wedding
photographer.

**After** — the four labels and their one-line descriptions, nothing under them:
```
  A CONDITIONAL. Puts their own situation on the left of the sentence.

  WHAT USUALLY HAPPENS NEXT. Plain sequence, no hedging verb at all.

  A CONTRAST. Two short clauses, the second overturning the first.

  A CONSEQUENCE. States the position their situation puts them in.
```

The whole `EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY TO YOUR PROSPECT'S` paragraph
went with them: it exists only to introduce examples. `There are more shapes than these four`
is unchanged, because the four shapes are still named and "four" does not dangle.

One more dangling reference in the same section:

**Before** `...and it used to be the shape of nearly every worked example on this page.`
**After** `...and it used to be the shape of nearly every bridge this prompt endorsed.`

### 11. Pattern framing is not permission to go generic

**Before**
```
  Generic, and therefore useless: "Most firms at this stage find pipeline slips."
It is safe, it obeys every rule above, and it says nothing. The approved paragraph further
down the email already makes that point, so you have added a line and no information.
```

**After**
```
A generic pattern is safe, it obeys every rule above, and it says nothing. The approved
paragraph further down the email already makes that point, so you have added a line and no
information.
```

### 12. The reading-age line

**Before** `... "Hours shrink before they grow" is eight easy words and it describes nothing.`
**After** `... Eight easy words can describe nothing at all.`

### 13. The two CRAMPED / CLEAN pairs

**Before** — two quoted cramped sentences and two quoted rewrites, with four glosses.

**After**
```
CRAMPED, and both of these shipped: a fragment, then a list, then a verb whose subject is
three clauses back. By the time you reach the verb you have forgotten what is doing the
showing. And an appositive list that swallows the subject, so the predicate arrives with
nothing attached to it.

CLEAN, same facts, nothing lost: sentences that each carry a single idea, with every subject
sitting next to its verb. The naming sits inside a clean subject and verb rather than
replacing one.

Note what did NOT change in either rewrite. Same facts, same specificity, same length
roughly. Only the joins moved.
```

### 14. Clear on one reading

**Before**
```
FAILING on clarity, and note this one is correctly pattern-framed, so getting the stance
right is not enough:
  "That tends to be when the next engagement goes uncontested to whoever stayed visible."
The idea is sound and the reader has to assemble it. Who is uncontested, what contest,
visible to whom. Say it plainly: "That is usually when the next piece of work goes to
whoever was still in front of them."
```

**After**
```
A sentence can be correctly pattern-framed and still fail here, so getting the stance right
is not enough. Where the idea is sound and the reader has to assemble it, say it plainly
instead.
```

### 15. HARD / EASY / the rewritten hard one

**Before** — three quoted sentences with their diagnoses.

**After**
```
The hard sentences that shipped ran ten words before the verb, with three relative clauses,
one nested inside another. Every word of them is true and nobody reads them once.

The easy ones were barely shorter. A four-word subject, one relative clause, nothing nested.
Nothing is dropped and nothing is softened. The reader is simply never asked to hold more
than one idea at a time.
```

### 16. Load and output as judgement calls

**Before** `... As a bare subject they are not: "that output shows where your thinking is" leaves the reader wondering what output.`
**After** `... As a bare subject they are not: a sentence about what "that output" shows leaves the reader wondering what output.`

The permitted fragment `"a real operational load"` is untouched.

### 17. The ABSTRACT / CONCRETE pairs and the endorsed standard bridge

**Before** — five quoted bridges under `ABSTRACT`, `CONCRETE` and `CONCRETE, already
working, and this is the standard`, with five glosses.

**After**
```
Nobody can picture a remainder. Hours, on the other hand: a reader knows exactly how many of
those they had last week. A metaphor does work a plain sentence should do, and it leaves the
reader asking which thing and what for. The concrete version of the same claim names the
place, the people and what is missing.
```

### 18. The camera-test worked pair

**Before**
```
  "Hours shrink before they grow" is unfilmable. Nobody can photograph an hour shrinking.
  "Delivery has a deadline. Business development never does, so it waits" is filmable: a
  calendar with a date on it, and something pushed to next week.
```

**After**
```
Nobody can photograph an hour shrinking. A calendar with a date on it, and something pushed
to next week, is a thing a camera can see.
```

### 19. The two camera failures and their rewrites

**Before** — two FAILING / PLAIN pairs with four glosses.

**After**
```
Two sentences shipped last week with concrete nouns throughout and both failed. Hours do not
grow: point the camera and there is nothing to film. People do not become conversations, and
"need a nudge" is not something anyone does either.

A day ending and a person not making the call is filmable. An inbox with nothing in it is
filmable. That is the bar.
```

### 20. The four shipped openings

**Before** — four quoted openings, each with a one-clause diagnosis.

**After**
```
The camera test fixed the ENDINGS and every bridge now films. It never reached the OPENINGS,
and the same fault is sitting in them untouched. Four openings shipped in the last batch
whose subjects were categories rather than people, whose verbs nothing could perform, whose
nouns belonged to nobody, and which folded a whole clause into a compressed phrase.
```

### 21. SAY YOUR

**Before** — the rule, then a `FAILING:` / `PLAIN:` pair.
**After** — the rule alone, unchanged in wording. Only the pair was cut.

### 22. The two dossier failures

**Before**
```
FAILING:
  "Jason left Pani as Director of Product in July 2024 and launched HydrospherIQ three
   months later, with a current headcount of one."
Third person, about him rather than to him. A dossier entry. It leads nowhere.

FAILING:
  "You left Visteon at SVP level in December 2022. Your own firm has been the full focus
   since July 2023."
Second person and still wrong. It recites his own CV back at him. He knows all of it.
```

**After**
```
Writing in the third person, about them rather than to them, is a dossier entry. It leads
nowhere.

Writing in the second person and reciting their own CV back at them is still wrong. They
know all of it.
```

### Excisions that repaired nothing, because the rule above them was already complete

- The `VERDICT` / `PATTERN, corrected` / `VERDICT again` trio under **THE BRIDGE NAMES A
  PATTERN**, with the print-shop re-welding note.
- The `WORKS` and `FAILS` specimen lists under **THE BRIDGE STATES ONE TRUE THING**.
- The four `FAILING` / `WORKING` bridges under **THE CONSEQUENCE MUST NOT TURN THE OFFER
  LINE INTO A DIFFERENT JOB**.
- **THE THREE WORKED PAIRS**, entire section, plus the `THESE THREE ARE ABOUT STANFORD GSB,
  TWO CEO ROLES AND THE CAVE STAND` paragraph. Its three lessons are each already stated as
  rules above it: `THE SUBJECT IS THEM`, `THE PLAIN-VERB RULE APPLIES TO THE SUBJECT`, and
  `NAME THE THING EXACTLY`.
- The `AIMED WRONG` / `AIMED RIGHT` worked failure under **THE AIM TEST**.

### One code comment, not prompt text

The file header above `buildWriterAssignment` described the prompt as "deliberately almost
ruleless" with "the standard set by four labelled examples". It was already stale on `main`
and would have actively misdescribed the file after this change, so it now states the
branch's premise instead. This is the only edit outside the prompt string and the tests.

---

## (c) What removal cost: lessons that lived ONLY in an example

Eight. Each was a distinction the prose never made, carried entirely by the specimen and its
gloss. **No replacement prose was invented for any of them**, per Rule Zero.

1. **More versus different.** The question-aim rule now says the question must ask about the
   problem just named. What it no longer says is the specific failure mode: where the bridge
   diagnoses the WRONG KIND of something, a question asking for MORE of it is aimed at
   somebody else's problem. That distinction existed only in the browsers-versus-buyers pair.

2. **A verdict can be wrong as well as presumptuous.** The prose bans verdicts on grounds of
   presumption. The Chamber-event specimen carried a second, sharper point: the thing you
   told them does not work may be exactly how their whole category fills capacity. Gone.

3. **"Your posts are for somebody else's company" is worse than "you have no posts."** The
   implied-choice ban now says only "never tell the reader what they have decided to put
   first". The RANKING, that implying a choice is worse than naming an absence, was only in
   the gloss.

4. **Which gap is which.** The offer-line rule bans a gap about an audience they already
   have. The four specimens distinguished four cases the prose does not: a room that already
   heard them speak, an audience they built themselves, a sentence with no gap in it at all,
   and a working gap aimed at strangers. Only the ban survives; the taxonomy does not.

5. **A bridge can fail by double jeopardy.** The product-shop specimen failed twice at once,
   under this rule AND under the never-say-it-is-not-working rule, and said so. Nothing now
   tells the writer that two rules can bite the same sentence.

6. **What a fix does NOT change.** `Note what did NOT change in either rewrite. Same facts,
   same specificity, same length roughly. Only the joins moved.` survives as a sentence, but
   with no before and after to point at, it is now an assertion rather than a demonstration.
   The same is true of `Barely shorter` and `Nothing is dropped and nothing is softened`.
   These are the three places where removal most obviously weakens the instruction.

7. **The standard to aim at.** `"Delivery has a deadline. Business development never does,
   so it waits."` was the prompt's one endorsed target bridge, cited twice. There is now no
   worked target anywhere in the prompt. **This is the largest single loss, and it is also
   the most-copied sentence in the file's history**, which is precisely the tension the
   experiment exists to resolve.

8. **The register of the closing question.** Removed from the system prompt; still supplied
   per prospect by the ASSIGNMENT block. Listed here for completeness rather than as a loss.

---

## (d) The tests

**Main: 172 tests in `write-opening.test.ts`. Branch: 158.** 27 rewritten, 18 removed,
4 added. Three `describe` blocks were emptied by the removals and deleted with them.

### Purpose survives — rewritten to assert the RULE instead of the example (27)

`bans verdicts`, `blocks generic patterns`, `requires clarity on one reading`, `aims the
bridge at the offer`, `keeps the diagnosis of the cramped shape`, `still says the fix is the
joins`, `keeps the diagnosis of load`, `offers four genuinely different shapes`, `says write
do not pick`, `extends the register-only framing`, `keeps load and output as judgement
calls`, `keeps the abstraction diagnosis`, `drops the reading-age line`, `says what the
camera can and cannot see`, `keeps both camera diagnoses`, `requires the observation and
bridge to be read together`, `bans assuming they have nobody`, `extends the absence ban to
implied choice`, `states the rule that the bridge follows its own observation`, `names the
empty change-of-state construction`, `keeps the budget lesson`, `bans the three ways of
naming an audience they already have`, `bans the causal shapes by name`, `states the rule
without two endorsed bridges under it`, `states the question-aim rule without illustrating
it`, `the two dossier failures are stated as rules`, `carries no approved CTA of its own`.

The last four now assert ABSENCE where they used to assert presence, which is the honest
form of the same purpose on this branch.

### Purpose goes with the examples — removed (18)

- `stops the lifting by making the words unusable rather than by warning harder`,
  `uses four industries deliberately foreign to the prospect`, `says the words are
  unusable` — all three protect a paragraph whose only job was to introduce examples. The
  lifting they guard against is now prevented by removal rather than by warning.
- `the four examples do not collide with each other under the batch gate`, `the four worked
  shapes do not collide`, `does not collide with the other worked examples`, `the examples
  themselves are concrete`, `the plain rewrites obey every rule they sit under`, `the
  concrete rewrites in the prompt score zero`, `the corrected bridge obeys every rule it now
  sits under` — seven tests asserting that the prompt's own examples obey the prompt's own
  rules. With no examples, there is nothing to check.
- `keeps the working bridge as the standard to aim at`, `carries the working example and
  says why it works` — both pin an ENDORSED specimen, the category with every recorded copy
  incident.
- `is about a print shop, not a hire and a network`, `records why it was re-welded`, `no
  longer carries the phrasing that was reproduced almost verbatim`, `no longer carries the
  two phrases that were lifted and then rejected` — four tests about which example a rule
  should carry, and two of them sliced the prompt between example anchors that no longer
  exist.
- `every quoted FAILING bridge is labelled as failing, not as a model`, `the one WORKING
  bridge quoted here is Makesha's own` — the anti-copy guard, subsumed by the new
  whole-prompt test below.

### Added (4), under `the writer prompt carries no worked example`

This generalises `RULE ZERO` in `writer-four-rules.test.ts`, which already asserted exactly
this property over four rule blocks and cites the same eight copy incidents.

- **every quoted span of 20+ characters is a named shape, not a sendable sentence.** An
  explicit allowlist of the 12 surviving long quotations, each a banned shape the rule names
  (`"when X, that tends to be Y"`, `"Firms that X often find Y"`), a permitted phrase
  (`"a real operational load"`), or text from the shared firmographic rule.
  **A note on the detector, because the obvious version is wrong.** A paired regex
  `/"([^"]{25,})"/g` backtracks past a short quotation and silently shifts the parity, after
  which it reports the text BETWEEN quotations as if it were quoted. That version returned
  25 "spans", none of them real, one of them 1,900 characters of ordinary rule prose. The
  test splits on the quote character and takes the odd-indexed segments, and asserts the
  quote count is even first.
- **names nobody**: 16 proper nouns that lived only in examples are asserted absent.
- **carries no specimen labels**: `FAILING:`, `WORKING:`, `AIMED WRONG:`, `CRAMPED:` and
  nine others. `AIMED WRONG` without the colon is still rule prose further down, so the test
  asserts the label form.
- **still a zero-argument constant.**

### Unchanged and still passing

`RULE ZERO` (writer-four-rules), `carries no example subject line` (write-opening-subject),
`offers no worked example of a permitted attribution`, `rules out the peer group as fact`
(the two quoted offenders are fragments and stay), and both cache-invariant tests in
`resolve-buyer.test.ts`.
