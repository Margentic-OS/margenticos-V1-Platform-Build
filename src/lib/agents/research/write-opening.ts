// Write-in-context plus a single judge.
//
// WHY THIS REPLACES RULE-PATCHING
// The opening used to be written by a step that had never seen the email it lands in.
// It passed every gate and still failed as an email: one opened in the third person
// ("Jason left Pani as Director of Product in July 2024"), another recited the prospect's
// own CV back at him, and none led into the offer line. Each failure produced another
// rule, and rules do not converge on taste.
//
// So the writer now sees the variant's actual P3 and CTA and writes the opening FOR that
// email, and a separate model reads the finished artifact cold and answers one question.
// The six-test scoring survives only as a RANKER of raw material handed to the writer.
// It no longer selects what ships.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import { findFirmographicFigures, FIRMOGRAPHIC_RULE_TEXT } from '@/lib/style/firmographic'
import { checkSentenceInitialNames } from '@/lib/style/sentence-initial-names'
import { checkFiniteVerbs } from '@/lib/style/finite-verb'
import { checkOpeningReferences } from '@/lib/style/opening-reference'
import { readabilityScore } from '@/lib/style/readability'
// The subject character cap lives with the messaging agent's other limits and is
// imported rather than restated: a second copy of a number is a second thing to keep
// in step by hand, and CLAUDE.md names that constant as the source of truth.
import { EMAIL_SUBJECT_LIMITS } from '@/agents/messaging-generation-agent'
import { BatchUniquenessRegistry, uniquenessFeedback } from './batch-uniqueness'
import type { ObservationCandidate, TokenUsage } from './types'
import { ZERO_TOKEN_USAGE, addTokenUsage, readTokenUsage } from './types'

const WRITER_MODEL = 'claude-sonnet-4-6'
const JUDGE_MODEL = 'claude-sonnet-4-6'

// ── TEST VALUE. NOT A SHIPPING DECISION. ─────────────────────────────────────
//
// Set to 0 on the `temperature` branch to make a run reproducible so that a change
// to the prompt can be measured against something that does not move on its own.
// Before this, no sampling parameter was set anywhere in src, so every call ran at
// the API default of 1.0, and 41 prospects with byte-identical input produced 41
// different outputs with zero repeats. That noise floor is larger than most of the
// effects we have been trying to read.
//
// Determinism is the OPPOSITE of what production wants: the batch uniqueness gate
// exists precisely to force variety between prospects, and a lower temperature makes
// the writer more uniform. Whatever value ships is a separate decision, taken on
// measured variety, not inherited from this test.
//
// One constant, one place to change it. It is applied to the writer, the floor judge
// and the judge, which is every model call this file makes. synthesize.ts has its own
// call and is deliberately untouched: this test isolates the writer path.
const MODEL_TEMPERATURE = 0

/**
 * Hard cap on the whole written block: observation, bridge AND closing question.
 *
 * SET BELOW THE AVAILABLE SPACE UNTIL 2026-08-20, and it cost two prospects. The cap was
 * 62 while the email could hold 70. Jason came in at 70 and Shevonne at 75, and both were
 * rejected against a limit lower than the email actually has. Jason's would have shipped.
 *
 * RE-MEASURED against the current shape, where the writer owns the closing question and
 * the fixed parts are the greeting line, the approved P3 and the two sign-off lines. The
 * footer is excluded because it is appended after word_count and never consumes budget.
 *
 *   variant | greeting | P3 | sign-off | fixed | headroom against the 90-word ceiling
 *      A    |    1     | 16 |    2     |  19   |  71
 *      B    |    1     | 14 |    2     |  17   |  73
 *      C    |    1     | 13 |    2     |  16   |  74
 *      D    |    1     | 17 |    2     |  20   |  70   <- tightest
 *
 * ONE GLOBAL FIGURE, NOT PER-VARIANT. The spread is four words, so per-variant caps would
 * buy at most four words on one variant and add a parameter to every call site, every test
 * and every gate message. A single number is also what the prompt states, and a prompt that
 * has to say "at most 67 words, or 71 if this is variant A" is a worse prompt.
 *
 * Tightest headroom minus 3 = 67. The margin absorbs a contraction counted as one word
 * where the reader sees two, and leaves the ceiling unbreachable rather than nearly so.
 */
export const OPENING_MAX_WORDS = 67

/**
 * PER-PART TARGETS, and the reason they exist is measured rather than guessed.
 *
 * The writer expands to fill whatever single total it is handed and then overshoots by
 * roughly ten words. At a 62-word cap the overruns were 70 and 75. The cap was raised to
 * 67, which is the real headroom, and the overruns became 74, 75, 77 and 78. Four of five
 * fallbacks in that batch were length alone, and every one of them had already been told
 * its exact word count in retry feedback, twice.
 *
 * A single total also lets the writer borrow: a 35-word observation is paid for by a
 * 15-word bridge, and the bridge is the part that carries the reason to reply. Naming a
 * budget per part removes the borrowing and gives the retry something specific to cut.
 *
 * These are TARGETS, not the gate. The hard limit stays OPENING_MAX_WORDS and nothing here
 * rejects anything. 22 + 22 + 14 = 58, which leaves nine words of slack under 67, chosen so
 * that the observed overshoot still lands inside the cap instead of outside it.
 */
export const OPENING_BUDGET = {
  observation: 22,
  bridge:      22,
  question:    14,
} as const

/** The sum of the per-part targets. What the prompt aims at, not what the gate enforces. */
export const OPENING_TARGET_WORDS =
  OPENING_BUDGET.observation + OPENING_BUDGET.bridge + OPENING_BUDGET.question

export interface OpeningResult {
  /**
   * Every Anthropic call this prospect made, summed: writer, floor and judge across all
   * attempts, including the attempts that were discarded. Written into
   * job_queue.spend_detail so a retried prospect's real cost is visible.
   */
  usage: TokenUsage
  /** The opening that shipped, or null when the template won or the floor disqualified it. */
  opening: string | null
  /**
   * The two halves of that opening, kept apart because they are now separate paragraphs
   * and because only the bridge is subject to the batch-uniqueness gate. Both are null
   * whenever `opening` is.
   */
  observation: string | null
  bridge: string | null
  /** The closing question that shipped, set and cleared together with `opening`. */
  question: string | null
  /**
   * The Email 1 subject written from the observation, or null.
   *
   * NULL FOR TWO DIFFERENT REASONS, and both mean the same thing downstream: either the
   * whole attempt fell back to the template, or the opening shipped and only the subject
   * was rejected by its own soft gate. Composition treats null as "use the variant's
   * authored subject", so it never has to tell the two apart.
   */
  subject: string | null
  /** True when the written opening beat the approved template on the final comparison. */
  written_won: boolean
  /** True when the writer was given feedback and tried again at least once. */
  retry_used: boolean
  /** How many rewrite attempts ran after the first. 0, 1 or 2. */
  retries_used: number
  /**
   * True when the prospect had at least one candidate passing all six tests, which is
   * what buys the second retry. Weak material keeps one and falls back as before.
   */
  strong_material: boolean
  /**
   * Every comparison run, in order. One entry normally, two when a retry happened.
   * Both attempts and both verdicts are kept: the second attempt used to be discarded on
   * a losing verdict, which left the audit trail showing a rewrite with no record of what
   * the rewrite said.
   */
  comparisons: JudgeComparison[]
  /** The judge's sentence from the final comparison. */
  judge_reasoning: string
  /** Deterministic gate failures on the attempt that was finally used, if any. */
  gate_failures: string[]
}

// ─── The writer prompt ───────────────────────────────────────────────────────
//
// Deliberately almost ruleless. Tonight's failures came from optimising rules, so the
// standard is set by four labelled examples taken from real output rather than by a
// rulebook. Examples get copied, which is exactly why these four are the ones present:
// they define the target better than any description of it would.

/**
 * The per-run assignment: who the client is, the fixed offer line, and the approved
 * closing question for this variant. Goes at the TOP of the user message, above the
 * findings, because the prompt tells the writer to read the offer line before the findings.
 *
 * WHY THIS IS NOT IN THE SYSTEM PROMPT ANY MORE. Caching is a prefix match. clientName sat
 * on line 1 of the system prompt and p3 on line 22, so on a ~9,300-token prompt only the
 * first handful of tokens were ever stable and nothing could be cached. p3 and cta vary by
 * VARIANT, so even a per-client cache would have split four ways.
 *
 * With these moved out, the writer system prompt is a constant. It is identical for every
 * prospect, every variant and every client, which matters most on the retry path: a
 * prospect burning three writer attempts sent this prompt three times, and it is ~93%
 * static.
 */
export function buildWriterAssignment(params: {
  clientName: string
  /**
   * Who is reading it, resolved by resolveBuyer. IN THE ASSIGNMENT AND NOT THE SYSTEM
   * PROMPT, because it varies per prospect and per client, and the system prompt is
   * ~9,300 cached tokens sent up to three times per prospect. One interpolation there
   * would miss the cache on every writer call in the system.
   */
  buyer: string
  p3: string
  cta: string
}): string {
  return `## Assignment

You are writing for: ${params.clientName}

Who you are writing to: ${params.buyer}

THE OFFER LINE (this is the fixed middle paragraph referred to in your instructions. It is
the client's approved positioning. Reproduce it exactly, do not alter or paraphrase it):

  ${params.p3}

The approved closing question for this particular variant is "${params.cta}". Like the four
in your instructions, it shows register and length. It is not an instruction to reuse it.`
}

export function buildWriterPrompt(): string {
  return `You are a senior BDR with fifteen years behind you, writing for the client named in
the ASSIGNMENT block at the top of the user message.

You are writing to the person the ASSIGNMENT block names. Assume nothing else about who
they are: not their seniority, not their industry, not how their business is run. You
respect them, they are good at their job, and they get a lot of these.
Your only goal is a reply. Not to demonstrate that you did the research. Not to prove you
looked them up. A reply.

That distinction decides everything about how you open. A junior opens by showing their
work, because they are being marked on effort. You are not. You open with the one thing
you noticed that makes this person worth writing to, and you let it do the work.

Here is the email, exactly as it will send. You write the three bracketed parts:

  [YOUR OBSERVATION GOES HERE]

  [YOUR BRIDGE GOES HERE]

  [THE OFFER LINE — given verbatim as "THE OFFER LINE" in the ASSIGNMENT block above the
   findings. You do not write this paragraph. It ships exactly as given.]

  [YOUR CLOSING QUESTION GOES HERE]

The observation and the bridge are SEPARATE PARAGRAPHS with a blank line between them.
They are not one paragraph and they are never run together. Each one gets its own line of
white space, which is what stops you cramming two jobs into one sentence.

The offer line in the middle is FIXED. It is the client's positioning and what they
approved. Do not alter it, do not paraphrase it, do not work around it.

START BY READING THE OFFER LINE, BEFORE YOU LOOK AT THE FINDINGS.

Work out precisely which problem it answers. Not the general area it sits in. The specific
problem, the one a person would have to be feeling for that offer to be worth reading.

That problem is your target. Everything you write aims at it.

YOUR JOB IS THREE THINGS.

First, the observation: the thing you noticed about this specific person. You can see what
they posted, what they published, who they hired, where they spoke, what roles they have
held and when. Say one of those.

Second, the bridge: its own paragraph, naming the CONSEQUENCE that follows from the
observation above it, as a PATTERN that is typically true of firms in the situation you
just described. The consequence you name is the one that lands on the problem your target
is.

A CONSEQUENCE MAY BE AN ABSENCE. IT DOES NOT HAVE TO BE. Where something genuinely is
absent, naming it stays permitted, on the terms set out lower down. Where it is not, do
not manufacture one in order to have something to name. Nothing in these instructions
requires a bridge to find a gap, and an absence asserted against an observation that does
not support it is worse than no personalisation at all.

Third, the closing question. It goes where [YOUR CLOSING QUESTION GOES HERE] sits, after the offer
line. It is the obvious thing to ask THIS person once they have read the observation, the
bridge and the offer line above it. One question, ending in a question mark. Low
commitment and easy to answer. No meeting request, no calendar link, no "worth a call".

WRITE THE CLOSING QUESTION. DO NOT PICK ONE.

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

And no two prospects in this batch may get the same closing question. If you are told your
question is already taken, do not reword it slightly. Ask about a different aspect of the
problem.

THE QUESTION MUST ASK ABOUT THE PROBLEM YOU JUST NAMED. This is where a fixed question
used to go wrong, and the failure is worth reading:

FAILING, three rewrites running:
  bridge: "The product side builds an audience of browsers before it builds a pipeline of
   buyers."
  question it ran into: "Is getting more conversations in front of you something you're
   working on?"
The bridge diagnoses her correctly: she has an audience, and the wrong kind. Then the
question asks whether she wants MORE conversations. She does not want more. She wants
different ones. The email diagnoses her and then asks about somebody else's problem.

CORRECTED, same bridge, asking about what was actually named:
  "Is turning browsers into the right kind of buyer something you're working on?"
Same register, same length, and now it asks about the problem the email just described.

THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT.

This is the rule that matters most and the one most easily broken. You can see what they
did. You cannot see their pipeline, their calendar, their marketing results, or whether
any of it is working. Writing as though you can is presumptuous, it is frequently wrong,
and anyone who reads a wrong claim about their own business stops reading.

So the bridge may say what is TYPICALLY true of firms in this position. It may never say
what IS true of this prospect's pipeline, diary, marketing or results.

And never tell them something they are doing is not working. Their network, their events,
their content, their brand may all be working perfectly. You have no way of knowing, and
that is precisely the sentence that earns a defensive reply instead of a meeting.

VERDICT, and this one is not just presumptuous but wrong:
  observation: "The hiring post for a new delivery role says the client load is real and
   growing."
  bridge: "What a Chamber event and a strong network cannot do is put Blue Sky in front of
   the right buyers before the new delivery hire is already busy."
A chamber event and a strong network is exactly how a great many consultancies fill
capacity. We told him the thing that works does not work.

PATTERN, corrected, and deliberately about a PRINT SHOP:
  observation: "You added a second large-format press in March."
  bridge: "Your existing customers filled the first press. The second press needs work that
   has not been quoted yet."
Nothing here claims anyone's network has failed. It states what is true and stops, and it
leaves the reader to decide whether it is happening to them.

The corrected version used to be about a hire and a network, written from a real prospect's
observation. A prospect in the next batch returned it almost word for word, which is the
seventh time an example in this prompt has been copied. Presses and quotes belong to nobody
in your batch, so the words cannot travel. Take the move.

VERDICT again, invented outright:
  "Eleven years in, a firm that size fills its diary through relationships, and
   relationships only reach so far."
We have no idea how Taffet fills its diary. We made it up and then built on it.

NEVER TELL THE READER WHAT PEOPLE LIKE THEM THINK.

What is TYPICALLY true of firms in this position, permitted above, means a SITUATION. It
does not extend to what people in that position assume, believe, realise, discover or
find. A sentence of that kind is a verdict on the reader wearing the clothes of a claim
about a category: it tells them what is in their own head, and it claims a sample you do
not have. Naming a larger population makes it worse, not softer.

Say what happens to a firm in that position instead. A situation can be recognised or
waved away. A belief put in their mouth can only be argued with.

THE BRIDGE STATES ONE TRUE THING. IT NEVER EXPLAINS WHY.

The observations are finished. Every remaining problem in these emails is in the bridge, and
they all have one cause: the bridge EXPLAINS when it should STATE.

WORKS, and both of these say one true thing and then stop:
  "The founders who need you next are not reading your feed yet."
  "The next qualified sales conversation tends to wait for the next event."

FAILS, and all three are causal constructions the reader has to assemble before they can
agree with anything:
  "When delivery runs first for 13 months, that tends to be what stays visible."
  "The weeks after the last event, before the next event is on the calendar, are where the
   pipeline has to run on something else."
  "the follow-up after a public appearance rarely gets its own slot."

NO CAUSAL CONSTRUCTIONS. No "when X, that tends to be Y". No "because". No condition the
reader has to hold in their head while they resolve the consequence. Say the consequence
flat, in a sentence of its own.

TWO SHORT SENTENCES BEAT ONE CONDITIONAL. State the fact. Then state what follows. Each one
stands on its own and neither needs the other to be understood.

DO NOT BUILD A CAUSAL CHAIN BACK TO THE OBSERVATION. The observation is sitting directly
above the bridge, and the reader joins them without any help from you. Explaining the join
is what produces the sentences nobody can parse.

NEVER POINT BACK. NAME THE THING AGAIN.

This is not the rule above wearing different words, and reading it as one is why the fault
keeps shipping. The rule above is about sentence LENGTH and causal shape. This one is about
REFERENCE, and a short sentence breaks it exactly as easily as a long one.

NO SENTENCE MAY DEPEND ON THE READER CARRYING A REFERENCE BACK FROM A PREVIOUS SENTENCE. If
the subject was named above, NAME IT AGAIN. Do not point at it.

Pointing is any word standing in for something already named instead of naming it: a
demonstrative binding a noun, a bare pronoun, and "one" or "ones" used in place of the thing
itself. All three ask the reader to hold the earlier sentence in their head and resolve a
pointer against it before your sentence means anything. At the speed this is read, they will
not do it. They will skim the sentence, get nothing from it, and move on.

A MISSING VERB IS A POINTER TOO. "does not", "is not", "never does", with the verb itself
left out, sends the reader back to the previous sentence to fetch it. It is the same fault
as a pronoun and it is harder to see, because nothing in the sentence looks like a pointer.
Say the verb again.

AND A NOUN PHRASE POINTS WITHOUT ANY DEMONSTRATIVE IN IT. "whichever one", "each one", "the
next one", "the last one", "the opening", "the feed". Every one of them stands in for
something named in an earlier sentence. If the reader has to work out WHICH one, or WHOSE
feed, or WHAT opening, you have pointed at it rather than named it.

The cost of naming it again is one or two words. The cost of pointing is the whole sentence.

THIS APPLIES INSIDE THE BRIDGE, not only between the observation and the bridge. Your second
sentence pointing back at your own first sentence is the same fault and is the more common
half of it.

THE TEST, AND IT IS MECHANICAL. Cover every sentence above the one you are reading. Does
that sentence still say who and what it is about? If a word in it now has nothing to attach
to, that word is a pointer. Put the thing itself there instead.

NO EXAMPLE IS GIVEN, AND THE ABSENCE IS DELIBERATE. The shapes are named above, naming them
is the whole instruction, and a worked example here would be a ready-made sentence to copy.

READ THE OBSERVATION AND THE BRIDGE TOGETHER BEFORE YOU RETURN THEM. THEY MUST NOT
CONTRADICT EACH OTHER. This shipped:
  observation: his LinkedIn posts for the last 60 days are all external regulatory news.
  bridge: "When delivery runs first for 13 months, that tends to be what stays visible."
The observation says his feed is regulatory news. The bridge says what stays visible is
delivery. Both cannot be true, and the reader is the one who notices.

DO NOT ASSUME THEY HAVE NOBODY.
This shipped: "With three active CEO roles, the follow-up after a public appearance rarely
gets its own slot." It assumes that because he holds three roles, nobody is doing the
follow-up. He probably has people. Claiming to know their CAPACITY, or what their team is
and is not getting to, is the same error as claiming to know their pipeline. Say what tends
to happen. Never say who is or is not doing it.

THE ABSENCE BAN. IT COVERS THE OBSERVATION AND THE BRIDGE, BOTH.

"Opening" in these instructions means the observation and the bridge together. This ban is
written about the opening, so it governs BOTH paragraphs. A bridge names what they lack
just as easily as an observation does, and nothing here exempts it.

NEVER NAME WHAT THEY LACK. No "there is no", no "nothing about", no "with no case
studies", no lists of what is missing from their site or their feed. A senior seller does
not tell the reader their website is thin. Notice something that IS there instead.

WHAT THE BAN IS ACTUALLY ABOUT. It is not a ban on absence, and reading it as one is what
drives bridges back to the generic. The fault is DELIVERING A VERDICT ON THE READER.

An absence stated as a fact about a THING is permitted. An absence that implies a
conclusion about their JUDGEMENT is not.

The same is true of something PRESENT. A sentence about what they do post, who they did
hire or where they did speak carries a verdict just as readily. Being built on something
visible exempts nothing.

SO, IN ONE LINE: the bridge states a consequence, never a judgement, whether it is built on
something present or something absent.

THE BAN COVERS IMPLIED CHOICE.
This shipped: "When your feed points elsewhere, the people who might hire you do not know
HydrospherIQ exists."
That is not "you have no posts". It is "your posts are for somebody else's company", which
is worse, because it implies he chose that. Never tell the reader what they have decided
to put first.

THE CONSEQUENCE MUST NOT TURN THE OFFER LINE INTO A DIFFERENT JOB.

Go back to the offer line. Work out whether it promises to GENERATE new conversations or to
follow up on ones that already exist. If it generates, then the consequence you name must
not be one that only an audience they already have could answer. Naming a gap about an
audience they already have turns the offer line into an offer to chase their own followers,
which is a different job and not the one on the page.

This holds for any client whose offer line generates rather than follows up. It is not a
fact about one product, it is a fact about what the paragraph underneath your bridge says.

Never name a gap about converting, following up with, or re-engaging an audience they
already have.

FAILING: "The right buyers hear the talk on the day. Then the event ends, and most buyers do
 not follow up first."
The gap is the room that already saw him speak. Those people have met him.

FAILING: "A product shop builds an audience of people who browse. The founders ready to hire
 you rarely find you through the same door."
The gap is the audience she has already built. Worse, she probably launched the shop in
order to bring client work in, so this also tells her the thing she just built is not
working, which is banned above.

FAILING: "The founders who need you next are reading your feed already."
They are already reading it. There is no gap in that sentence at all.

WORKING: "The first clients in a new market usually come through people you already know.
 London is full of people who have never heard of you."
The gap is people who do not know her. Nobody has to be re-engaged for that to be true.

THIS RULE RULES ONE DESTINATION OUT. IT DOES NOT CHOOSE THE OTHER. It says where the
consequence may not land. It does not send every bridge to the same place regardless of
what you observed, and a consequence that satisfies it while not following from your
observation has still failed.

Where the observation shows visible activity, the consequence engages with that activity.
Concede what is plainly working, then name the specific thing that activity does not reach.
Never assert an absence of effort against evidence of effort.

NEVER ASSERT WHAT THE FINDINGS DO NOT EVIDENCE.

Never name a channel, a source of work, or a way of operating that the observation does not
evidence.

THAT LINE HAS BEEN HERE AND IT HAS NOT HELD, so it is stated at category level rather than
left as a coda to the rule above it.

ANY CLAIM ABOUT HOW THEIR WORK ARRIVES MUST BE TRACEABLE TO A FINDING. How they win clients,
where the work comes from, who sends it to them, how they get found. If the findings do not
say it, you do not know it, and the bridge may not imply it.

ANY CLAIM ABOUT WHAT THEY ARE OR ARE NOT DOING MUST BE TRACEABLE TO A FINDING. This is the
half that keeps failing, and it fails in one specific direction. A finding showing one kind
of activity is evidence of THAT ACTIVITY AND OF NOTHING ELSE. It is never evidence that
something else is absent. Seeing what somebody published tells you what they published. It
tells you nothing about what else they run, what their team runs, or what is already under
way somewhere you cannot see.

IMPLYING IT COUNTS AS ASSERTING IT. The sentence does not have to make the claim outright.
If the reader would have to accept an unevidenced claim about their own business for your
sentence to be true, your sentence makes that claim, and hedging the verb does not repair it.

THE TEST: point at the finding that makes your sentence true. Not the finding that makes it
plausible. The one that makes it TRUE. If you cannot put your finger on it, the sentence is
not yours to write, and the fix is a different sentence rather than a softer one.

If no consequence follows from an observation, that observation was the wrong one to choose.
Pick another finding.

NEVER ASSERT A TRACK RECORD. Do not claim a client relationship, a past engagement, a
delivered result, or a case study unless the approved documents you were given state it
outright. Anything not in those documents did not happen for the purposes of this email.
This is not a question of tone. A claim about work that was never done is the one thing
that cannot be walked back once the reader asks about it, and it is the sender who has to
answer, not you. An outcome you cannot point to in the documents is not yours to mention
at all.

THE BRIDGE MUST FOLLOW FROM ITS OWN OBSERVATION.

The bridge is about the same thing the observation named. Not a second, unrelated point that
happens to be true of the same person.

FAILING, and both halves are fine on their own:
  observation: two board seats in early 2026, on top of running the firm full time.
  bridge: "Your LinkedIn posts reach people who already respect the work."
Board seats and LinkedIn posts are two different subjects. The second paragraph does not
follow from the first, so the reader arrives at it wondering when the subject changed. If
the observation is board seats, the bridge is about what board commitments do to the week.

THE CHECK: read your two paragraphs in order and ask whether the bridge could sit under ANY
other observation. If it could, it is not following from yours. Rewrite it so it could only
sit under the one you wrote.

A SENTENCE STATES WHAT HAPPENS. IT DOES NOT GESTURE AT A CHANGE OF STATE.

FAILING: "Outreach for the new-business side sits until it does not."
"Until it does not" is a shape where a fact should be. Nothing is named: not when, not what
changes it, not what happens in the meantime. Say the thing that happens.

AND KEEP IT INSIDE THE BUDGET. The longest bridge in the last batch was 32 words and it was
also the one still explaining:
FAILING: "the advisory work fills the diary, and the question of who to go after next stays
 unresolved long after the call ends."
One sentence carrying a clause, a second clause and a trailing qualifier. Two sentences, each
standing on its own, and inside the bridge budget.

NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME.

"Firms that X often find Y" is one construction. It is not the only one, and it used to be
the shape of nearly every worked example on this page. Twelve prospects came back with
eleven bridges built on that frame, three of them close to word-identical. When every
bridge in a batch has the same skeleton the personalisation is decorative: two recipients
comparing notes see one template with the nouns swapped.

So your bridge must not share a sentence shape with another prospect in this batch. Vary
the CONSTRUCTION, not just the nouns.

EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY TO YOUR PROSPECT'S, DELIBERATELY. THE
SHAPE IS WHAT TRANSFERS. EVERY WORD IN THEM IS UNUSABLE HERE, because a sentence about
scaffolding or wedding albums pasted into this email is obviously wrong on sight. That is
the point: the last two batches lifted the examples almost verbatim and the batch gate
threw the attempts away. Read them for structure and then write your own sentence out of
your own prospect's facts.

  A CONDITIONAL. Puts their own situation on the left of the sentence.
    A dentist: "When the chairs are full six weeks out, nobody is phoning the patients who
     missed a check-up."

  WHAT USUALLY HAPPENS NEXT. Plain sequence, no hedging verb at all.
    A commercial builder: "A big site keeps the crews busy for a year. The tenders for the
     next site get written in the last month, if at all."

  A CONTRAST. Two short clauses, the second overturning the first.
    A freight broker: "Peak season fills the trucks without a single sales call. February
     fills nothing, and by February nobody has spoken to a new shipper since October."

  A CONSEQUENCE. States the position their situation puts them in.
    A wedding photographer: "The wedding season books out your summer. The enquiries for
     next spring arrive while you are editing somebody else's album."

There are more shapes than these four: a short concession, a plain statement of what the
situation costs, a comparison between the two halves of the same week. The point is that
you choose the shape AFTER you know the observation, instead of reaching for the same one
every time.

The bridge is NEVER a question. The email gets exactly one question mark and it is the
closing question, because the CTA is the question and a second one splits the ask. This is
a house rule, enforced in code, and an opening carrying its own question mark is rejected
before anyone reads it.

PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC.

The pattern must be one that only applies because of what you just observed. This is the
harder half of the job.

  Generic, and therefore useless: "Most firms at this stage find pipeline slips."
It is safe and it says nothing. The approved paragraph further
down the email already makes that point, so you have added a line and no information.

THE TEST: read your bridge on its own, without the observation above it. If it still makes
sense as a standalone sentence, it is generic and it has failed. A good bridge reads as a
non-sequitur without its observation, because it depends on it entirely.

ONE FACT PER SENTENCE.

This is about STRUCTURE, not length. A short sentence carrying three facts is still a
second read.

If you are naming two things, use two sentences. Do not join facts with appositives. Do
not bury a list mid-sentence. Never separate a subject from its verb with clauses. Your
reader is scanning between meetings, and a sentence they go back over has already lost.

The old version of this line asked for something an eleven year old could read. It was here
for two batches and it stopped nothing, because a reading age measures how hard the WORDS
are and the problem is figurative language. "Hours shrink before they grow" is eight easy
words and it describes nothing. The test that catches that is the camera test, below.

CRAMPED, and both of these shipped:
  "The regulatory commentary. DTCC tokenization, Treasury clearing, SEC crypto posture,
   shows where the thinking is."
A fragment, then a list, then a verb whose subject is three clauses back. By the time you
reach "shows" you have forgotten what is doing the showing.

CLEAN, same facts, nothing lost:
  "Taffet publishes regulatory commentary regularly. Recent pieces covered DTCC
   tokenization, Treasury clearing and the SEC's crypto posture. The commentary shows where
   your thinking is."
Three sentences. Each one carries a single idea and every subject sits next to its verb.

CRAMPED:
  "Two new board seats in early 2026. Hollywood Food Coalition and Sovern LA, on top of
   running SCG full-time is a real load."
The same fault. An appositive list swallows the subject, so "is a real load" arrives with
nothing attached to it.

CLEAN:
  "You took two board seats in early 2026, at Hollywood Food Coalition and Sovern LA. Both
   seats sit on top of running SCG full time."
Two sentences. The naming sits inside a clean subject and verb rather than replacing one.

Note what did NOT change in either rewrite. Same facts, same specificity, same length
roughly. Only the joins moved.

EVERY SENTENCE MUST BE CLEAR ON ONE READING.

You are writing to someone scanning their inbox between meetings. A sentence they have to
go back over has already lost.

FAILING on clarity, and note this one is correctly pattern-framed, so getting the stance
right is not enough:
  "A quiet month tends to be when the next engagement goes uncontested to whoever stayed
   visible."
The idea is sound and the reader has to assemble it. Who is uncontested, what contest,
visible to whom. Say it plainly: "A quiet month is usually when the next piece of work goes
to whoever stayed in front of the people who might hire."

DIGESTIBILITY. THIS IS WHAT MAKES A SENTENCE NEED A SECOND PASS.

Sentence structure is now fixed and the sentences are still heavy. The problem is not
length. It is LOAD BEFORE RESOLUTION: how much a reader has to hold in their head before a
sentence resolves. A short sentence can be heavy and a longer one can be effortless. Two
rules fix it.

ONE RELATIVE CLAUSE PER SENTENCE. Count your "that", "which", "who" and "where". One is
fine. Two means rewrite it. One nested inside another is never acceptable.

GET TO THE VERB EARLY. Keep the subject short, roughly four words before the main verb. A
long qualified noun phrase sitting in front of the verb is the single thing that forces a
second pass: the reader has to carry all of it until the verb finally says what it is
doing.

HARD:
  "The pipeline at firms that rely on the conference appearances that bring in new
   conversations moves in cycles that follow the conference calendar rather than delivery
   demand."
Fifteen words before the verb. Three relative clauses, one nested inside another. Every
word of it is true and nobody reads it once.

EASY:
  "The first clients come quickly at a firm that moves that fast, and the pipeline behind
   them takes longer to build."
Barely shorter. A three-word subject, one relative clause, nothing nested.

The hard one again, same facts, written to be read once:
  "Conferences deliver in bursts. The pipeline tends to follow the event calendar, so the
   months in between run quieter."
Nothing was dropped and nothing was softened. The reader is simply never asked to hold
more than one idea at a time.

CONCRETE NOUNS ONLY. THIS IS THE ONE THAT DECIDES WHETHER THEY RECOGNISE THEMSELVES.

Structure is fixed and the bridges still read as abstract, which means the reader has to
translate your sentence into their own week before they can tell whether it is about them.
Most people will not do that work in an inbox. They will skim it and move on.

NEVER USE THESE NOUNS: remainder, engine, momentum, capacity, bandwidth, cadence, motion,
flow. Every one of them is a placeholder standing where a real thing belongs.

Load and output are judgement calls, not bans. Attached to something concrete they are
fine: "a real operational load" works. As a bare subject they are not: "that output shows
where your thinking is" leaves the reader wondering what output.

NO METAPHORS. A metaphor is a picture the reader has to unpack before they get the point.
Say the thing instead. If you find yourself reaching for a machine, a current, an engine or
a runway, you have stopped describing their week and started decorating it.

ABSTRACT, and this shipped:
  "A day job and active delivery leave the sales pipeline running on whatever is
   left. The remainder tends to shrink before it grows."
Nobody can picture a remainder.

CONCRETE, same idea:
  "A day job and delivery both come first. Outreach gets the hours that are left, and
   there are fewer of those every week."
Hours. A reader knows exactly how many of those they had last week.

ABSTRACT, also shipped:
  "The regions that come after tend to need a different engine."
A metaphor doing work a plain sentence should do. Which regions, and what engine.

CONCRETE, same idea:
  "The first two markets were built on people you already knew. In the UK you do not know
   anyone yet, and the introductions have to start from nothing."
Same claim, and now it names the country, the people and what is missing.

CONCRETE, already working, and this is the standard:
  "Delivery has a deadline. Business development has no deadline, so it waits."
Deadline. Waits. Two things anyone can see happening in their own calendar.

THE CAMERA TEST. RUN IT ON EVERY SENTENCE, AND TWICE ON THE LAST FEW WORDS OF THE BRIDGE.

Point a camera at their week. Would you see the thing you just described happening?

  "Hours shrink before they grow" is unfilmable. Nobody can photograph an hour shrinking.
  "Delivery has a deadline. Business development has no deadline, so it waits" is filmable: a
  calendar with a date on it, and something pushed to next week.

Every noun is concrete now and the abstraction moved into the verbs and the endings. That is
where it hides, because a sentence can be built entirely out of real things and still
describe nothing that happens.

PLAIN VERBS. The verb must be something a PERSON DOES or something that PLAINLY HAPPENS.
  Use: waits. stops. gets skipped. goes to someone else. never gets made. sits there.
       nobody calls. you find out later.
  Not: moves. shrinks. becomes. converts. translates. materialises.
A person cannot become a conversation and an hour cannot shrink. If your subject is not
capable of doing the verb in the physical world, the sentence is a picture, not a fact.

FINISH ON A CONCRETE THING, NOT A CATEGORY. The last few words are what the reader is left
holding, and a category leaves them holding nothing.
  "goes to whoever was in the room last" beats "rather than from anything systematic".

Two of these shipped last week. Both have concrete nouns throughout and both fail:

FAILING: "Outreach for the new-business side gets whatever hours remain, and those tend to
 shrink before they grow."
Hours do not grow. Point the camera and there is nothing to film.
PLAIN: "Outreach gets whatever hours are left at the end of the day. Most weeks nobody makes
 the call."
Now you can film it: a day ending, and a person not making the call.

FAILING: "The founders who hear the talk and are ready to buy tend to need a nudge before
 they become a conversation."
People do not become conversations. "Need a nudge" is not something anyone does either.
PLAIN: "Some of the people who heard the talk are ready to buy. The ready buyers will not
 email you first."
An inbox with nothing in it. That is a thing you can point a camera at.

POINT EVERY SENTENCE AT THE PERSON.

The camera test fixed the ENDINGS and every bridge now films. It never reached the OPENINGS,
and the same fault is sitting in them untouched. Four from the last batch, all of which
shipped:

  "Every LinkedIn post in the last two months is Stanford GSB content or personal
   reflection."  The subject is a category and the verb is "is".
  "Two CEO roles means delivery answers first."  Delivery does not answer. Nobody answers.
  "Board dates are fixed and show up in the diary."  WHOSE diary.
  "Exhibitions fill the diary around their dates."  Exhibitions cannot fill anything, and
   "around their dates" is four words standing in for a whole sentence.

THE SUBJECT IS THEM, OR A THING THAT BELONGS TO THEM. "your posts". "your diary". "you
took". The stand they took at a show, with the show named from the findings rather than
left as "the stand". NOT a bare category: "every LinkedIn post", "board dates",
"exhibitions", "outreach". A category is nobody. The reader has to work out that you mean
them, and at the speed this gets read they will not bother.

SAY YOUR. If the thing is theirs, say so. "your diary", not "the diary". "your week", not
"the week". It costs one word and it removes every question about who is being described.
  FAILING: "Board dates are fixed and show up in the diary."
  PLAIN:   "You have board dates fixed months ahead, and they are already in your diary."

THE PLAIN-VERB RULE APPLIES TO THE SUBJECT AS WELL AS THE VERB. If the subject cannot
physically do the verb, rewrite it. Delivery cannot answer. Exhibitions cannot fill a diary.
A person can miss a call. A stand can close.

NO COMPRESSED PHRASE DOING A CLAUSE'S WORK. "around their dates" is a sentence folded into
four words, and the reader has to unfold it before they can agree with it. Say the sentence.

THE GLANCE TEST. It sits beside the camera test and replaces nothing.
Read it once, at speed, the way it will actually be read. The reader should think "yes, that
is true" and keep going. If they have to work out what you meant, even for a moment, it has
failed. The camera test asks whether it can be filmed. The glance test asks whether it lands
first time.

NAME THE THING EXACTLY. Never leave a noun the reader has to interpret.
"The next conversation" could be a catch-up, a supplier call or a chat at a stand. Say "the
next sales conversation". "New work" could be anything. Say "the next client". A word the
reader has to work out is a word that failed.
  CONVERSATION is the worst offender. It is in nearly every email in the last batch and it
  is never specified. Check every use you make of it and qualify it.

THE THREE WORKED PAIRS. Read these for the MOVE, not for the words.

FAILING: "Every LinkedIn post in the last two months is Stanford GSB content or personal
 reflection."
PLAIN:   "Your LinkedIn posts over the last two months have all been Stanford GSB content or
 personal reflection."
Same fact, impossible to misread. The subject became hers and the verb became something her
posts actually did.

FAILING: "Two CEO roles means delivery answers first."
PLAIN:   "You are CEO of two companies at once, so on Monday you work on the company that
 has a client waiting."
"Means" and "answers" both described nothing, and neither had a subject who could do them.
Now the subject is him and the verb is work, which is a thing you can watch him do.

FAILING: "Exhibitions fill the diary around their dates."
PLAIN:   "You get in front of the right buyers at CAVE. Then the show ends, and the next
 sales conversation waits for the next show."
Three fixes at once: the subject is him, the compressed phrase became the sentence it was
hiding, and "conversation" got qualified into "sales conversation".

THESE THREE ARE ABOUT STANFORD GSB, TWO CEO ROLES AND THE CAVE STAND. Those facts belong to
three specific people and to nobody else in your batch. Lifting a phrase from them into an
email about a different prospect is wrong on sight, and the uniqueness gate will throw the
whole attempt away. It has already happened five times: an earlier version of a plain
rewrite above ended "nobody gets to it", and two prospects in the same batch both ended on it.
Take the move. Write your own words from the findings in front of you.

THE AIM TEST, run it on every draft. Read your observation, your bridge, the offer line
and your question as one message. If the reader could answer that question with "that is
not quite my problem", either the bridge aimed at the wrong gap or the question asks about
something the bridge never raised. Rewrite whichever is wrong.

Here is that failure, from real output:

AIMED WRONG:
  observation: "The weekly inbound you're fielding from people wanting to collaborate says
   the brand is working."
  bridge: "The clients you actually want are a different current, and it doesn't run on
   the same word of mouth."
  the question it runs into: "Is getting more conversations in front of you something
   you're working on?"
The bridge says she already has plenty of conversations and the wrong ones. The question
asks whether she wants MORE. She does not want more. She wants different.

AIMED RIGHT, same observation, pattern-framed and pointed at what that question asks:
  bridge: "Collaborators find you first. The clients you want take longer, and they arrive
   by a different route."
Now she is short of the right conversations, which is what being asked about more
conversations answers. And it claims nothing about her results: it says what tends to
happen, not what is happening to her.

THE AIM TEST HAS A SECOND HALF, AND THE FIRST HALF CANNOT SEE IT.

Everything above checks the question against the BRIDGE. A question can pass that completely,
match the bridge exactly, and still ask about something THE OFFER LINE CANNOT DO. Reading the
bridge and the question together will never surface that, because both of them agree.

THE QUESTION MUST ASK ABOUT SOMETHING THE APPROVED OFFER LINE CAN ACTUALLY ANSWER.

Read the offer line again and work out what it does. Then read your question and ask whether
a yes to it is something that offer could act on. If the answer is no, the email has just
promised something it does not do.

That is the worst reply the email can earn. Not silence: interest, in the wrong thing. The
sender has to open by withdrawing what the question offered, and the prospect learns the
personalisation was aimed at a job nobody is selling.

IF THE BRIDGE NAMES A GAP THE OFFER CANNOT CLOSE, THE BRIDGE IS AIMED WRONG, AND SO IS THE
QUESTION THAT FOLLOWS FROM IT. Rewrite the bridge first. A question repaired on its own then
disagrees with the paragraph above it, which is the failure the first half of this test
catches.

SO RUN IT TWICE, EVERY DRAFT. Bridge against question. Then question against the offer line.
A draft that passes the first and fails the second is the most personal email in the batch,
asking for the wrong thing.

${FIRMOGRAPHIC_RULE_TEXT}

TWO MORE FAILURES WORTH KNOWING, both about who you are writing to:

FAILING:
  "Jason left Pani as Director of Product in July 2024 and launched HydrospherIQ three
   months later, with a current headcount of one."
Third person, about him rather than to him. A dossier entry. It leads nowhere.

FAILING:
  "You left Visteon at SVP level in December 2022. Your own firm has been the full focus
   since July 2023."
Second person and still wrong. It recites his own CV back at him. He knows all of it.

LENGTH. A BUDGET PER PART, NOT ONE TOTAL.

  observation   about ${OPENING_BUDGET.observation} words
  bridge        about ${OPENING_BUDGET.bridge} words
  closing question  about ${OPENING_BUDGET.question} words
                    ${OPENING_TARGET_WORDS} words in total

These are TARGETS. The HARD LIMIT is ${OPENING_MAX_WORDS} words for all three together, and
anything over it is rejected before a human sees it. Aim at ${OPENING_TARGET_WORDS} and you
will never meet the limit.

EACH PART HAS ITS OWN BUDGET AND CANNOT BORROW FROM ANOTHER. A 35-word observation paid for
by a 15-word bridge is not within budget, it is two parts wrong. The bridge is the part
carrying the reason to reply, so it is the worst possible place to economise.

Aim below the limit deliberately. Given one number to hit, the last four batches wrote past
it every time: told 62, they returned 70 and 75; told ${OPENING_MAX_WORDS}, they returned
74, 75, 77 and 78. Four prospects lost their personalised email to length alone, and each
had already been shown its exact word count and rewritten anyway. Write short first. It is
far easier to add a word than to find ten to cut.

CONSTRAINTS, and there are only four:
  At most five sentences across all three parts, inside the budget above.
  Write to them, as "you" or by naming their company. Never write their first name in the
  text: the email already greets them by name on the line above.
  Use only what is in the findings below. Invent nothing, and do not soften a fact into
  something the findings do not support.
  Do not pitch and do not name the service. The offer line does that.

THE SUBJECT LINE. YOU WRITE IT, AND YOU WRITE IT LAST.

Last, because it comes out of the observation. Until now it was written before anyone knew
what the observation would say, so it routinely named a framing the email then never
mentioned. The subject is the first thing they read, and a subject the first line does not
answer reads as a template, whatever the first line says.

So read your own observation back and name the thing it is about.

  It comes from your observation. Not from the offer line, not from a finding you did not use.
  All lower case.
  No full stop, no question mark and no exclamation mark at the end.
  Never their first name and never their company's name.
  At most ${EMAIL_SUBJECT_LIMITS.email1MaxChars} characters, spaces included.
  Nothing in it that is not in the findings, on the same terms as the observation.
  No figure from their record: no revenue, no headcount, no funding, no money amount.
  The same ban that applies to the body applies here, and harder, because the subject is
  read by everyone the email reaches, including everyone who never opens it.

A subject breaking any of those is thrown away and the client's approved subject ships in
its place. Nothing else about your answer is affected, so do not spend words defending it.

Return your answer as exactly four labelled blocks and nothing else, in this order:

OBSERVATION: <the thing you noticed, its own paragraph>
BRIDGE: <the pattern, its own paragraph>
QUESTION: <the closing question, ending in a question mark>
SUBJECT: <the subject line, on one line>`
}

// ─── The judge prompt ────────────────────────────────────────────────────────
//
// A CHOICE, NOT A GATE. The first version framed this as a gatekeeper with a free
// rejection: "HOLD costs nothing, when in doubt HOLD". An absolute bar plus a costless
// no means nothing ever passes, and nothing did, 0 of 13. CORPUS UNVERIFIED: "13" is
// almost certainly the 13-prospect run of 2026-08-25 that the cost and write-rate figures
// elsewhere are measured on, but no record ties this figure to that run, so the denominator
// is not established and is not asserted here. The DIRECTION is what this note is for and
// that does not depend on the count. It also started rejecting the
// client's own approved P3 as generic, which proved it was grading cold email as a
// category rather than doing the job in front of it.
//
// Now it compares two real, sendable drafts of the SAME email that differ only in their
// opening, and picks the one that gets a reply. Both are defensible, so it cannot opt
// out, and the approved P3 is common to both, so it cannot be the deciding factor.
//
// ONE QUESTION still. No checklist, no sub-scores.

// THE FLOOR, run on the personalised version ALONE, before any comparison.
//
// The comparison picks a winner, which means a flawed personalised email still ships
// whenever its template happens to be worse. Makesha's shipped claiming "the pipeline runs
// warm until the UK entity needs to feed it cold", asserting two things about her business
// nobody outside it could know. It beat its template and went out.
//
// So this runs first and can only disqualify. It is not a comparison and it has no
// opinion about quality: one question, about knowability.
export function buildFloorPrompt(): string {
  return `You are reviewing a cold email before it goes to a real person.

Does this email state something about the prospect's business that could not be known from
public information? Their pipeline, their diary, their results, whether their marketing
works.

Answer YES or NO, then one sentence.

YES means it claims private knowledge. NO means everything it asserts could be seen from
outside.

Reply in exactly this format:
CLAIMS_PRIVATE: NO
REASON: one sentence.`
}

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

/**
 * TAKES THE READER AS A PARAMETER, and this is the call that most needed it. The judge
 * decides whether the written opening ships or the approved template does, and it used to
 * decide by imagining one buyer archetype named in this literal. An opening pitched
 * correctly at a different reader could lose for no reason but that.
 *
 * INTERPOLATION IS FREE HERE, unlike in the writer prompt. This one is ~124 tokens, far
 * below the ~1,024-token minimum cacheable prefix, so it is deliberately sent uncached and
 * a per-prospect value costs nothing.
 *
 * The reader goes on its OWN LINE after a colon rather than inline as "a busy X". Real
 * buyer titles are free text and several are full clauses naming more than one role, and
 * an inline slot would render those as an unreadable sentence.
 */
/**
 * Which label the WRITTEN opening is given in the judge comparison.
 *
 * WAS Math.random(). The label has to vary, because a judge shown the written version
 * as A every time can be answering position rather than copy, and position bias in an
 * A/B comparison is real. But random varies it per CALL, which meant the same prospect
 * could be labelled A on one run and B on the next, and A on its first attempt and B on
 * its retry. That is a second source of run-to-run movement sitting underneath the
 * sampling temperature, and it does not disappear when temperature goes to 0.
 *
 * Derived from the prospect UUID instead: FNV-1a over the id, low bit picks the label.
 * Same prospect, same label, every run and every attempt. Across a batch the ids are
 * unrelated to each other, so the labels still split roughly evenly and the judge is
 * still not always reading the written version in the same position.
 */
export function writtenLabelFor(prospectId: string): 'A' | 'B' {
  let hash = 0x811c9dc5
  for (let i = 0; i < prospectId.length; i++) {
    hash ^= prospectId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 2 === 0 ? 'A' : 'B'
}

export function buildJudgePrompt(buyer: string): string {
  return `You are the head of sales. Two drafts of the same cold email are in front of you,
both written by your team, both ready to send. They differ only in how they open.

Who is reading it: ${buyer}

Both go out under your name. Which one could that person read once, at speed, without
going back over any sentence, and still find the closing question the obvious thing to ask
them?

Give the one sentence on why first, then answer A or B.

Reply in exactly this format:
REASON: one sentence.
CHOICE: A`
}

/** The two drafts, labelled and ordered for one comparison. */
export interface JudgeComparison {
  /** The opening the writer produced for this round. */
  opening: string
  /** The two halves of that opening. The bridge is what the uniqueness gate measured. */
  observation: string
  bridge: string
  /** The closing question the writer produced for this round. */
  question: string
  /** The floor verdict on this attempt, run before the comparison. */
  floor: FloorCheck
  /** Which label the WRITTEN version was given. Derived from the prospect id. */
  written_label: 'A' | 'B'
  /** The label the judge picked. */
  chosen_label: 'A' | 'B'
  /** True when the judge picked the written opening over the approved template. */
  written_won: boolean
  reason: string
}

// ─── Deterministic gates on the writer's output ──────────────────────────────
//
// NO COUNT IS STATED HERE, ON PURPOSE. This comment read "These three and no others"
// while sitting above eight gates, and the count has now been wrong twice. A number in a
// comment above a list is a second list to keep in step by hand, and it loses.
//
// What belongs here, at category level: checks on things a model must not be asked to
// self-report, because self-reporting them is the thing it is bad at. Budgets and counts
// it would have to measure. Facts it would have to remember not having invented. Fixed
// text it was told not to touch. House rules already enforced in code elsewhere, which
// are only advisory in a prompt (ADR-028). Everything requiring judgement stays with the
// judge, which is why nothing here reads for tone, interest or quality.
//
// Some gates run REPORT-ONLY behind a mode constant in their own module. Those log and
// return nothing, so they cannot reject anything until the constant is flipped by hand.

/** Numbers, years and proper nouns in the opening that do not appear in the findings. */
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
    // Strip the possessive before comparing: "SCG's" is the same claim as "SCG", and the
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

/** Words in one part. Same counting rule as the gate and the composition layer. */
function wordsIn(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * A length failure that names the part. Marks every part over its target so the rewrite
 * has somewhere specific to cut, and states both numbers so the writer can see that the
 * target and the hard cap are different things.
 */
function lengthFailureByPart(
  total: number,
  parts: { observation: string; bridge: string; question: string },
): string {
  const rows = [
    { name: 'observation', words: wordsIn(parts.observation), target: OPENING_BUDGET.observation },
    { name: 'bridge',      words: wordsIn(parts.bridge),      target: OPENING_BUDGET.bridge },
    { name: 'question',    words: wordsIn(parts.question),    target: OPENING_BUDGET.question },
  ]

  const detail = rows
    .map(r => `${r.name} ${r.words} (target ${r.target}${r.words > r.target ? `, OVER by ${r.words - r.target}` : ''})`)
    .join(', ')

  const over = rows.filter(r => r.words > r.target).map(r => r.name)
  const instruction = over.length > 0
    ? `Cut the ${over.join(' and the ')}. Do not pay for it out of another part.`
    : 'Every part is inside its target, so shorten whichever reads longest.'

  return `the whole block is ${total} words against a hard cap of ${OPENING_MAX_WORDS} and a target of ${OPENING_TARGET_WORDS}: ${detail}. ${instruction}`
}

/** Lowercased, punctuation-stripped, single-spaced. For comparing prose to prose. */
function normaliseForEcho(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

export function checkOpeningGates(
  opening: string,
  prospectFirstName: string | null,
  findingsText: string,
  /**
   * The variant's approved P3. Supplied so the writer cannot hand back a block that
   * already contains it. Optional only so existing single-purpose callers and tests need
   * not thread it through; production always passes it.
   */
  approvedP3?: string,
  /**
   * The three parts, for the length message only. Optional so single-purpose callers and
   * tests can pass the combined block alone; production always supplies them, because the
   * whole point of the per-part budget is that a length failure names the part.
   */
  params?: { observation: string; bridge: string; question: string },
  /**
   * For the sentence-initial log line only. Optional so existing single-purpose callers
   * and tests need not thread it through; production always passes it.
   */
  context?: { prospectId: string },
): string[] {
  const failures: string[] = []

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

  if (prospectFirstName && prospectFirstName.trim().length > 1) {
    const re = new RegExp(`\\b${prospectFirstName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(opening)) {
      failures.push(`opening names the prospect ("${prospectFirstName}"), which reads as third person: the greeting above already names them`)
    }
  }

  const untraceable = untraceableClaims(opening, findingsText)
  if (untraceable.length > 0) {
    failures.push(`claims not traceable to any finding: ${untraceable.join(', ')}`)
  }

  // CLOSES A HOLE IN THE TRACEABILITY GATE ABOVE RATHER THAN ADDING A NEW RULE.
  //
  // untraceableClaims exempts the first word of every sentence, because capitalisation
  // there is convention rather than evidence. This gate runs on `${opening} ${question}`,
  // and the observation always ends in a full stop, so the bridge's first token is ALWAYS
  // in that exempt set. Twelve of the sixteen named entities in the writer prompt's own
  // worked examples leak straight through it. See sentence-initial-names.ts for the
  // measurement and for why the discriminator is a vocabulary rather than a denylist.
  //
  // REPORT-ONLY until SENTENCE_INITIAL_GATE_MODE is flipped by hand, so this returns an
  // empty array today and logs what it would have rejected.
  failures.push(...checkSentenceInitialNames(
    opening, findingsText, { prospectId: context?.prospectId ?? 'unknown' },
  ))

  // A DELIBERATE ADDITION. The brief said to keep the deterministic gates unchanged, and
  // this adds one, so the reasoning should be on the record. A prompt rule alone is
  // advisory (ADR-028) and the messaging agent enforces the same ban in code.
  //
  // The failure it prevents has already shipped: an opening that quoted a revenue figure
  // straight from the prospect's own record. Traceability cannot catch that, because the
  // figure really was in the findings. BEING IN THE FINDINGS IS WHAT MAKES IT DANGEROUS.
  // It reads as a database lookup rather than as something noticed, it may simply be
  // wrong, and a wrong number in the opening line is worse than a generic one. A revenue
  // band is a TARGETING instruction, never email content. Qualify the population by role,
  // stage or situation instead.
  const figures = findFirmographicFigures(opening)
  if (figures.length > 0) {
    failures.push(`quotes ${figures.join(' and ')} from the prospect's record: qualify by role, stage or situation instead`)
  }

  // THIS GATE EXISTS BECAUSE THE CHANGE SET THAT ADDED IT CREATED THE HOLE IT CLOSES.
  //
  // The standing house rule is one question mark per email body: the CTA is the question,
  // and a second one splits the ask. The messaging agent enforces it at generation, but
  // nothing enforced it on the research writer, which was fine while the writer produced a
  // statement and a question. Then the bridge got its own paragraph and the prompt started
  // listing sentence shapes to vary, one of which was a question. A question-shaped bridge
  // gives the email two, and composition then appends a full stop after the '?' because it
  // tests for a terminal period, so the prospect reads "...after that hire?.".
  //
  // Gated at MORE THAN ONE rather than EXACTLY ONE: this runs on the combined block, and a
  // missing question is already reported by its own check with a clearer message.
  const questionMarks = (opening.match(/\?/g) ?? []).length
  if (questionMarks > 1) {
    failures.push(`contains ${questionMarks} question marks: the closing question is the only question, and the observation and bridge must not ask one`)
  }

  // THIS ONE SHIPPED BEFORE IT WAS CAUGHT. The Email 1 that prompted it read:
  //
  //   "Two leadership positions running in parallel means prospecting is usually the first
  //    thing that waits. We get qualified conversations into the diary without pulling you
  //    out of delivery.
  //
  //    We get qualified conversations into the diary without pulling you out of delivery."
  //
  // The writer put the approved offer line inside its own BRIDGE block, and composition
  // then added the real one underneath, so the same sentence appeared twice in a row. The
  // prompt has always said the offer line is fixed and not the writer's to touch, which is
  // exactly why this needs a gate: the instruction was already there and was ignored.
  //
  // Matched on the first six words rather than the whole line, so a truncated echo is
  // caught too: "We get qualified conversations into the diary." stops one word short of an
  // eight-word needle and would have slipped through. Six consecutive words of the client's
  // own offer line is not something a bridge arrives at by chance.
  if (approvedP3) {
    const p3Words = normaliseForEcho(approvedP3).split(' ').filter(Boolean)
    const needle = p3Words.slice(0, 6).join(' ')
    if (p3Words.length >= 6 && normaliseForEcho(opening).includes(needle)) {
      failures.push('repeats the approved offer line, which is already in the email: write only the observation, the bridge and the closing question')
    }
  }

  // ── Report-only observation, per part. Neither of the two checks below can reject
  // anything on this commit: the finite-verb gate returns an empty array while its mode
  // constant says 'report', and the readability score is logged and never read.
  //
  // PER PART, NOT ON THE COMBINED BLOCK. Every gate above runs on `opening`, which is the
  // observation, the bridge and the question joined together. That is right for a word cap
  // and wrong for these two, because a hit on the joined string cannot say which half
  // produced it, and the whole value of an observation period is knowing what was caught
  // and where. Reading a log that says "the opening had a fragment in it" tells nobody
  // which paragraph to look at.
  //
  // Guarded on `params` because it is optional: tests call this function with the parts
  // undefined, and with nothing to attribute a hit to there is nothing worth logging.
  if (params) {
    // POINTING BACK INSTEAD OF NAMING THE THING AGAIN. Report-only on this commit: the
    // function returns an empty array while OPENING_REFERENCE_MODE says 'report', and logs
    // every hit with the prospect, the part and the sentence.
    //
    // RUN ON THE PARTS AND NOT ON `opening`, for the reason the block below already gives
    // and for a second one specific to this check. The parts are what the detector's
    // paragraph model needs: the observation and the bridge are two paragraphs with a
    // known order, and joinOpening has already flattened that ordering away by the time
    // `opening` exists.
    //
    // NOT GATED, ON A MEASUREMENT RATHER THAN ON CAUTION. Replayed over 44 real openings it
    // would reject 21 of them, three wrongly. See opening-reference.ts for the numbers, the
    // three false-positive sentences, and what has to be true before this can block.
    failures.push(...checkOpeningReferences(
      params.observation, params.bridge, { prospectId: context?.prospectId ?? 'unknown' },
    ))

    for (const [part, text] of [['observation', params.observation], ['bridge', params.bridge]] as const) {
      // Named logContext, not context: a local called `context` would shadow the
      // parameter it is built from and never initialise.
      const logContext = { prospectId: context?.prospectId ?? 'unknown', part }
      failures.push(...checkFiniteVerbs(text, logContext))

      // LOG ONLY, PUSHING NOTHING. readabilityScore already gates candidate SELECTION
      // upstream, where a hard fail ranks a candidate out. Nothing has ever scored the
      // writer's own output, so there is no evidence about what it would reject here, and
      // adding a hard gate without that evidence is how a good variant gets thrown away.
      // Accumulate first, decide later.
      const readability = readabilityScore(text)
      logger.info('writer-readability: scored, not gated', {
        ...logContext,
        hardFail: readability.hardFail,
        penalty: readability.penalty,
        reasons: readability.reasons,
        hedges: readability.hedges,
      })
    }
  }

  return failures
}

/**
 * The subject gate. EVERY CHECK IN IT FAILS SOFT.
 *
 * WHY THIS IS NOT INSIDE checkOpeningGates, having been asked for there. That function's
 * return value IS the hard-failure channel: writeOnce pushes it into `gates`, a non-empty
 * `gates` ends the attempt, and the attempt loop then spends one of two or three tries on
 * a rewrite. Putting a subject failure into that array would buy a new subject with a
 * retry that the BODY needed, and an exhausted attempt ships the approved template, which
 * is worse copy than any subject this could reject. So the checks live here, beside the
 * gates and sharing their traceability helper, and the caller keeps them off that channel.
 *
 * A non-empty return means DISCARD THE SUBJECT, not fail the attempt.
 *
 * Each check, and why it earns its place. NO COUNT IS STATED, for the reason given above
 * checkOpeningGates: this line read "The three" while the list below it held four.
 *   traceability  a name invented in the subject is worse than one invented in the body.
 *                 It is the line every recipient reads, including the ones who read
 *                 nothing else.
 *   length        the same cap the messaging agent enforces on an authored subject. A
 *                 subject truncated by the mail client is a subject that says something
 *                 other than what was written.
 *   no question   the body is allowed exactly one question mark and the CTA is it. A
 *                 subject that asks one spends the email's only question before the
 *                 reader has reached the ask.
 *   firmographics  a revenue band, a headcount or a funding figure. The messaging agent
 *                 applies this ban to email BODIES and has never applied it to a subject
 *                 line, which was harmless only while every subject was human-authored.
 *                 It stops being harmless the moment subjects are generated. The figure
 *                 is usually IN the findings, so traceability above cannot catch it:
 *                 being in the findings is what makes it dangerous. It reads as a
 *                 database lookup, it may be wrong, and a wrong number is worse in the
 *                 subject than anywhere else because it is read by everyone who is
 *                 shown the email, including those who never open it.
 */
export function checkSubjectGates(subject: string, findingsText: string): string[] {
  const failures: string[] = []
  const text = subject.trim()
  if (!text) return failures

  const untraceable = untraceableClaims(text, findingsText)
  if (untraceable.length > 0) {
    failures.push(`subject claims not traceable to any finding: ${untraceable.join(', ')}`)
  }

  if (text.length > EMAIL_SUBJECT_LIMITS.email1MaxChars) {
    failures.push(`subject is ${text.length} characters, cap is ${EMAIL_SUBJECT_LIMITS.email1MaxChars}`)
  }

  if (text.includes('?')) {
    failures.push('subject asks a question: the closing question is the email\'s only question')
  }

  // The SAME array, therefore the same soft-fail path as the three above by construction:
  // there is no second channel a firmographic hit could take, and no way to add one
  // without editing the single `return` below.
  const figures = findFirmographicFigures(text)
  if (figures.length > 0) {
    failures.push(`subject quotes ${figures.join(' and ')} from the prospect's record: qualify by role, stage or situation instead`)
  }

  return failures
}

// ─── Findings block ──────────────────────────────────────────────────────────

/** Ranked findings with provenance. Ranking is what the six tests are now for. */
export function buildFindingsBlock(candidates: ObservationCandidate[]): string {
  const ranked = [...candidates].sort((a, b) => b.score_total - a.score_total)
  if (ranked.length === 0) return 'No findings.'
  return ranked
    .map((c, i) => `${i + 1}. ${c.observation}\n   source: ${c.source} | ${c.provenance || 'no provenance'}`)
    .join('\n')
}

// ─── Model calls ─────────────────────────────────────────────────────────────

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
async function callModel(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  context: string,
  cacheSystem = false,
): Promise<{ text: string; usage: TokenUsage }> {
  try {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: MODEL_TEMPERATURE,
      // DEFAULT 5-MINUTE TTL, matching synthesize.ts. A 1-hour TTL was tried and reverted
      // on 2026-08-26: it doubles the write cost and only pays above ~7 reads per write,
      // against a measured 4.14. The full arithmetic and the condition for revisiting are
      // written out once at the synthesis call site rather than duplicated here.
      //
      // Only the WRITER passes cacheSystem. The floor judge and judge are ~124 tokens
      // each, far below Sonnet's 1,024-token minimum cacheable prefix, so a breakpoint on
      // them would be silently ignored while consuming one of the four allowed per request.
      system: cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system,
      messages: [{ role: 'user', content: user }],
    })
    const usage = readTokenUsage(res.usage)
    // RETURNED, not just logged. A debug line cannot be read back in production, because
    // debug is off there, and it cannot be summed per prospect. Both are needed: the log
    // for a live tail, the return value for spend_detail.
    logger.debug('research/write-opening: model call usage', { context, ...usage })
    const block = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    return { text: block?.text?.trim() ?? '', usage }
  } catch (err) {
    throwIfFatal(err, context)
    throw err
  }
}

/**
 * Reads the judge's pick. An unreadable reply resolves to the TEMPLATE, never to the
 * written opening, so an ambiguous answer can only ever fall back to approved copy.
 */
/*
 * ORDER-INDEPENDENT, AND CHECKED AGAINST THE PROMPT RATHER THAN ASSUMED.
 * buildJudgePrompt now asks for REASON before CHOICE. The reason match runs to the end
 * of the string and then keeps the first line, so it stops before a CHOICE line that
 * follows it; the choice match is anchored on its own label and does not care where it
 * sits. Both orders are covered by tests, because the prompt is the thing most likely to
 * be edited back.
 */
export function parseChoice(raw: string, writtenLabel: 'A' | 'B'): {
  chosen: 'A' | 'B'
  written_won: boolean
  reason: string
} {
  const match = raw.match(/CHOICE:\s*([AB])\b/i)
  const reasonMatch = raw.match(/REASON:\s*([\s\S]+)/i)
  const templateLabel: 'A' | 'B' = writtenLabel === 'A' ? 'B' : 'A'
  const chosen: 'A' | 'B' = match ? (match[1].toUpperCase() as 'A' | 'B') : templateLabel
  const reason = (reasonMatch?.[1] ?? raw).trim().split('\n')[0].trim()
  return {
    chosen,
    written_won: chosen === writtenLabel,
    reason: reason || 'No reasoning returned.',
  }
}

/** Strips quotes or a stray preamble the writer may wrap around the opening. */
function cleanOpening(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^(opening|here is the opening|draft)\s*:\s*/i, '')
  if (/^["'“]/.test(text) && /["'”]$/.test(text)) text = text.slice(1, -1).trim()
  return text
}

/**
 * One writer attempt, reported as it finishes. PURE TELEMETRY: nothing here is read by
 * the loop, and a caller that omits `onAttempt` gets byte-identical behaviour.
 *
 * IT EXISTS BECAUSE `OpeningResult.gate_failures` CANNOT BE COUNTED. That field carries
 * the failures of the FINAL attempt, and only when that attempt was the one that gated.
 * An attempt gated on the first try and rescued on the second leaves no trace in it at
 * all, and a prospect whose last attempt lost on the judge reports an empty array however
 * many gates it tripped on the way. So a histogram built from that field is not a count of
 * gate failures, it is a count of prospects whose last attempt happened to be gated, and
 * the two are far apart. Measuring the gates needs every attempt, which is this.
 */
export interface AttemptObservation {
  /** Zero-based. Attempt 0 is the first write, so any value above 0 is a retry. */
  attempt: number
  /** How this attempt ended. Only 'gated' can carry deterministic gate failures. */
  kind: 'gated' | 'collided' | 'floored' | 'compared'
  /** The deterministic gates this attempt tripped. Empty for every other kind. */
  gate_failures: string[]

  // ─── THE TEXT ITSELF, ON EVERY ATTEMPT INCLUDING THE REJECTED ONES ─────────
  //
  // Added because the kind and the gate codes say an attempt failed and never say WHAT
  // failed. A rejected attempt's words lived only inside the loop and were overwritten by
  // the next one, so a prospect that fell back to template left a verdict with no text
  // behind it and its failure could not be read at all, only counted.
  //
  // These are the writer's output AFTER scrubAITells and after the parse, which is the
  // form that was actually judged. Reporting the raw reply instead would describe a
  // string no gate ever saw.
  /** The observation paragraph this attempt produced. Empty when the writer returned none. */
  observation: string
  /** The bridge paragraph this attempt produced. Empty when the writer returned none. */
  bridge: string
  /** The closing question this attempt produced. Empty when the writer returned none. */
  question: string
  /**
   * The subject that WOULD HAVE SHIPPED from this attempt. Empty means no subject ships
   * and the variant's authored one is used instead.
   *
   * Empty for two different reasons, which is why `subject_discarded` sits beside it: the
   * writer returned nothing, or it returned something that its own soft gate threw away.
   * A reader of an empty string alone cannot tell those apart, and that is the shape this
   * whole field set exists to stop.
   */
  subject: string
  /**
   * The subject the writer produced when the soft gate rejected it, else null. This is the
   * losing text the gate discarded, and it is discarded silently on the shipping path by
   * design: an unusable subject must not consume one of the two or three attempts.
   */
  subject_discarded: string | null

  // ─── THE JUDGE'S VERDICT, ON EVERY COMPARISON RATHER THAN THE LAST ─────────
  //
  // OpeningResult.judge_reasoning carries the FINAL comparison only. An attempt that lost
  // the comparison and was then rewritten had its verdict overwritten by the rewrite's,
  // so the reason the first version lost was unavailable however useful it was.
  /** The judge's sentence for THIS attempt's comparison. Null unless kind is 'compared'. */
  judge_reasoning: string | null
  /** Whether the written version beat the template HERE. Null unless kind is 'compared'. */
  judge_written_won: boolean | null
}

/**
 * The five pieces of text one attempt produced, plus the subject its own soft gate threw
 * away. Named once and shared by the attempt union inside the loop and by
 * AttemptObservation, so the reported text is BY CONSTRUCTION the text the loop held
 * rather than a second copy assembled at the emit and free to drift from it.
 */
export type AttemptText = Pick<
  AttemptObservation,
  'observation' | 'bridge' | 'question' | 'subject' | 'subject_discarded'
> & {
  /** The observation and the bridge joined, which is what composition ships. */
  opening: string
}

export interface WriteAndJudgeParams {
  apiKey: string
  clientName: string
  /**
   * Who is reading the email, already resolved by resolveBuyer at the single chokepoint
   * both paths share. Resolved by the CALLER rather than here so the precedence decision
   * and the log line naming which tier won live in one place.
   */
  buyer: string
  prospectFirstName: string | null
  candidates: ObservationCandidate[]
  p3: string
  cta: string
  /**
   * Builds the complete Email 1, subject line included. `question` and `subject` are both
   * optional so the TEMPLATE side of the comparison keeps its own approved CTA and its own
   * approved subject: both emails must be complete and genuinely sendable, or the
   * comparison is not honest.
   */
  composeEmail1: (opening: string, question?: string | null, subject?: string | null) => string
  /** The variant's own approved opening, the version the written one has to beat. */
  templateOpening: string
  prospectId: string
  /**
   * Batch-scoped uniqueness for the bridge and the closing question. Omit for a single
   * prospect run: with nothing else in the batch there is nothing to collide with, and a
   * per-prospect registry would only ever reserve against itself.
   */
  uniqueness?: BatchUniquenessRegistry
  /**
   * Called once per attempt, as each finishes. Observation only: the return value is
   * discarded and nothing in the loop branches on it, so omitting it changes nothing.
   * See AttemptObservation for why the returned gate_failures cannot serve this purpose.
   */
  onAttempt?: (observation: AttemptObservation) => void
}

/**
 * The trailing SUBJECT block, matched at the start of a line so it can be both READ and
 * REMOVED. Removal is what the unlabelled fallback below needs: that path treats whatever
 * it is given as prose, so without this the literal text "SUBJECT: ..." would be collapsed
 * into the observation and shipped as the first line of a real email.
 *
 * Anchored to a line start rather than matched anywhere, so a prospect's own prose
 * containing the word cannot truncate the reply.
 */
const SUBJECT_BLOCK = /(?:^|\n)[ \t]*SUBJECT:[\s\S]*$/i

/**
 * Splits the writer's four labelled blocks.
 *
 * The observation and the bridge are returned separately because they are now separate
 * paragraphs in the email AND because the bridge alone is what the batch-uniqueness gate
 * measures. `opening` is the two joined by a blank line, which is what gets stored and
 * composed: composition replaces the P2 slot with it verbatim, and a trigger containing
 * its own blank line becomes two paragraphs when the body is re-joined.
 *
 * `subject` is the Email 1 subject line, written from the observation the writer just
 * produced. It is the LAST block, and it is optional in the sense that an absent or
 * unusable one costs nothing: the caller falls back to the variant's authored subject.
 * Absent means empty string, never undefined, so no caller has to distinguish the two.
 *
 * EVERY BOUNDARY IS AN EXPLICIT LOOKAHEAD. QUESTION used to capture to end of string and
 * survived only because the next line took its first line via split. That is incidental
 * correctness: it would have broken silently the moment anything multi-line followed it,
 * which is exactly what SUBJECT now is on the malformed path.
 *
 * OPENING: is still accepted as a fallback label. A writer that returns the old two-block
 * format would otherwise lose its whole observation to the regex and ship a bridge on its
 * own, which reads as a generic line with no anchor.
 */
export function parseWriterOutput(raw: string): {
  observation: string
  bridge: string
  question: string
  subject: string
  opening: string
} {
  const obsMatch = raw.match(/OBSERVATION:\s*([\s\S]*?)(?=\n\s*(?:BRIDGE|QUESTION|SUBJECT):|$)/i)
  const bridgeMatch = raw.match(/BRIDGE:\s*([\s\S]*?)(?=\n\s*(?:QUESTION|SUBJECT):|$)/i)
  const legacyMatch = raw.match(/OPENING:\s*([\s\S]*?)(?=\n\s*(?:QUESTION|SUBJECT):|$)/i)
  const qMatch = raw.match(/QUESTION:\s*([\s\S]*?)(?=\n\s*SUBJECT:|$)/i)
  const subjectMatch = raw.match(/SUBJECT:\s*([\s\S]+)/i)

  const question = cleanOpening(qMatch?.[1] ?? '').split('\n')[0].trim()
  // One line, same treatment as the question. A subject is a single line by definition.
  const subject = cleanOpening(subjectMatch?.[1] ?? '').split('\n')[0].trim()

  // Preferred path: both labels present.
  if (obsMatch && bridgeMatch) {
    const observation = collapseParagraph(cleanOpening(obsMatch[1]))
    const bridge = collapseParagraph(cleanOpening(bridgeMatch[1]))
    return { observation, bridge, question, subject, opening: joinOpening(observation, bridge) }
  }

  // Fallback: the old single OPENING block, or an unlabelled reply. Split on the blank
  // line if the writer left one, otherwise treat the whole thing as the observation so
  // nothing is silently dropped. The bridge gate then sees an empty bridge and rejects,
  // which is the correct outcome: a malformed reply must not ship.
  //
  // The SUBJECT block is stripped FIRST. Only the `raw` branch can still be carrying it,
  // because the three labelled captures already stop at it, but the strip is applied to
  // the resolved string rather than to that one branch: it costs nothing and it cannot
  // then be missed if the branches are ever reordered. `subject` above was read from the
  // untouched `raw`, so stripping here loses nothing.
  const whole = cleanOpening(
    (legacyMatch?.[1] ?? obsMatch?.[1] ?? bridgeMatch?.[1] ?? raw).replace(SUBJECT_BLOCK, ''),
  )
  const parts = whole.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const observation = collapseParagraph(parts[0] ?? '')
  const bridge = collapseParagraph(parts.slice(1).join(' '))
  return { observation, bridge, question, subject, opening: joinOpening(observation, bridge) }
}

/** One paragraph on one logical line. Soft-wraps the model inserts are not paragraphs. */
function collapseParagraph(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/** The stored trigger: observation and bridge as two paragraphs. */
export function joinOpening(observation: string, bridge: string): string {
  return [observation.trim(), bridge.trim()].filter(Boolean).join('\n\n')
}

export async function writeAndJudgeOpening(params: WriteAndJudgeParams): Promise<OpeningResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const findings = buildFindingsBlock(params.candidates)
  // Constant across every prospect, variant and client, which is what makes it cacheable.
  // The parts that used to vary are in the assignment block, prepended to the user message.
  const writerSystem = buildWriterPrompt()
  const assignment = buildWriterAssignment({ clientName: params.clientName, buyer: params.buyer, p3: params.p3, cta: params.cta })

  // Accumulated across EVERY call this prospect makes, including the ones on attempts that
  // were thrown away. A retried prospect's real cost is the point of measuring at all, so
  // the counter has to sit outside the attempt loop.
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  const record = (u: TokenUsage) => { usage = addTokenUsage(usage, u) }
  const judgeSystem = buildJudgePrompt(params.buyer)
  const floorSystem = buildFloorPrompt()

  // The template keeps its OWN approved CTA. Passing no question is what makes that true.
  const templateEmail = params.composeEmail1(params.templateOpening, null)

  const writeOnce = async (feedback: string | null): Promise<AttemptText & { gates: string[] }> => {
    // The questions already gone in this batch, listed rather than implied. Shown on every
    // retry, not just a collision retry: the writer that is rewriting for length is equally
    // capable of walking into a taken question on the way past.
    const taken = params.uniqueness?.takenQuestions(params.prospectId) ?? []
    const takenBlock = taken.length > 0
      ? `\n\n## Closing questions already taken in this batch\n\nDo not use any of these, and do not reword one slightly:\n${taken.map(q => `- ${q}`).join('\n')}`
      : ''

    // Assignment first: the prompt instructs the writer to read the offer line BEFORE the
    // findings, so it has to physically precede them.
    const user = feedback
      ? `${assignment}\n\n## Findings\n\n${findings}${takenBlock}\n\n## Your previous attempt did not ship\n\nYou wrote:\n${feedback.split('|||')[0]}\n\nThe reason:\n${feedback.split('|||')[1]}\n\nWrite a different version that answers that. Return ONLY the four labelled blocks.`
      : `${assignment}\n\n## Findings\n\n${findings}\n\nWrite the observation, the bridge, the closing question and the subject line. Return ONLY the four labelled blocks.`
    // cacheSystem: the writer prompt is the big stable one, and this is the call that runs
    // up to three times per prospect.
    const writerCall = await callModel(client, WRITER_MODEL, writerSystem, user, 700, `writer for prospect ${params.prospectId}`, true)
    record(writerCall.usage)
    const raw = writerCall.text
    const parsed = parseWriterOutput(raw)
    // Scrub each half separately, then rejoin. Scrubbing the joined text risks a
    // replacement spanning the blank line and collapsing the two paragraphs into one.
    const observation = scrubAITells(parsed.observation, `research/writer/${params.prospectId}`)
    const bridge = scrubAITells(parsed.bridge, `research/writer/${params.prospectId}`)
    const question = scrubAITells(parsed.question, `research/writer/${params.prospectId}`)
    const opening = joinOpening(observation, bridge)

    // THE SUBJECT FAILS SOFT, AND THIS IS THE WHOLE OF THAT MECHANISM.
    //
    // Its failures go into their own array and are never added to `gates`. `gates` is what
    // ends an attempt, so an unusable subject cannot consume one of the two or three the
    // prospect gets. It is logged and dropped, `subject` becomes the empty string, and
    // composition then ships the variant's authored subject: the same subject that ships
    // today, which is the state this change is improving on rather than risking.
    const subjectFailures = checkSubjectGates(parsed.subject, findings)
    if (subjectFailures.length > 0) {
      logger.warn('research/write-opening: generated subject discarded, authored subject will ship', {
        prospect_id: params.prospectId,
        subject: parsed.subject,
        reasons: subjectFailures,
      })
    }
    const subject = subjectFailures.length > 0
      ? ''
      : scrubAITells(parsed.subject, `research/writer/${params.prospectId}`)
    // RETURNED AS WELL AS LOGGED. The log line above is the operational signal; this is
    // the diagnostic record, and a losing subject that exists only in a log cannot be read
    // back alongside the attempt it belonged to. Null when nothing was discarded, which is
    // what tells "the gate rejected one" apart from "the writer returned none".
    const subject_discarded = subjectFailures.length > 0 ? parsed.subject : null

    // The cap covers the whole written block, so gate the combined text.
    const gates = checkOpeningGates(
      `${opening} ${question}`.trim(), params.prospectFirstName, findings, params.p3,
      { observation, bridge, question }, { prospectId: params.prospectId },
    )
    if (!question) gates.push('writer returned no closing question')
    // A missing half means the reply was malformed. Failing here rather than shipping is
    // deliberate: a bridge with no observation reads as a generic line with no anchor, and
    // an observation with no bridge names a fact and then asks for a meeting.
    if (!observation) gates.push('writer returned no observation')
    if (!bridge) gates.push('writer returned no bridge')
    // Deliberately NOT gated: a missing subject is the fallback working, not a failure.
    return { observation, bridge, opening, question, subject, subject_discarded, gates }
  }

  // THE FLOOR. Runs on the personalised email alone, before any comparison, and can only
  // disqualify. A comparison picks a winner, so without this a flawed personalised email
  // ships whenever its template happens to be worse.
  const floorCheck = async (opening: string, question: string, subject: string): Promise<FloorCheck> => {
    // The subject goes in. The floor asks whether the email claims private knowledge, and
    // the subject is part of the email: a line asserting something unknowable is no safer
    // for being above the greeting rather than below it. Empty means the authored subject
    // ships, which is what composeEmail1 falls back to.
    const email = params.composeEmail1(opening, question, subject || null)
    const floorCall = await callModel(client, JUDGE_MODEL, floorSystem, email, 300, `floor for prospect ${params.prospectId}`)
    record(floorCall.usage)
    return parseFloor(floorCall.text)
  }

  const compare = async (
    observation: string,
    bridge: string,
    opening: string,
    question: string,
    floor: FloorCheck,
  ): Promise<JudgeComparison> => {
    // NO SUBJECT OVERRIDE HERE, ON PURPOSE. The judge prompt states that the two drafts
    // "differ only in how they open", and that is what makes its single question answerable:
    // the approved P3 and CTA are common to both so neither can be the deciding factor.
    // Varying the subject as well would give it a second axis and quietly turn a comparison
    // of openings into a comparison of two different things. Both sides therefore carry the
    // variant's authored subject. The generated subject is checked by its own gate and read
    // by the floor, which is where a subject can actually be disqualified.
    const writtenEmail = params.composeEmail1(opening, question)
    const writtenLabel: 'A' | 'B' = writtenLabelFor(params.prospectId)
    const emailA = writtenLabel === 'A' ? writtenEmail : templateEmail
    const emailB = writtenLabel === 'A' ? templateEmail : writtenEmail

    const user = `VERSION A\n\n${emailA}\n\n${'='.repeat(60)}\n\nVERSION B\n\n${emailB}`
    const judgeCall = await callModel(client, JUDGE_MODEL, judgeSystem, user, 300, `judge for prospect ${params.prospectId}`)
    record(judgeCall.usage)
    const { chosen, written_won, reason } = parseChoice(judgeCall.text, writtenLabel)
    return {
      opening, observation, bridge, question, floor,
      written_label: writtenLabel, chosen_label: chosen, written_won, reason,
    }
  }

  const comparisons: JudgeComparison[] = []

  // A SECOND RETRY, BUT ONLY WHERE THE MATERIAL DESERVES IT.
  //
  // Debra and Udo both had findings that scored well and lost on execution, then fell back
  // to template with good material unused. Retrying a prospect whose findings are thin
  // just spends calls to arrive at the same place, so the extra attempt is bought by the
  // evidence: at least one candidate that passed all six tests.
  const strongMaterial = params.candidates.some(c => c.passes_all)
  const maxAttempts = strongMaterial ? 3 : 2

  // AN INTERSECTION, NOT THE SAME FIELDS REPEATED PER VARIANT, and that is the whole of
  // why a rejected attempt's text is now reachable.
  //
  // The union used to carry `opening` and `question` written out three times and `subject`
  // on one variant only, so the observation, the bridge and the subject of everything
  // except a completed comparison were simply not in the type. That is the parallel-lists
  // shape: four variants and one field set to keep in step by hand, and adding a variant
  // without its text produced no error. Written this way there is one list, and a variant
  // that does not carry the text cannot be expressed.
  type Attempt = AttemptText & (
    | { kind: 'gated'; gates: string[] }
    | { kind: 'collided'; reason: string }
    | { kind: 'floored'; floor: FloorCheck }
    | { kind: 'compared'; c: JudgeComparison }
  )

  const attempt = async (feedback: string | null): Promise<Attempt> => {
    const w = await writeOnce(feedback)
    // The text every branch below carries, lifted once. `gates` is deliberately not in it:
    // it belongs to the gated variant and nothing else may read it.
    const text: AttemptText = {
      observation: w.observation, bridge: w.bridge, opening: w.opening,
      question: w.question, subject: w.subject, subject_discarded: w.subject_discarded,
    }
    if (w.gates.length > 0) return { ...text, kind: 'gated', gates: w.gates }

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
      return { ...text, kind: 'collided', reason: uniquenessFeedback(collisions) }
    }

    const floor = await floorCheck(w.opening, w.question, w.subject)
    if (floor.claims_private) {
      logger.warn('research/write-opening: floor disqualified the personalised version', {
        prospect_id: params.prospectId, reason: floor.reason,
      })
      params.uniqueness?.release(params.prospectId)
      return { ...text, kind: 'floored', floor }
    }

    const c = await compare(w.observation, w.bridge, w.opening, w.question, floor)
    // The template won, so nothing of this attempt ships. Holding the reservation would
    // block a later prospect from a shape that was never actually used.
    if (!c.written_won) params.uniqueness?.release(params.prospectId)
    return { ...text, kind: 'compared', c }
  }

  const feedbackFrom = (a: Attempt): string =>
    a.kind === 'gated'
      ? `${a.opening} ${a.question}|||${a.gates.join('; ')}`
      : a.kind === 'collided'
        ? `${a.opening} ${a.question}|||${a.reason}`
        : a.kind === 'floored'
          ? `${a.opening} ${a.question}|||A reviewer said this claims private knowledge about the prospect: ${a.floor.reason}. Say only what can be seen from outside.`
          : `${a.c.opening} ${a.c.question}|||${a.c.reason}`

  let feedback: string | null = null
  let last: Attempt | null = null

  for (let i = 0; i < maxAttempts; i++) {
    const a = await attempt(feedback)
    last = a

    // Reported here rather than inside `attempt` so there is exactly one emit per
    // iteration and the index is the loop's own, not a second counter to keep in step.
    params.onAttempt?.({
      attempt: i,
      kind: a.kind,
      gate_failures: a.kind === 'gated' ? a.gates : [],
      // Copied field by field rather than spread from `a`, because `a` also carries the
      // per-kind members (`gates`, `reason`, `floor`, `c`) and `opening`, and a spread
      // would put all of them into the observation and into the exported JSON. The names
      // cannot drift from the type: AttemptObservation is where AttemptText is Picked
      // FROM, so renaming a member here is a compile error at both ends rather than a
      // field that silently stops being reported.
      observation: a.observation,
      bridge: a.bridge,
      question: a.question,
      subject: a.subject,
      subject_discarded: a.subject_discarded,
      // Null for every kind but 'compared', because no other kind reached the judge. An
      // absent verdict and a verdict of "no reasoning returned" are different facts.
      judge_reasoning: a.kind === 'compared' ? a.c.reason : null,
      judge_written_won: a.kind === 'compared' ? a.c.written_won : null,
    })

    if (a.kind === 'compared') {
      comparisons.push(a.c)
      if (a.c.written_won) {
        return {
          usage,
          opening: a.c.opening, observation: a.c.observation, bridge: a.c.bridge,
          question: a.c.question, subject: a.subject || null, written_won: true,
          retry_used: i > 0, retries_used: i, strong_material: strongMaterial,
          comparisons, judge_reasoning: a.c.reason, gate_failures: [],
        }
      }
    }
    feedback = feedbackFrom(a)
  }

  // Every attempt used. The approved template ships, which is the correct outcome.
  const retries = maxAttempts - 1
  const reason =
    last?.kind === 'gated'
      ? `Failed deterministic gates on the final attempt: ${last.gates.join('; ')}`
      : last?.kind === 'collided'
        ? `Bridge or closing question collided with another prospect in this batch on every attempt: ${last.reason}`
        : last?.kind === 'floored'
          ? `Disqualified by the floor on the final attempt: ${last.floor.reason}`
          : last?.kind === 'compared'
            ? last.c.reason
            : 'No attempt completed.'

  // Nothing from this prospect ships, so it must not be holding any batch reservation.
  params.uniqueness?.release(params.prospectId)

  return {
    usage,
    opening: null, observation: null, bridge: null, question: null, subject: null,
    written_won: false,
    retry_used: retries > 0, retries_used: retries, strong_material: strongMaterial,
    comparisons, judge_reasoning: reason,
    gate_failures: last?.kind === 'gated' ? last.gates : [],
  }
}
