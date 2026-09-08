// The second entry point: an operator describes what is wrong with a result.
//
// ─── WHY THIS IS DETERMINISTIC AND NOT A MODEL CALL ──────────────────────────
//
// ADR-018: deterministic first, and a model only where judgement is genuinely required. The
// judgement here is small. There are only a few things the tuner can actually DO, and most
// of what an operator might write maps to none of them. Resolving prose into one of four
// outcomes, one of which is "I cannot do that", is pattern matching, and a model would add a
// second failure mode — a confident mapping onto the nearest available action — to a step
// whose entire job is to refuse when the request does not fit.
//
// ─── IT IS BIASED TOWARDS REFUSING, AND THAT IS THE DESIGN ───────────────────
//
// The failure this guards against is the tuner quietly doing something adjacent to what was
// asked and reporting success. An operator who wrote a sentence about one problem and got a
// run that solved a different one has been misled, and nothing in the record would say so.
//
// So an unrecognised complaint is REFUSED, with the refusal naming what the tuner can and
// cannot do. Refusing a request it could nearly have served costs one message. Serving the
// wrong one costs a plan somebody approves.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// The vocabulary below is about SIZE and FIT in the abstract: too many, too few, wrong kind.
// It names no industry, sector, product, country, buyer type or company, and it cannot,
// because it has to work for every client.

import type { ItemAxis } from '@/lib/tuner/types'

export type InstructionIntent =
  /** The result is too broad. Tightening is within the document, so the tuner can act. */
  | 'too_broad'
  /** The companies are the wrong kind. The judge is the instrument for this. */
  | 'wrong_population'
  /** The result is too narrow. Widening past the document is forbidden, so this refuses. */
  | 'too_narrow'
  /** Nothing the tuner can act on. */
  | 'unsupported'

export interface ResolvedInstruction {
  intent: InstructionIntent
  /** True when the tuner will run. False means it refused and will not. */
  actionable: boolean
  /** What the tuner will do, or why it will not. Operator-facing, recorded verbatim. */
  resolution: string
  /** Where the loop should concentrate. Empty when it refused. */
  emphasis: ItemAxis[]
}

/** Phrases that mean "there are too many of them, and they are not all right". */
const TOO_BROAD = [
  'too many', 'too broad', 'too wide', 'too general', 'too generic',
  'everyone', 'everything', 'all sorts', 'every kind', 'far too big', 'too big',
]

/** Phrases that mean "these are not the right kind of organisation". */
const WRONG_POPULATION = [
  'wrong kind', 'wrong sort', 'wrong type', 'not the right', 'nothing to do with',
  'irrelevant', 'not who we', 'would never buy', 'not our', 'unrelated',
  'makes no sense', 'not a fit', 'not relevant',
]

/** Phrases that mean "there are not enough of them". */
const TOO_NARROW = [
  'too few', 'too narrow', 'not enough', 'hardly any', 'barely any',
  'only a handful', 'nobody', 'no one', 'empty', 'too small', 'ran out',
]

const contains = (haystack: string, needles: readonly string[]): boolean =>
  needles.some(n => haystack.includes(n))

/**
 * Turn a complaint into something the tuner can do, or into a refusal.
 *
 * The complaint is never modified and never summarised. It is stored verbatim beside this
 * resolution so that a reader can see both what was asked and what was done, and judge the
 * gap for themselves.
 */
export function resolveInstruction(complaint: string): ResolvedInstruction {
  const text = complaint.toLowerCase()

  if (text.trim().length === 0) {
    return {
      intent: 'unsupported',
      actionable: false,
      resolution:
        'No instruction was given, so there is nothing to resolve. Run the tuner without an ' +
        'instruction to tune from the client\'s stored search instead.',
      emphasis: [],
    }
  }

  // Checked BEFORE the breadth tests. "Too many of the wrong kind" is a complaint about fit,
  // and reading it as breadth would tighten a search that is already finding the wrong
  // people, making it find fewer of them. Fit is the more specific claim, so it wins.
  if (contains(text, WRONG_POPULATION)) {
    return {
      intent: 'wrong_population',
      actionable: true,
      resolution:
        'Read as: the organisations being found are the wrong kind. The run will count and ' +
        'difference the search as usual, then judge a sample against what this client sells, ' +
        'and propose narrowing only where the numbers and the judge agree. It will not widen ' +
        'the search and it will not change which classification buckets the client is ' +
        'targeted under, because both go beyond what their document states.',
      emphasis: ['search_word', 'industry_code'],
    }
  }

  if (contains(text, TOO_BROAD)) {
    return {
      intent: 'too_broad',
      actionable: true,
      resolution:
        'Read as: the search is too broad. The run will measure which parts of the search ' +
        'narrow it and which do nothing, and propose adding a measured search word drawn from ' +
        'the client\'s own documents. It will not remove a classification bucket or a job ' +
        'title the client\'s document states, because that is a decision about who they sell ' +
        'to rather than about how the search finds them.',
      emphasis: ['search_word'],
    }
  }

  if (contains(text, TOO_NARROW)) {
    return {
      intent: 'too_narrow',
      actionable: false,
      resolution:
        'CANNOT DO THIS. Read as: the search is too narrow and should find more people. Every ' +
        'way of doing that widens past what the client\'s own document states — adding a ' +
        'classification bucket, a country, a size or a job title it does not name — and the ' +
        'tuner is not allowed to make that decision on the client\'s behalf. What it can do ' +
        'instead is measure the ceiling: run it without an instruction and it will report how ' +
        'many people the same search reaches with the buyer constraints relaxed, which is the ' +
        'number this conversation needs. If that ceiling is also small, the answer is the ' +
        'document, not the search.',
      emphasis: [],
    }
  }

  return {
    intent: 'unsupported',
    actionable: false,
    resolution:
      'CANNOT DO THIS, and it is being refused rather than approximated. The instruction does ' +
      'not describe a result being too broad, or the wrong kind of organisation being found. ' +
      'Those are the two things the tuner can act on: it can narrow a search within what a ' +
      'client\'s document already states, and it can judge whether the organisations found ' +
      'look like plausible buyers. It cannot widen a search, change which classification ' +
      'buckets a client is targeted under, alter their geography, or edit their document. If ' +
      'the problem is one of those, it needs a person. Run without an instruction for a plain ' +
      'measurement of the current search.',
    emphasis: [],
  }
}
