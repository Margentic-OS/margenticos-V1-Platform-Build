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
import { BatchUniquenessRegistry, uniquenessFeedback } from './batch-uniqueness'
import type { ObservationCandidate } from './types'

const WRITER_MODEL = 'claude-sonnet-4-6'
const JUDGE_MODEL = 'claude-sonnet-4-6'

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

export function buildWriterPrompt(params: {
  clientName: string
  p3: string
  cta: string
}): string {
  return `You are a senior BDR with fifteen years behind you, writing for ${params.clientName}.

You are writing to a founder you respect, who runs a real business and gets a lot of these.
Your only goal is a reply. Not to demonstrate that you did the research. Not to prove you
looked them up. A reply.

That distinction decides everything about how you open. A junior opens by showing their
work, because they are being marked on effort. You are not. You open with the one thing
you noticed that makes this person worth writing to, and you let it do the work.

Here is the email, exactly as it will send. You write the three bracketed parts:

  [YOUR OBSERVATION GOES HERE]

  [YOUR BRIDGE GOES HERE]

  ${params.p3}

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

Second, the bridge: its own paragraph, naming the problem your target is, as a PATTERN
that is typically true of firms in the situation you just described.

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

The approved question for this particular variant is "${params.cta}", and the same applies
to it.

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
  "Is turning that audience into the right kind of buyer something you're working on?"
Same register, same length, and now it asks about the problem the email just described.

THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT.

This is the rule that matters most and the one most easily broken. You can see what they
did. You cannot see their pipeline, their calendar, their marketing results, or whether
any of it is working. Writing as though you can is presumptuous, it is frequently wrong,
and a founder who reads a wrong claim about their own business stops reading.

So the bridge may say what is TYPICALLY true of firms in this position. It may never say
what IS true of this prospect's pipeline, diary, marketing or results.

And never tell them something they are doing is not working. Their network, their events,
their content, their brand may all be working perfectly. You have no way of knowing, and
that is precisely the sentence that earns a defensive reply instead of a meeting.

VERDICT, and this one is not just presumptuous but wrong:
  observation: "The hiring post for a Manager of Delivery and Operations says the client
   load is real and growing."
  bridge: "What a Chamber event and a strong network cannot do is put Blue Sky in front of
   the right buyers before that new capacity is already spoken for."
A chamber event and a strong network is exactly how a great many consultancies fill
capacity. We told him the thing that works does not work.

PATTERN, same observation, corrected:
  observation: "The hiring post for a Manager of Delivery and Operations says the client
   load is real and growing."
  bridge: "A network fills the first months after a hire like that. The months after it
   are the harder ones."
Nothing here claims his network has failed. It names what tends to happen next, and leaves
him to decide whether it is happening to him.

VERDICT again, invented outright:
  "Eleven years in, a firm that size fills its diary through relationships, and
   relationships only reach so far."
We have no idea how Taffet fills its diary. We made it up and then built on it.

YOU MAY ATTRIBUTE THE PATTERN, BUT ONLY TO YOURSELF.

A bridge stated flatly as how the world works is the bluntness that reads presumptuous.
"Governance work has fixed dates and shows up on a calendar. Business development does not."
is delivered as fact about their category, and the reader either agrees or has been told
they are wrong about their own week.

ALLOWED: attributing the pattern to what YOU have seen or heard. That is a claim about your
own experience. It is true, it is checkable against nothing, and the reader can disagree
with it without being contradicted about their own business.

NOT ALLOWED, and this is the trap: attributing to THEIR peer group as fact. "Here's the
assumption most consulting founders make" and "Most firms at this stage find" are not softer
versions of the same thing. They still tell the reader what he thinks, and they claim a
bigger sample while doing it. The question is always whose experience is being reported.
Yours is honest. Theirs is a verdict wearing a larger number.

NEVER IMPLY AN EXISTING CLIENT BASE. No "the firms we work with", no "our clients", no "we
have seen this with", no case studies, no results from previous engagements. There are no
clients yet. A false claim there is the one thing that cannot be walked back, and it is
rejected in code before anyone reads it.

ATTRIBUTION IS OPTIONAL AND NEVER A FIXED OPENER. An unattributed pattern is still fine
where it reads as something noticed rather than something pronounced. If every bridge in the
batch opens the same way, that is the sentence-shape problem returning in a new costume, and
the batch gate treats an attributed opening exactly like any other: the second prospect to
use that shape is rejected. There is no house phrase for this. Build the attribution out of
your own words the same way you build the rest of the sentence.

ASSERTED, and this shipped:
  "Governance work has fixed dates and shows up on a calendar. Business development does
   not, so it gets the hours that are left."

ATTRIBUTED, same claim, inside the bridge budget:
  "The founders I speak to describe the same split. Board dates are fixed. Selling is what
   moves."
Seventeen words. Nothing is hedged and nothing is softened: the observation is just as
pointed, and it is now offered as something heard rather than handed down. The wording above
is not a phrase to reuse. It goes through the batch gate like everything else.

NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME.

"Firms that X often find Y" is one construction. It is not the only one, and it used to be
the shape of nearly every worked example on this page. Twelve prospects came back with
eleven bridges built on that frame, three of them close to word-identical. When every
bridge in a batch has the same skeleton the personalisation is decorative: two recipients
comparing notes see one template with the nouns swapped.

So your bridge must not share a sentence shape with another prospect in this batch. Vary
the CONSTRUCTION, not just the nouns.

EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY, DELIBERATELY. None of them is about
consulting, agencies or outbound. THE SHAPE IS WHAT TRANSFERS. EVERY WORD IN THEM IS
UNUSABLE HERE, because a sentence about scaffolding or wedding albums pasted into this
email is obviously wrong on sight. That is the point: the last two batches lifted the
examples almost verbatim and the batch gate threw the attempts away. Read them for
structure and then write your own sentence out of your own prospect's facts.

  A CONDITIONAL. Puts their own situation on the left of the sentence.
    A dentist: "When the chairs are full six weeks out, nobody is phoning the patients who
     missed a check-up."

  WHAT USUALLY HAPPENS NEXT. Plain sequence, no hedging verb at all.
    A commercial builder: "A big site keeps the crews busy for a year. The tenders for the
     next one get written in the last month, if at all."

  A CONTRAST. Two short clauses, the second overturning the first.
    A freight broker: "Peak season fills the trucks without a single sales call. February
     does not, and by then nobody has spoken to a new shipper since October."

  A CONSEQUENCE. States the position their situation puts them in.
    A wedding photographer: "That books out the summer. It also means every enquiry for
     next spring arrives while you are editing somebody else's album."

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
It is safe, it obeys every rule above, and it says nothing. The approved paragraph further
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
   tokenization, Treasury clearing and the SEC's crypto posture. That output shows where
   your thinking is."
Three sentences. Each one carries a single idea and every subject sits next to its verb.

CRAMPED:
  "Two new board seats in early 2026. Hollywood Food Coalition and Sovern LA, on top of
   running SCG full-time is a real load."
The same fault. An appositive list swallows the subject, so "is a real load" arrives with
nothing attached to it.

CLEAN:
  "You took two board seats in early 2026, at Hollywood Food Coalition and Sovern LA. That
   is on top of running SCG full time."
Two sentences. The naming sits inside a clean subject and verb rather than replacing one.

Note what did NOT change in either rewrite. Same facts, same specificity, same length
roughly. Only the joins moved.

EVERY SENTENCE MUST BE CLEAR ON ONE READING.

You are writing to someone scanning their inbox between meetings. A sentence they have to
go back over has already lost.

FAILING on clarity, and note this one is correctly pattern-framed, so getting the stance
right is not enough:
  "That tends to be when the next engagement goes uncontested to whoever stayed visible."
The idea is sound and the reader has to assemble it. Who is uncontested, what contest,
visible to whom. Say it plainly: "That is usually when the next piece of work goes to
whoever was still in front of them."

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

HARD, and this shipped:
  "Consulting firms that rely on conference appearances for new conversations often find
   the pipeline moves in cycles that follow the conference calendar rather than delivery
   demand."
Ten words before the verb. Three relative clauses, one nested inside another. Every word
of it is true and nobody reads it once.

EASY, and this shipped too:
  "Founders who move that fast often find the first clients come quickly and the pipeline
   behind them takes longer to build."
Barely shorter. A four-word subject, one relative clause, nothing nested.

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
  "A day job and active delivery leave the consulting pipeline running on whatever is
   left. That remainder tends to shrink before it grows."
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
  "Delivery has a deadline. Business development never does, so it waits."
Deadline. Waits. Two things anyone can see happening in their own calendar.

THE CAMERA TEST. RUN IT ON EVERY SENTENCE, AND TWICE ON THE LAST FEW WORDS OF THE BRIDGE.

Point a camera at their week. Would you see the thing you just described happening?

  "Hours shrink before they grow" is unfilmable. Nobody can photograph an hour shrinking.
  "Delivery has a deadline. Business development never does, so it waits" is filmable: a
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

FAILING: "Outreach for the consulting side gets whatever hours remain, and those tend to
 shrink before they grow."
Hours do not grow. Point the camera and there is nothing to film.
PLAIN: "Outreach gets whatever hours are left at the end of the day. Most weeks nobody gets
 to it."
Now you can film it: a day ending, and a person not making the call.

FAILING: "The founders who hear it and are ready to buy tend to need a nudge before they
 become a conversation."
People do not become conversations. "Need a nudge" is not something anyone does either.
PLAIN: "Some of the people who heard it are ready to buy. They will not email you first."
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
took". "the CAVE stand". NOT a bare category: "every LinkedIn post", "board dates",
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
PLAIN:   "You are CEO of two companies at once, so on Monday you work on whichever one has a
 client waiting."
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
whole attempt away. It has already happened five times: the previous plain rewrite in this
prompt ended "nobody gets to it", and two prospects in the same batch both ended on it.
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

NEVER OPEN BY NAMING WHAT THEY LACK. No "there is no", no "nothing about", no "with no
case studies", no lists of what is missing from their site or their feed. A senior seller
does not tell a founder their website is thin. Notice something that IS there instead.

${FIRMOGRAPHIC_RULE_TEXT}

TWO MORE FAILURES WORTH KNOWING, both about who you are writing to:

FAILING:
  "Jason left Pani as Director of Product in July 2024 and launched HydrospherIQ three
   months later, with a current headcount of one."
Third person, about him rather than to him. A dossier entry. It leads nowhere.

FAILING:
  "You left Visteon at SVP level in December 2022. Knot Consulting has been the full focus
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

Return your answer as exactly three labelled blocks and nothing else:

OBSERVATION: <the thing you noticed, its own paragraph>
BRIDGE: <the pattern, its own paragraph>
QUESTION: <the closing question, ending in a question mark>`
}

// ─── The judge prompt ────────────────────────────────────────────────────────
//
// A CHOICE, NOT A GATE. The first version framed this as a gatekeeper with a free
// rejection: "HOLD costs nothing, when in doubt HOLD". An absolute bar plus a costless
// no means nothing ever passes, and nothing did, 0 of 13. It also started rejecting the
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

export function buildJudgePrompt(): string {
  return `You are the head of sales. Two drafts of the same cold email are in front of you,
both written by your team, both ready to send. They differ only in how they open.

Both go out under your name. Which one could a busy founder read once, at speed, without
going back over any sentence, and still find the closing question the obvious thing to ask
them?

Answer A or B, then one sentence on why.

Reply in exactly this format:
CHOICE: A
REASON: one sentence.`
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
  /** Which label the WRITTEN version was given. Randomised per comparison. */
  written_label: 'A' | 'B'
  /** The label the judge picked. */
  chosen_label: 'A' | 'B'
  /** True when the judge picked the written opening over the approved template. */
  written_won: boolean
  reason: string
}

// ─── Deterministic gates on the writer's output ──────────────────────────────
//
// These three and no others. Everything else is the judge's job. A gate here is for
// things a model should not be asked to self-report: length, whether it slipped into the
// third person, and whether it invented a fact.

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

/**
 * Claims of an existing client base. There are no clients yet.
 *
 * A GATE RATHER THAN A PROMPT LINE, for the reason every other gate here exists: the prompt
 * has told the writer not to pitch since the day it was written, and the writer has echoed
 * the approved offer line, quoted a headcount and asked a second question anyway (ADR-028).
 * This one is worse than those. A recipient who asks which firms we work with, and finds
 * out the answer is none, is not a lost email. It is a lost reputation, and it cannot be
 * walked back.
 *
 * Narrow on purpose. It looks for a claimed RELATIONSHIP with other companies, not for the
 * word "we": the approved offer line says "We get qualified conversations into the diary",
 * which promises what the sender does and claims nothing about who it has done it for.
 */
const CLIENT_BASE_CLAIMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bour (?:clients|customers)\b/i,                                        label: '"our clients"' },
  { pattern: /\bclients of ours\b/i,                                                  label: '"clients of ours"' },
  { pattern: /\b(?:firms|companies|founders|businesses|teams|clients) we (?:work with|serve|help|support)\b/i, label: 'a claimed client relationship' },
  { pattern: /\bwe(?:'ve|\s+have)\s+(?:helped|worked with|seen this with|seen it with)\b/i, label: 'a claimed track record' },
  { pattern: /\bevery (?:client|customer) (?:we|of ours)\b/i,                          label: 'a claimed client base' },
]

/** Labels of every client-base claim found. Empty when the copy claims nothing. */
export function findClientBaseClaims(text: string): string[] {
  return [...new Set(CLIENT_BASE_CLAIMS.filter(c => c.pattern.test(text)).map(c => c.label))]
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

  // A DELIBERATE FOURTH GATE. The brief said to keep the deterministic gates unchanged,
  // and this adds one, so the reasoning should be on the record. A prompt rule alone is
  // advisory (ADR-028), the messaging agent enforces this same ban in code, and the
  // failure it prevents has already shipped once: "a $5M consulting firm" in Bob's
  // opening. Traceability would not have caught it, because the figure was genuinely in
  // the findings. Being in the findings is exactly what makes it dangerous.
  const figures = findFirmographicFigures(opening)
  if (figures.length > 0) {
    failures.push(`quotes ${figures.join(' and ')} from the prospect's record: qualify by role, stage or situation instead`)
  }

  // A FIFTH GATE, and it exists because this change set created the hole it closes.
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

  // A SIXTH GATE, and it shipped before it was caught. Bob's Email 1 read:
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
  const clientClaims = findClientBaseClaims(opening)
  if (clientClaims.length > 0) {
    failures.push(`claims an existing client base (${clientClaims.join(', ')}): there are no clients yet, so attribute the pattern to what you have seen, never to work you have done`)
  }

  if (approvedP3) {
    const p3Words = normaliseForEcho(approvedP3).split(' ').filter(Boolean)
    const needle = p3Words.slice(0, 6).join(' ')
    if (p3Words.length >= 6 && normaliseForEcho(opening).includes(needle)) {
      failures.push('repeats the approved offer line, which is already in the email: write only the observation, the bridge and the closing question')
    }
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

async function callModel(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  context: string,
): Promise<string> {
  try {
    const res = await client.messages.create({
      model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
    })
    const block = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    return block?.text?.trim() ?? ''
  } catch (err) {
    throwIfFatal(err, context)
    throw err
  }
}

/**
 * Reads the judge's pick. An unreadable reply resolves to the TEMPLATE, never to the
 * written opening, so an ambiguous answer can only ever fall back to approved copy.
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

export interface WriteAndJudgeParams {
  apiKey: string
  clientName: string
  prospectFirstName: string | null
  candidates: ObservationCandidate[]
  p3: string
  cta: string
  /**
   * Builds the complete Email 1. `question` is optional so the TEMPLATE side of the
   * comparison keeps its own approved CTA: both emails must be complete and genuinely
   * sendable, or the comparison is not honest.
   */
  composeEmail1: (opening: string, question?: string | null) => string
  /** The variant's own approved opening, the version the written one has to beat. */
  templateOpening: string
  prospectId: string
  /**
   * Batch-scoped uniqueness for the bridge and the closing question. Omit for a single
   * prospect run: with nothing else in the batch there is nothing to collide with, and a
   * per-prospect registry would only ever reserve against itself.
   */
  uniqueness?: BatchUniquenessRegistry
}

/**
 * Splits the writer's three labelled blocks.
 *
 * The observation and the bridge are returned separately because they are now separate
 * paragraphs in the email AND because the bridge alone is what the batch-uniqueness gate
 * measures. `opening` is the two joined by a blank line, which is what gets stored and
 * composed: composition replaces the P2 slot with it verbatim, and a trigger containing
 * its own blank line becomes two paragraphs when the body is re-joined.
 *
 * OPENING: is still accepted as a fallback label. A writer that returns the old two-block
 * format would otherwise lose its whole observation to the regex and ship a bridge on its
 * own, which reads as a generic line with no anchor.
 */
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
  const writerSystem = buildWriterPrompt({ clientName: params.clientName, p3: params.p3, cta: params.cta })
  const judgeSystem = buildJudgePrompt()
  const floorSystem = buildFloorPrompt()

  // The template keeps its OWN approved CTA. Passing no question is what makes that true.
  const templateEmail = params.composeEmail1(params.templateOpening, null)

  const writeOnce = async (
    feedback: string | null,
  ): Promise<{ observation: string; bridge: string; opening: string; question: string; gates: string[] }> => {
    // The questions already gone in this batch, listed rather than implied. Shown on every
    // retry, not just a collision retry: the writer that is rewriting for length is equally
    // capable of walking into a taken question on the way past.
    const taken = params.uniqueness?.takenQuestions(params.prospectId) ?? []
    const takenBlock = taken.length > 0
      ? `\n\n## Closing questions already taken in this batch\n\nDo not use any of these, and do not reword one slightly:\n${taken.map(q => `- ${q}`).join('\n')}`
      : ''

    const user = feedback
      ? `## Findings\n\n${findings}${takenBlock}\n\n## Your previous attempt did not ship\n\nYou wrote:\n${feedback.split('|||')[0]}\n\nThe reason:\n${feedback.split('|||')[1]}\n\nWrite a different version that answers that. Return ONLY the three labelled blocks.`
      : `## Findings\n\n${findings}\n\nWrite the observation, the bridge and the closing question. Return ONLY the three labelled blocks.`
    const raw = await callModel(client, WRITER_MODEL, writerSystem, user, 700, `writer for prospect ${params.prospectId}`)
    const parsed = parseWriterOutput(raw)
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
    if (!question) gates.push('writer returned no closing question')
    // A missing half means the reply was malformed. Failing here rather than shipping is
    // deliberate: a bridge with no observation reads as a generic line with no anchor, and
    // an observation with no bridge names a fact and then asks for a meeting.
    if (!observation) gates.push('writer returned no observation')
    if (!bridge) gates.push('writer returned no bridge')
    return { observation, bridge, opening, question, gates }
  }

  // THE FLOOR. Runs on the personalised email alone, before any comparison, and can only
  // disqualify. A comparison picks a winner, so without this a flawed personalised email
  // ships whenever its template happens to be worse.
  const floorCheck = async (opening: string, question: string): Promise<FloorCheck> => {
    const email = params.composeEmail1(opening, question)
    const raw = await callModel(client, JUDGE_MODEL, floorSystem, email, 300, `floor for prospect ${params.prospectId}`)
    return parseFloor(raw)
  }

  const compare = async (
    observation: string,
    bridge: string,
    opening: string,
    question: string,
    floor: FloorCheck,
  ): Promise<JudgeComparison> => {
    const writtenEmail = params.composeEmail1(opening, question)
    const writtenLabel: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B'
    const emailA = writtenLabel === 'A' ? writtenEmail : templateEmail
    const emailB = writtenLabel === 'A' ? templateEmail : writtenEmail

    const user = `VERSION A\n\n${emailA}\n\n${'='.repeat(60)}\n\nVERSION B\n\n${emailB}`
    const raw = await callModel(client, JUDGE_MODEL, judgeSystem, user, 300, `judge for prospect ${params.prospectId}`)
    const { chosen, written_won, reason } = parseChoice(raw, writtenLabel)
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

  type Attempt =
    | { kind: 'gated'; gates: string[]; opening: string; question: string }
    | { kind: 'collided'; reason: string; opening: string; question: string }
    | { kind: 'floored'; floor: FloorCheck; opening: string; question: string }
    | { kind: 'compared'; c: JudgeComparison }

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

    if (a.kind === 'compared') {
      comparisons.push(a.c)
      if (a.c.written_won) {
        return {
          opening: a.c.opening, observation: a.c.observation, bridge: a.c.bridge,
          question: a.c.question, written_won: true,
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
    opening: null, observation: null, bridge: null, question: null, written_won: false,
    retry_used: retries > 0, retries_used: retries, strong_material: strongMaterial,
    comparisons, judge_reasoning: reason,
    gate_failures: last?.kind === 'gated' ? last.gates : [],
  }
}
