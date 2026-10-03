// canonicalIndustryExact: the industry lookup a SENTENCE rests on.
//
// There are two lookups in industry-mapping.ts and they answer different questions.
//
//   mapApolloToSpecIndustry   feeds a tiering SCORE. Its third step finds an alias inside a
//                             longer provider name, which is a fair guess for a score.
//   canonicalIndustryExact    feeds a sentence a prospect reads about their own firm
//                             (src/lib/sourcing/peer-kind.ts). It has no third step: the
//                             name is itself canonical, or it is a known alias, or the
//                             answer is null and the sentence is not written.
//
// THE CONTRAST IS THE POINT OF THE FUNCTION, so it is planted with real pairs from the
// file: the same input, a value from the tiering lookup, null from this one. Were the
// substring step ever copied across, those are the tests that go red.
//
// The alias table is not exported, so the alias cases below are written out from it. That
// is deliberate here: a test that read the table and looped over it would pass whatever
// the table said.

import { describe, it, expect } from 'vitest'
import { canonicalIndustryExact, mapApolloToSpecIndustry } from '../industry-mapping'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'

describe('canonicalIndustryExact: a provider name that is itself canonical', () => {
  it('has a canonical list to walk at all', () => {
    // The loop below passes over an empty list.
    expect(CANONICAL_INDUSTRIES.length).toBeGreaterThan(50)
  })

  it('PLANTED: every canonical name resolves to itself, in its own case, in lower case, in capitals and padded with spaces', () => {
    for (const name of CANONICAL_INDUSTRIES) {
      expect(canonicalIndustryExact(name), name).toBe(name)
      expect(canonicalIndustryExact(name.toLowerCase()), name).toBe(name)
      expect(canonicalIndustryExact(name.toUpperCase()), name).toBe(name)
      expect(canonicalIndustryExact(`  ${name}\t`), name).toBe(name)
    }
  })

  it('PLANTED: what comes back is the CANONICAL spelling, not the provider\'s', () => {
    // The peer rung compares this against the brief and records it. One spelling.
    expect(canonicalIndustryExact('software publishers')).toBe('Software Publishers')
    expect(canonicalIndustryExact(' WHOLESALE TRADE ')).toBe('Wholesale Trade')
  })

  it('PLANTED: a name that is BOTH canonical and an alias for a neighbour resolves to itself', () => {
    // "executive coaching" is a canonical industry and also an alias key pointing at
    // Business Coaching. Read alias first, a firm whose stored industry names one kind of
    // firm exactly would be told it runs the neighbouring kind.
    expect(canonicalIndustryExact('executive coaching')).toBe('Executive Coaching')
    expect(canonicalIndustryExact('Executive Coaching')).toBe('Executive Coaching')
    // The neighbour still resolves to itself (control).
    expect(canonicalIndustryExact('business coaching')).toBe('Business Coaching')
  })

  it('a name that is neither canonical nor an alias is null (control)', () => {
    expect(canonicalIndustryExact('Computer Software')).toBeNull()
    expect(canonicalIndustryExact('Furniture Manufacturing')).toBeNull()
  })
})

describe('canonicalIndustryExact: a known alias', () => {
  it.each<[string, string]>([
    ['human resources', 'Human Resources Consulting'],
    ['information technology & services', 'Information Technology Consulting'],
    ['financial services', 'Financial Advisory Services'],
    ['professional training & coaching', 'Business Coaching'],
    ['marketing & advertising', 'Marketing Consulting'],
    ['digital marketing', 'Marketing Consulting'],
    ['organizational development', 'Change Management Consulting'],
    ['supply chain', 'Supply Chain Consulting'],
    ['hr consulting', 'Human Resources Consulting'],
    ['it consulting', 'Information Technology Consulting'],
  ])('PLANTED: the alias "%s" resolves to %s, in any case and padded with spaces', (alias, canonical) => {
    expect(canonicalIndustryExact(alias)).toBe(canonical)
    expect(canonicalIndustryExact(alias.toUpperCase())).toBe(canonical)
    expect(canonicalIndustryExact(`  ${alias}  `)).toBe(canonical)
    // Whatever an alias resolves to is a canonical name: a peer group can stand on it.
    expect(CANONICAL_INDUSTRIES as readonly string[]).toContain(canonical)
  })

  it('on an exact name the two lookups agree: the difference is only the third step (control)', () => {
    for (const exact of ['human resources', 'information technology & services', 'supply chain', 'Software Publishers', 'executive coaching']) {
      expect(canonicalIndustryExact(exact), exact).not.toBeNull()
      expect(canonicalIndustryExact(exact), exact).toBe(mapApolloToSpecIndustry(exact))
    }
  })
})

describe('canonicalIndustryExact: NO substring step', () => {
  it('PLANTED: "logistics & supply chain" is null here and Supply Chain Consulting in the tiering lookup', () => {
    // The pair the function's own comment names. A haulier is not a supply chain
    // consultancy: good enough to score, not good enough to say to its owner.
    expect(mapApolloToSpecIndustry('logistics & supply chain')).toBe('Supply Chain Consulting')
    expect(canonicalIndustryExact('logistics & supply chain')).toBeNull()
  })

  it.each<[string, string]>([
    ['human resources services', 'Human Resources Consulting'],
    ['staffing & human resources', 'Human Resources Consulting'],
    ['banking & financial services', 'Financial Advisory Services'],
    ['legal compliance', 'Compliance Consulting'],
    ['it consulting and services', 'Information Technology Consulting'],
  ])('PLANTED: the longer name "%s" only CONTAINS an alias: null here, %s in the tiering lookup', (longer, guessed) => {
    // The first assertion is what makes the second mean something. Were the tiering lookup
    // to return null as well, "null here" would prove nothing about the missing step.
    expect(mapApolloToSpecIndustry(longer)).toBe(guessed)
    expect(canonicalIndustryExact(longer)).toBeNull()
    expect(canonicalIndustryExact(longer.toUpperCase())).toBeNull()
  })

  it('PLANTED: a longer name that only contains a CANONICAL name is null too', () => {
    expect(canonicalIndustryExact('software publishers and more')).toBeNull()
    expect(canonicalIndustryExact('independent legal services')).toBeNull()
    // The name on its own (control).
    expect(canonicalIndustryExact('legal services')).toBe('Legal Services')
  })

  it('PLANTED: part of an alias is not the alias', () => {
    expect(canonicalIndustryExact('information technology')).toBeNull()
    expect(canonicalIndustryExact('human resource')).toBeNull()
    // The whole alias (control).
    expect(canonicalIndustryExact('human resources')).toBe('Human Resources Consulting')
  })
})

describe('canonicalIndustryExact: nothing stored', () => {
  it.each<[string, string | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['only a tab and a line break', '\t\n'],
  ])('PLANTED: %s gives null', (_name, stored) => {
    expect(canonicalIndustryExact(stored)).toBeNull()
  })

  it('PLANTED: a stored value that is not text gives null and does not throw', () => {
    // The column is text, and the enrichment it is copied from is whatever the provider sent.
    for (const stored of [42, true, {}, ['Software Publishers']]) {
      expect(() => canonicalIndustryExact(stored as unknown as string)).not.toThrow()
      expect(canonicalIndustryExact(stored as unknown as string)).toBeNull()
    }
  })

  it('a real name beside them is not null (control)', () => {
    expect(canonicalIndustryExact('Software Publishers')).toBe('Software Publishers')
  })
})
