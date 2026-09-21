// A single-variant repair generates the missing slot ALONGSIDE variants that already
// shipped, so the cross-variant sentence gate has to compare it against them.
//
// THE FAILURE THIS FILE IS WRITTEN AGAINST is not "the gate rejects the wrong thing". It
// is the gate EVAPORATING. SentenceRegistry is populated only by register(), and in a full
// run register() is called only for variants that pass. A repair that carries the stored
// variants in as already-passed and never registers them gets an empty registry: findReuse
// compares against nothing, returns no violations, and the run reports a clean
// cross-variant result having checked nothing. Same shape as a fake that swallows .limit().
//
// So the load-bearing test here is `detects a sentence lifted from a surviving variant`.
// Delete the registry seeding in seedFromSurvivingVariants and that test must go RED. If
// it stays green the test is decorative.
//
// Industry-neutral fixtures throughout (Rule Zero).

import { describe, it, expect } from 'vitest'
import {
  MAX_REPAIR_API_CALLS,
  readSurvivingVariants,
  seedFromSurvivingVariants,
  VariantRepairError,
} from '../messaging-variant-repair-agent'
import {
  AGENT_TIMEOUT_MS,
  MEASURED_PREFLIGHT_SECONDS,
  MEASURED_REPAIR_CALL_SECONDS,
  repairStepCount,
  type EmailRecord,
} from '../messaging-generation-agent'

const SENDER = 'Alex'
const COMPANY = 'Northpoint'
const SIGN_OFF = [SENDER, COMPANY]

// A shared sentence long enough to clear MIN_SHARED_SENTENCE_WORDS (4).
const SHARED_OFFER_LINE = 'We take that work off the desk entirely.'

function email1(observation: string, offer: string, cta: string): EmailRecord {
  return {
    sequence_position: 1,
    subject_line: 'Route planning',
    subject_char_count: 14,
    body: `{{first_name}},\n\n${observation}\n\n${offer}\n\n${cta}\n\n${SENDER}\n${COMPANY}`,
    word_count: 45,
  }
}

function laterEmail(position: number, body: string): EmailRecord {
  return { sequence_position: position, subject_line: null, subject_char_count: 0, body, word_count: 30 }
}

function variant(observation: string, offer: string, cta: string, tail: string): EmailRecord[] {
  return [
    email1(observation, offer, cta),
    laterEmail(2, `${tail} Second message in the sequence.\n\n${SENDER}\n${COMPANY}`),
    laterEmail(3, `${tail} Third message in the sequence.\n\n${SENDER}\n${COMPANY}`),
    laterEmail(4, `${tail} Last one from me on this.\n\n${SENDER}\n${COMPANY}`),
  ]
}

const SURVIVORS: Record<string, EmailRecord[]> = {
  A: variant(
    'Most operators lose a full day a week to manual route planning.',
    SHARED_OFFER_LINE,
    'Worth a look?',
    'Following up on the routing point.',
  ),
  C: variant(
    'Operators at your stage tend to hit the same scheduling ceiling.',
    'Our team runs the scheduling in the background.',
    'Open to a short call?',
    'One more thought on scheduling.',
  ),
  D: variant(
    'Hiring another planner rarely fixes the underlying problem.',
    'We rebuild the planning process instead of adding headcount.',
    'Useful to compare notes?',
    'Circling back on headcount.',
  ),
}

const payloadFor = (keys: string[]) => JSON.stringify({
  variants: Object.fromEntries(keys.map(k => [k, { emails: SURVIVORS[k], angle: k }])),
})

describe('MAX_REPAIR_API_CALLS', () => {
  it('is derived from the measured cost model, not chosen', () => {
    const fromWallClock = Math.floor(
      (AGENT_TIMEOUT_MS / 1000 - MEASURED_PREFLIGHT_SECONDS) / MEASURED_REPAIR_CALL_SECONDS,
    )
    expect(MAX_REPAIR_API_CALLS).toBe(Math.min(repairStepCount(), fromWallClock))
  })

  it('gives one slot more attempts than a four-slot run could give it', () => {
    // The whole reason this path exists: the dropped slot ran out of budget, not merit.
    expect(MAX_REPAIR_API_CALLS).toBeGreaterThan(2)
  })
})

describe('readSurvivingVariants', () => {
  it('returns the surviving variants keyed by slot', () => {
    const survivors = readSurvivingVariants(payloadFor(['A', 'C', 'D']), 'B')
    expect(Object.keys(survivors).sort()).toEqual(['A', 'C', 'D'])
    expect(survivors.A).toHaveLength(4)
  })

  it('refuses to overwrite a variant that is already present', () => {
    expect(() => readSurvivingVariants(payloadFor(['A', 'C', 'D']), 'A'))
      .toThrow(/already present/)
  })

  it('refuses a survivor that does not hold four emails, rather than seeding from a partial set', () => {
    const broken = JSON.parse(payloadFor(['A', 'C', 'D']))
    broken.variants.C.emails = broken.variants.C.emails.slice(0, 2)
    expect(() => readSurvivingVariants(JSON.stringify(broken), 'B'))
      .toThrow(/does not hold four emails/)
  })

  it('refuses a payload with no survivors at all', () => {
    expect(() => readSurvivingVariants(JSON.stringify({ variants: {} }), 'B'))
      .toThrow(VariantRepairError)
  })
})

describe('seedFromSurvivingVariants — the cross-variant gate must not evaporate', () => {
  it('registers every surviving variant, so the registry is not empty', () => {
    const { registry } = seedFromSurvivingVariants(SURVIVORS, SIGN_OFF)
    expect(registry.size).toBeGreaterThan(0)
  })

  // LOAD BEARING. Remove the register() loop in seedFromSurvivingVariants and this fails.
  it('detects a sentence lifted verbatim from a surviving variant', () => {
    const { registry } = seedFromSurvivingVariants(SURVIVORS, SIGN_OFF)
    const candidate = email1('A genuinely new observation about depot turnaround.', SHARED_OFFER_LINE, 'Any use?')

    const reuse = registry.findReuse('B', candidate.body, SIGN_OFF)
    expect(reuse).toHaveLength(1)
    expect(reuse[0].firstSeenId).toBe('A')
    expect(reuse[0].sentence).toBe(SHARED_OFFER_LINE)
  })

  // The same sentence with one noun swapped must still be caught: the registry normalises
  // proper nouns, so "swap a name and ship it" is not a way through.
  it('detects a surviving sentence with a proper noun swapped', () => {
    const { registry } = seedFromSurvivingVariants(
      { A: variant('An observation.', 'We book meetings for Northpoint clients.', 'Worth a look?', 'Tail.') },
      SIGN_OFF,
    )
    const candidate = email1('Another observation entirely.', 'We book meetings for Southgate clients.', 'Any use?')
    expect(registry.findReuse('B', candidate.body, SIGN_OFF).length).toBeGreaterThan(0)
  })

  // THE INVERSE CONTROL. A gate that rejects everything is an outage, not a control.
  it('accepts a candidate whose Email 1 sentences are all new', () => {
    const { registry } = seedFromSurvivingVariants(SURVIVORS, SIGN_OFF)
    const candidate = email1(
      'Depot turnaround slips whenever two drivers call in sick.',
      'We absorb the replanning so the depot keeps moving.',
      'Any use?',
    )
    expect(registry.findReuse('B', candidate.body, SIGN_OFF)).toEqual([])
  })

  it('does not flag the mandatory sign-off block, which is identical in every email by design', () => {
    const { registry } = seedFromSurvivingVariants(SURVIVORS, SIGN_OFF)
    const candidate = email1('A new observation.', 'A new offer line for this slot.', 'Any use?')
    const reuse = registry.findReuse('B', candidate.body, SIGN_OFF)
    expect(reuse.map(r => r.sentence)).not.toContain(SENDER)
    expect(reuse.map(r => r.sentence)).not.toContain(COMPANY)
  })

  // Emails 2 to 4 are deliberately allowed to converge in a full run. A repaired variant
  // must not be held to a stricter rule than the three it ships beside.
  it('registers Email 1 only, matching the gate the other variants passed', () => {
    const { registry } = seedFromSurvivingVariants(SURVIVORS, SIGN_OFF)
    const sharedLaterLine = 'Following up on the routing point. Second message in the sequence.'
    expect(registry.findReuse('B', sharedLaterLine, SIGN_OFF)).toEqual([])
  })

  it('lists the surviving Email 1 sentences in the avoid-block the prompt receives', () => {
    const { taken } = seedFromSurvivingVariants(SURVIVORS, SIGN_OFF)
    expect(taken.sentences).toContain(SHARED_OFFER_LINE)
    expect(taken.subjects.length).toBeGreaterThan(0)
    expect(taken.openers).toContain('Most operators lose a full day a week to manual route planning.')
  })

  it('refuses rather than proceeding when seeding produces an empty registry', () => {
    // A survivor whose Email 1 carries nothing comparable would leave the gate vacuous.
    const hollow = { A: [
      { sequence_position: 1, subject_line: 'x', subject_char_count: 1, body: `{{first_name}},\n\n${SENDER}\n${COMPANY}`, word_count: 3 },
      laterEmail(2, 'Second.'), laterEmail(3, 'Third.'), laterEmail(4, 'Fourth.'),
    ] }
    expect(() => seedFromSurvivingVariants(hollow, SIGN_OFF)).toThrow(/pass vacuously/)
  })
})
