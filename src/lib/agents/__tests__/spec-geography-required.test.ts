// deriveFilterSpec has no default geography, and cannot be made to invent one.
//
// The two constants this replaces, DEFAULT_PERSON_COUNTRIES and DEFAULT_COMPANY_COUNTRIES,
// were both assigned unconditionally, so every client received the same three countries
// regardless of their own document. One live client sold into a single country and was
// sourced firms from another one, with nineteen of twenty being the right kind of
// organisation. Nothing failed, nothing logged, and the ICP's own geography field was
// parsed and then never read.
//
// So the tests that matter here are the ones that fail if a default comes back.

import { describe, it, expect } from 'vitest'
import { deriveFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument, SpecGeography } from '@/lib/agents/icp-filter-spec'
import {
  aTargetableCode,
  twoTargetableCodes,
  anExcludedCode,
  aGeography,
} from '@/test-utils/geography-fixture'

const doc: IcpDocument = {
  summary: 's',
  jtbd_statement: 'j',
  tier_1: {
    company_profile: {
      revenue_range: 'r', headcount: '2-20 people',
      industries: ['Management Consulting'], geography: 'stated on the document',
    },
    buyer_profile: { title: 't', seniority: 's' },
    disqualifiers: [],
  },
  tier_2: {
    company_profile: {
      revenue_range: 'r', headcount: '1-3 people',
      industries: ['Management Consulting'], geography: 'stated on the document',
    },
    buyer_profile: { title: 't', seniority: 's' },
    disqualifiers: [],
  },
  tier_3: {
    company_profile: {
      revenue_range: 'r', headcount: '1 person', industries: ['Management Consulting'],
    },
  },
}

describe('geography is required and has no substitute', () => {
  it('throws when no geography is supplied at all', () => {
    expect(() => deriveFilterSpec(doc, null, undefined as unknown as SpecGeography))
      .toThrow(/no geography was supplied/i)
  })

  it('throws when the country list is empty rather than emitting a default', () => {
    expect(() => deriveFilterSpec(doc, null, { ...aGeography(), countries: [] }))
      .toThrow(/no geography was supplied/i)
  })

  it('throws when the country list is not an array', () => {
    const malformed = { ...aGeography(), countries: 'a string' } as unknown as SpecGeography
    expect(() => deriveFilterSpec(doc, null, malformed)).toThrow(/no geography was supplied/i)
  })

  // POSITIVE CONTROL for all three above. The same document must derive successfully once
  // geography is supplied, or a function that threw unconditionally would satisfy them.
  it('derives successfully when geography is supplied', () => {
    const code = aTargetableCode()
    const spec = deriveFilterSpec(doc, null, aGeography([code]))
    expect(spec.person_countries).toEqual([code])
  })
})

describe('both country lists come from the client, and from the same list', () => {
  it('puts the derived countries on both fields', () => {
    const [a, b] = twoTargetableCodes()
    const spec = deriveFilterSpec(doc, null, aGeography([a, b]))

    expect(spec.person_countries).toEqual([a, b])
    expect(spec.company_countries).toEqual([a, b])
  })

  // The handler refuses a spec that constrains only one of the two. This is why it never
  // has to: they cannot differ, because they are built from one value.
  it('never constrains one side without the other', () => {
    const spec = deriveFilterSpec(doc, null, aGeography(twoTargetableCodes()))
    expect(spec.person_countries).toEqual(spec.company_countries)
  })

  // Two fields sharing one array instance means a caller mutating either changes both,
  // across clients, with no error. Cheap to prevent, invisible if it regresses.
  it('gives each field its own array instance', () => {
    const spec = deriveFilterSpec(doc, null, aGeography())
    expect(spec.person_countries).not.toBe(spec.company_countries)
  })

  it('does not alias the caller\'s array either', () => {
    const geography = aGeography()
    const spec = deriveFilterSpec(doc, null, geography)
    expect(spec.person_countries).not.toBe(geography.countries)
  })
})

describe('what the spec notes record about geography', () => {
  it('states the countries the spec targets and where they came from', () => {
    const code = aTargetableCode()
    const spec = deriveFilterSpec(doc, null, aGeography([code]))

    expect(spec.notes).toContain(code)
    expect(spec.notes).toMatch(/derived from this ICP's own tier 1 and tier 2 geography/i)
  })

  // A narrowing nobody can see is the shape that let three hardcoded countries survive
  // in production for months. Both narrowings below must be legible from the spec alone.
  it('records what was subtracted and why', () => {
    const excluded = anExcludedCode()
    const spec = deriveFilterSpec(doc, null, {
      countries: [aTargetableCode()],
      removed_by_exclusion: [excluded],
      unresolved_phrases: [],
    })

    expect(spec.notes).toContain(excluded)
    expect(spec.notes).toMatch(/excluded from targeting on legal grounds/i)
    expect(spec.notes).toMatch(/regardless of what any document says/i)
  })

  it('records every phrase that named no country, verbatim', () => {
    const spec = deriveFilterSpec(doc, null, {
      countries: [aTargetableCode()],
      removed_by_exclusion: [],
      unresolved_phrases: ['the first skipped phrase', 'the second skipped phrase'],
    })

    expect(spec.notes).toContain('the first skipped phrase')
    expect(spec.notes).toContain('the second skipped phrase')
    expect(spec.notes).toMatch(/never expanded/i)
  })

  // POSITIVE CONTROL for the two above: silence when there is nothing to report, so the
  // notes are not simply carrying both sentences unconditionally.
  it('says nothing about exclusions or skips when there were none', () => {
    const spec = deriveFilterSpec(doc, null, aGeography())
    expect(spec.notes).not.toMatch(/excluded from targeting on legal grounds/i)
    expect(spec.notes).not.toMatch(/named no country and was skipped/i)
  })
})
