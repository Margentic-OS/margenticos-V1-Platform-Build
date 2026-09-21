// The two new gates, tested in BOTH directions.
//
// A gate that rejects everything is an outage, not a control. The commit gate's self-test
// makes the same point: its ALLOW cases matter as much as its BLOCK cases. So every
// describe below has a rejection case AND a case that must pass, and the passing cases are
// written to be the awkward ones: a legitimate generalisation mid-sentence, a date that
// describes the prospect's own activity, a definite article opening.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import {
  checkFollowupGates,
  checkFollowupPairGates,
  findEcho,
  normaliseForEcho,
  ECHO_NEEDLE_WORDS,
  FOLLOWUP_MAX_SENTENCE_WORDS,
} from '../followup-gates'

/** A reference block, already stripped of its opening paragraph. */
const REFERENCE = [
  'The gap is not the work itself. It is the week that disappears before the next job starts.',
  'Does that match what you see?',
].join('\n\n')

/** Everything a passing follow-up needs, so each test varies one thing. */
const base = {
  position: 2 as const,
  reference: REFERENCE,
  companyName: 'Northgate Fabrication',
  bodyWordCount: 60,
  minWords: 30,
  maxWords: 85,
}

const pass = (prose: string, over: Partial<typeof base> = {}) =>
  checkFollowupGates({ prose, ...base, ...over })

describe('the callback gate: the opening sentence is about this reader', () => {
  it('accepts an opening that says "you"', () => {
    expect(pass('You took on the second unit in March. It changes what a quiet month costs. Shall I show you the first step?')).toEqual([])
  })

  it('accepts an opening that names the company instead of saying "you"', () => {
    expect(pass("Northgate Fabrication's second unit went in during March. That changes what a quiet month costs. Worth a look?")).toEqual([])
  })

  it('rejects a population opener', () => {
    const f = pass('Most owners find the same thing happens every quarter. You will know the feeling. Worth a look?')
    expect(f.some(x => x.includes('opens on a population'))).toBe(true)
  })

  it('rejects every shape the reference material actually uses', () => {
    // These are the SHAPES measured across the live template follow-ups, rewritten with
    // invented nouns. Each must be rejected, or the gate does not cover the thing it was
    // built for.
    const shapes = [
      'The cost that does not show up anywhere obvious: the week before each job.',
      'Most owners who fix this do not do it by working later.',
      'The pattern I see most often is a diary that fills and then empties.',
      'When outreach has failed before, it is almost always the same reason.',
      'There is a common trap here that catches people at this size.',
      'Owners who get past this point rarely do it by pushing harder.',
    ]
    for (const shape of shapes) {
      const f = pass(`${shape} You will recognise it. Worth a look?`)
      expect(f.some(x => x.includes('opens on a population')), shape).toBe(true)
    }
  })

  it('rejects an opening that addresses nobody', () => {
    const f = pass('The second unit went in during March. It changes things. Worth a look?')
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
  })

  it('DOES NOT reject a generalisation that appears mid-sentence', () => {
    // Generalising is how a bridge works. It is the OPENING that must be about them.
    expect(pass('You added the second unit in March, which is where most of this starts. The bench is bigger now. Worth a look?')).toEqual([])
  })
})

describe('the banned-phrase gate', () => {
  it.each([
    'just following up on this',
    'just circling back',
    'just checking in',
    'I never heard back',
    "I haven't heard back from you",
    'hope this finds you well',
    "hope you're well",
  ])('rejects %j', phrase => {
    const f = pass(`You mentioned the second unit. ${phrase}. Worth a look?`)
    expect(f.some(x => x.includes('banned follow-up phrase'))).toBe(true)
  })

  it('DOES NOT reject ordinary use of the same words', () => {
    // "follow" and "hear" are common verbs. The gate targets the MOVE, not the words.
    expect(pass('You said the second unit would follow the first. I hear that a lot. Worth a look?')).toEqual([])
  })
})

describe('the time-reference gate', () => {
  it.each([
    'last week',
    'the other day',
    'a few days ago',
    'since I emailed',
    'my last email',
  ])('rejects %j, because the gap is not known when this is written', phrase => {
    const f = pass(`You took on the second unit. I wrote ${phrase}. Worth a look?`)
    expect(f.some(x => x.includes('refers to when the previous email went out'))).toBe(true)
  })

  it('DOES NOT reject a date describing the prospect\'s own activity', () => {
    // This is the entire basis of the observation Email 1 is built on, and it has to keep
    // working here. A gate that ate it would reject the best follow-ups.
    expect(pass('You took on the second unit in March. Two quarters on, the bench is bigger. Worth a look?')).toEqual([])
    expect(pass('Your third depot opened in 2024. The same gap now costs more. Worth a look?')).toEqual([])
  })
})

describe('the echo gate against the stripped reference', () => {
  it('rejects a lifted clause', () => {
    const lifted = 'the week that disappears before the next job starts'
    const f = pass(`You know ${lifted}. It costs more now. Worth a look?`)
    expect(f.some(x => x.includes('reproduces'))).toBe(true)
  })

  it('finds an echo anywhere, not only at the start', () => {
    expect(findEcho('padding words here the gap is not the work itself and more', REFERENCE))
      .not.toBeNull()
  })

  it(`needs ${ECHO_NEEDLE_WORDS} consecutive words, so a shared phrase is not an echo`, () => {
    expect(findEcho('the gap is not big', REFERENCE)).toBeNull()
  })

  it('normalises punctuation and case, so reformatting does not evade it', () => {
    expect(normaliseForEcho('The GAP, is not -- the work itself!')).toBe('the gap is not the work itself')
    expect(findEcho('The GAP, IS NOT the WORK itself!', REFERENCE)).not.toBeNull()
  })

  it('DOES NOT fire on an empty reference', () => {
    expect(findEcho('any text at all here we go', '')).toBeNull()
  })
})

describe('house rules', () => {
  it('rejects a second question mark', () => {
    const f = pass('You took on the second unit. Does it feel bigger? Worth a look?')
    expect(f.some(x => x.includes('asks 2 questions'))).toBe(true)
  })

  it(`rejects a sentence over ${FOLLOWUP_MAX_SENTENCE_WORDS} words`, () => {
    const long = `You took on the second unit in March and ever since then the bench has been bigger than the work coming in which makes a quiet month cost a great deal more than it did.`
    const f = pass(`${long} Worth a look?`)
    expect(f.some(x => x.includes('against a cap of'))).toBe(true)
  })

  it('rejects a body outside its word band, in both directions', () => {
    const ok = 'You took on the second unit in March. The bench is bigger now. Worth a look?'
    expect(pass(ok, { bodyWordCount: 20 }).some(x => x.includes('outside its band'))).toBe(true)
    expect(pass(ok, { bodyWordCount: 120 }).some(x => x.includes('outside its band'))).toBe(true)
    expect(pass(ok, { bodyWordCount: 60 })).toEqual([])
  })

  it('reports the writer returning nothing, rather than passing vacuously', () => {
    // An empty string must not sail through every gate and read as clean.
    expect(pass('')).toEqual(['email 2: the writer returned nothing'])
  })
})

describe('the pair gates', () => {
  const e2 = 'You took on the second unit in March. The bench is bigger now. Worth a look?'
  const e3 = 'Your second unit changes what a quiet month costs. Worth fifteen minutes?'

  it('rejects email 3 being longer than email 2', () => {
    const f = checkFollowupPairGates(e2, e3, 50, 70)
    expect(f.some(x => x.includes('it must not be longer'))).toBe(true)
  })

  it('accepts equal lengths', () => {
    expect(checkFollowupPairGates(e2, e3, 50, 50)).toEqual([])
  })

  it('rejects a sentence repeated verbatim across the two', () => {
    const shared = 'The bench is bigger now than the work coming in.'
    const f = checkFollowupPairGates(`You took the unit on. ${shared}`, `Your unit changed things. ${shared}`, 50, 40)
    expect(f.some(x => x.includes('repeats a sentence from email 2'))).toBe(true)
  })

  it('DOES NOT reject two different sentences about the same thing', () => {
    // One finding developed across the thread is the GOAL, not the fault.
    expect(checkFollowupPairGates(
      'You took the second unit on in March. The bench is bigger now.',
      'Your second unit changes what a quiet month costs. Worth fifteen minutes?',
      50, 40,
    )).toEqual([])
  })

  it('ignores very short shared fragments', () => {
    expect(checkFollowupPairGates('You did. Worth a look?', 'You did. Worth a look?', 50, 40))
      .toEqual([])
  })
})
