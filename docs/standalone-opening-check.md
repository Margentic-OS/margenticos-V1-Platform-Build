# Does a fallback opening read as a first line?

*Added 2026-09-17. Item 16 of the walkthrough batch.*

## What this does

When a prospect has **no research**, composition ships the message variant's own authored
opening paragraph as the first line of their email. This check reads that paragraph and
warns when it does not work as an opening line.

It **reports only**. It never rewrites copy, never blocks publishing and never blocks a
send.

## What goes wrong without it

Email 1 is authored as a frame with a slot. The second paragraph is the observation slot,
and when research produces an observation, composition replaces it. When research does not,
the authored paragraph ships unchanged.

That fallback is good design and it has a sharp edge. An author writing that paragraph knows
a greeting sits above it and the offer line sits below it, so they can write it as a
*continuation* of a thought. With research, nothing is wrong: the slot is replaced, and the
paragraph the reader sees starts something. Without research, the email opens mid-sentence,
pointing back at something that was never said.

**This shipped. Real prospects received it.**

## Why nothing else caught it

This is the interesting part, and it is worth understanding before touching either module.

`findBackReferences` already detects exactly these pointers, and it already runs on Email 1
in the messaging agent. It **exempts the first content paragraph**, and its own comment says
why:

> in Email 1 it IS the slot that gets replaced, and a demonstrative inside it can only refer
> to something in its own text, which always ships together with it

That reasoning is correct for the researched path and false for the fallback path. **The
exemption is precisely what made this defect invisible**: the one paragraph that needs
checking as an opener is the one paragraph the gate skips, because the gate assumes it will
be replaced.

So `src/lib/style/standalone-opening.ts` is not a second detector. It is the same detector,
applied at the position the existing one cannot reach, using the same displacement trick
`opening-reference.ts` already uses: a placeholder paragraph is put in front so the text
moves off the exempt index.

**That placeholder is load-bearing.** Without it the check scans nothing and returns clean on
every input, which would be a check that runs, reports success, and never reaches what it is
checking. A test asserts it, and removing the placeholder turns that test red.

## What it looks for

Two structural questions about English, and nothing else:

1. **Does it point backwards?** A demonstrative binding an unnamed noun, or a bare pronoun
   with nothing in front of it. Reuses `findBackReferences`.
2. **Does it open on a connective that presupposes a previous sentence?** "But", "So",
   "Instead", "Which" and so on, at position zero only. This is a different fault: a pointer
   refers to a missing *noun*, these refer to a missing *clause*.

Definite articles are deliberately not read. They are report-only in the source detector and
fire on almost every paragraph of real copy, so including them would bury the two signals
above in noise.

## Rule Zero

Nothing in the check, its comments or its fixtures knows about a variant, a client, a sector
or a buyer type. It reads whatever paragraph it is given. A document written for any industry
is judged on its own text.

The paragraph that prompted this names an industry, so it is deliberately **not** reproduced
in any fixture: a fixture is copyable, and copy that could be lifted into a prompt should not
sit in the repository. What the tests reproduce is its *shape*.

## Where it surfaces

**Per prospect, at composition.** `compose-sequence.ts` runs it on the branch where the
authored paragraph actually survives to become the opening, and logs a warning. That is the
right place to catch it and the wrong place to act on it: by then the email exists.

**Per variant, on the quality review screen.** `reportFallbackOpenings` asks the same
question of the messaging document, once per variant, before anything is published. That is
where an operator can do something about it.

That report returns `variantsChecked` alongside its findings. The two are separate on
purpose: **an empty findings array from a document that could not be read must not look like
a clean bill of health.** A test asserts the two are told apart.

## What to check if it fires

1. Read the quoted paragraph. Does it make sense as the first line of an email to someone who
   has read nothing else?
2. If it does, the check is wrong and the pattern should be narrowed. Say so in the commit.
3. If it does not, the paragraph needs rewriting to name its subject rather than point at it.
   That is a copy change in the messaging document, not a code change.

## What it deliberately does not do

**It does not block.** A send halted by a heuristic about prose would be a worse failure than
the one it prevents. The measured false-positive rates on the sibling check
(`opening-reference.ts`) are the argument: on an independent corpus, 30 of 41 openings were
flagged and roughly half of those hits were wrong. A gate on that would reject good copy.
