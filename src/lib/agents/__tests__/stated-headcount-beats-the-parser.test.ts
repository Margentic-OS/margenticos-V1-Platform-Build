// A headcount the client TYPED reaches the filter spec without the prose parser running.
//
// ─── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
//
// The defect it guards is not "the parser is wrong". The parser is a reasonable reader of
// prose and headcount-parser.test.ts covers it. The defect is that a parser was the only
// reader of a field nobody had been asked about, so a sentence stating no range at all
// still produced one, silently, and company_headcount_max is a hard ceiling that removes
// every prospect above it.
//
// The first test below is that measured sentence. It asserts what the parser does, so that
// the reason for the change stays visible and cannot be read as a hypothetical.

import { describe, it, expect } from 'vitest'
import { deriveFilterSpec, parseHeadcountRange } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import { aGeography } from '@/test-utils/geography-fixture'
import { seniorityFixture } from '@/test-utils/seniority-fixture'

/**
 * A document whose tiers state whatever headcount prose a test hands it.
 *
 * Industries are the same canonical name on both targeting tiers, because this file is
 * about headcount and a second validated axis failing would hide which guard fired.
 */
function docWithHeadcount(t1: string, t2: string): IcpDocument {
  const industries = ['Management Consulting']
  const tier = (headcount: string) => ({
    company_profile: {
      stage: 'stated',
      headcount,
      industries,
      revenue_range: 'stated',
    },
    buyer_profile: { title: 'stated', seniority: 'stated' },
    disqualifiers: [],
  })
  return {
    summary: 'test',
    jtbd_statement: 'test',
    tier_1: tier(t1),
    tier_2: tier(t2),
    tier_3: tier('irrelevant'),
  }
}

const derive = (doc: IcpDocument, stated?: { min: number; max: number } | null) =>
  deriveFilterSpec(doc, null, aGeography(), seniorityFixture(), { statedHeadcount: stated })

// The sentence measured on 2026-09-20. It states a two-person lower bound in words and a
// 600-person upper bound in digits, so the only figure the parser can see is the upper one.
const THE_MEASURED_SENTENCE = 'anywhere from a two-person firm to a 600-person company'

describe('the defect this replaces, asserted rather than described', () => {
  it('the parser turns a sentence stating no range into an exact size, and throws nothing', () => {
    expect(parseHeadcountRange(THE_MEASURED_SENTENCE)).toEqual({ min: 600, max: 600 })
  })

  it('and that reaches the spec intact when nothing was stated', () => {
    // Not a criticism of the guards below it: every one of them passes, because 600 to 600
    // is a well-formed range. It is simply the wrong one, and no code can tell.
    const spec = derive(docWithHeadcount(THE_MEASURED_SENTENCE, THE_MEASURED_SENTENCE))
    expect(spec.company_headcount_min).toBe(600)
    expect(spec.company_headcount_max).toBe(600)
  })
})

describe('a stated pair reaches the spec', () => {
  it('uses the client numbers and not the document prose', () => {
    const spec = derive(
      docWithHeadcount(THE_MEASURED_SENTENCE, THE_MEASURED_SENTENCE),
      { min: 2, max: 600 },
    )
    expect(spec.company_headcount_min).toBe(2)
    expect(spec.company_headcount_max).toBe(600)
  })

  it('wins over prose that would parse to something else entirely', () => {
    // THE MUTATION TARGET. If the stated pair were merged with the parsed range instead of
    // replacing it, a union would give 1 to 900 and this fails.
    const spec = derive(docWithHeadcount('1-900 people', '1-900 people'), { min: 10, max: 40 })
    expect(spec.company_headcount_min).toBe(10)
    expect(spec.company_headcount_max).toBe(40)
  })

  it('is used even when the document establishes no bound at all', () => {
    // Without a stated pair this document is a refusal, below. The client answered, so
    // there is nothing to refuse.
    const spec = derive(docWithHeadcount('Varies', 'Varies'), { min: 5, max: 50 })
    expect(spec.company_headcount_min).toBe(5)
    expect(spec.company_headcount_max).toBe(50)
  })

  it('an equal pair is a range, not an error', () => {
    const spec = derive(docWithHeadcount('Varies', 'Varies'), { min: 12, max: 12 })
    expect(spec.company_headcount_min).toBe(12)
    expect(spec.company_headcount_max).toBe(12)
  })

  it('the spec notes say the numbers came from intake and the prose was not parsed', () => {
    // An operator reading a surprising ceiling needs to know which of the two sources
    // produced it without reading the module.
    const spec = derive(docWithHeadcount('1-900 people', '1-900 people'), { min: 10, max: 40 })
    expect(spec.notes).toContain('typed into their intake')
    expect(spec.notes).toContain('was not parsed')
  })
})

describe('a client who has not answered is exactly where they were', () => {
  it('parses the document prose, as before', () => {
    const spec = derive(docWithHeadcount('2-20 people', '1-3 people'))
    expect(spec.company_headcount_min).toBe(1)
    expect(spec.company_headcount_max).toBe(20)
  })

  it('null and undefined both mean not answered', () => {
    for (const absent of [null, undefined]) {
      const spec = derive(docWithHeadcount('2-20 people', '1-3 people'), absent)
      expect(spec.company_headcount_min).toBe(1)
      expect(spec.company_headcount_max).toBe(20)
    }
  })

  it('still refuses a document that establishes no bound', () => {
    expect(() => derive(docWithHeadcount('Varies', 'Varies')))
      .toThrow(/neither tier establishes a lower headcount bound/)
  })

  it('the refusal now also names the intake question as a way out', () => {
    // The operator has a second, cheaper remedy than editing and regenerating a document.
    expect(() => derive(docWithHeadcount('Varies', 'Varies')))
      .toThrow(/answer the buyer headcount question/)
  })

  it('the notes say the prose was parsed, so the two cases are distinguishable', () => {
    const spec = derive(docWithHeadcount('2-20 people', '1-3 people'))
    expect(spec.notes).toContain('parsed from the tier headcount prose')
  })
})

describe('a malformed stated pair falls back rather than failing the derivation', () => {
  // A failed spec derivation stops sourcing for that client until a human re-approves the
  // document. A malformed pair should not cost that: the document path is where this client
  // was yesterday, and it either parses or refuses on its own terms.
  const doc = () => docWithHeadcount('2-20 people', '1-3 people')

  it('an inverted pair falls back to the document', () => {
    const spec = derive(doc(), { min: 80, max: 20 })
    expect(spec.company_headcount_min).toBe(1)
    expect(spec.company_headcount_max).toBe(20)
  })

  it('a zero lower bound falls back to the document', () => {
    const spec = derive(doc(), { min: 0, max: 20 })
    expect(spec.company_headcount_min).toBe(1)
  })

  it('a non-integer falls back to the document', () => {
    const spec = derive(doc(), { min: 1.5, max: 20 })
    expect(spec.company_headcount_min).toBe(1)
    expect(spec.company_headcount_max).toBe(20)
  })
})
