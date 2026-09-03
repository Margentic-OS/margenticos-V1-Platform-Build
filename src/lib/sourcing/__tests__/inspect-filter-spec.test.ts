import { describe, it, expect } from 'vitest'
import { inspectFilterSpec, summariseSpecFindings } from '@/lib/sourcing/inspect-filter-spec'
import { FILTER_SPEC_FIELDS } from '@/lib/agents/icp-filter-spec'
import { CLASSIFIABLE_INDUSTRIES } from '@/lib/sourcing/industry-mapping'

// A spec with every filter field present and correctly typed, and industries chosen so
// they are all classifiable. Used as the baseline that must produce zero findings.
function goodSpec(overrides: Record<string, unknown> = {}) {
  return {
    job_titles: ['Founder'],
    job_titles_excluded: [],
    seniority_levels: ['founder'],
    person_countries: ['GB'],
    company_countries: ['GB'],
    company_headcount_min: 5,
    company_headcount_max: 20,
    industries: ['Management Consulting'],
    industries_excluded: [],
    keywords: ['consulting'],
    keywords_excluded: [],
    notes: 'x',
    ...overrides,
  }
}

describe('inspectFilterSpec', () => {
  it('returns nothing for a complete, well-typed spec', () => {
    expect(inspectFilterSpec(goodSpec())).toEqual([])
  })

  // The frozen-spec case. A spec written before a field existed reads as undefined, and
  // tier-classification guards with && rather than throwing, so the rule silently stops
  // being applied. This is the only thing that says so.
  it('reports every absent filter field, one finding each', () => {
    for (const field of FILTER_SPEC_FIELDS) {
      const spec = goodSpec()
      delete (spec as Record<string, unknown>)[field]
      const findings = inspectFilterSpec(spec)
      expect(findings, `expected a finding for missing ${field}`).toHaveLength(1)
      expect(findings[0].code).toBe('field_missing')
      expect(findings[0].field).toBe(field)
    }
  })

  it('reports a field of the wrong runtime type', () => {
    const findings = inspectFilterSpec(goodSpec({ company_headcount_max: '20' }))
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('field_wrong_type')
    expect(findings[0].field).toBe('company_headcount_max')
  })

  it('treats a non-numeric number field as wrong, not merely present', () => {
    const findings = inspectFilterSpec(goodSpec({ company_headcount_min: NaN }))
    expect(findings.map(f => f.code)).toContain('field_wrong_type')
  })

  it('does not require the metadata fields', () => {
    const spec = goodSpec()
    delete (spec as Record<string, unknown>).notes
    // notes constrains nothing, so its absence is cosmetic and must not be reported.
    expect(inspectFilterSpec(spec)).toEqual([])
  })

  // The Executive Coaching class: targeted, reachable, and impossible to classify.
  it('reports an industry no Apollo tag can ever map to', () => {
    const findings = inspectFilterSpec(goodSpec({ industries: ['Executive Coaching'] }))
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('industry_unclassifiable')
    expect(findings[0].detail).toContain('Executive Coaching')
  })

  it('accepts operator-added mappings as making an industry classifiable', () => {
    const findings = inspectFilterSpec(
      goodSpec({ industries: ['Executive Coaching'] }),
      ['Executive Coaching'],
    )
    expect(findings).toEqual([])
  })

  it('matches classifiable names case-insensitively', () => {
    expect(inspectFilterSpec(goodSpec({ industries: ['management consulting'] }))).toEqual([])
  })

  it('does not crash on a spec that is not an object', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const findings = inspectFilterSpec(bad)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].field).toBe('(whole spec)')
    }
  })

  it('summarises findings as a flat greppable string', () => {
    expect(summariseSpecFindings([])).toBe('')
    const s = summariseSpecFindings(inspectFilterSpec(goodSpec({ industries: ['Executive Coaching'] })))
    expect(s).toBe('industry_unclassifiable:industries')
  })
})

// ─── The search range and the classifier range are not the same set ──────────
//
// This checks the registry against the WORLD rather than against itself: it reads the
// handler's OWN targeting list and asks whether each name can come back out of the
// classifier.
//
// IT USED TO ENUMERATE FOUR KNOWN-BAD NAMES so a fifth would fail the build. That was
// right while the handler targeted nineteen consulting industries. It is the wrong shape
// now, because the gap stopped being a short list of oversights and became STRUCTURAL:
//
//   what the handler can SEARCH for   every canonical industry with a NAICS code
//   what the classifier can RECOGNISE only the range of APOLLO_TO_SPEC, which is
//                                     still consulting-shaped
//
// Enumerating the difference would be dozens of names of pure noise that churn on every
// taxonomy edit, and a test that churns is a test that gets updated without being read.
//
// WHY THE GAP IS NOT CLOSED IN THE SAME CHANGE THAT OPENED IT. Closing it means writing
// this provider's industry TAG vocabulary into APOLLO_TO_SPEC, and that vocabulary
// cannot be measured from the sourcing path: the free people-search response carries
// `has_industry` as a BOOLEAN and never the value. The tags only appear after paid
// enrichment. Writing them from memory is precisely the guess that put a wrong parameter
// name in the query twice before, and a wrong tag here silently misclassifies rather
// than erroring. So it is measured first, then written. Logged in BACKLOG.
//
// WHAT THIS TEST GUARDS INSTEAD, and both directions matter:
//
//   1. NO REGRESSION. Every name the classifier can produce must still be searchable.
//      That direction should be total, and a break in it means a client can be told
//      their industry is recognised while nothing can go looking for it.
//   2. A RATCHET on the gap. It may shrink, never grow. A new canonical industry added
//      without a classifier tag widens it and fails here.
describe('handler targeting vs classifier range', () => {
  // Measured 2026-09-03, the commit that made the Apollo query spec-driven. Lower this
  // number when APOLLO_TO_SPEC gains tags. Never raise it without saying why.
  const KNOWN_UNCLASSIFIABLE_CEILING = 58

  it('never targets an industry the classifier cannot produce, without the gap growing', async () => {
    const { APOLLO_TARGETED_INDUSTRIES } = await import(
      '@/lib/sourcing/handlers/adapter-apollo'
    )
    // Guards itself: a scan that finds nothing must fail rather than pass vacuously.
    expect(APOLLO_TARGETED_INDUSTRIES.length).toBeGreaterThan(0)
    expect(CLASSIFIABLE_INDUSTRIES.size).toBeGreaterThan(0)

    const unclassifiable = APOLLO_TARGETED_INDUSTRIES
      .filter(name => !CLASSIFIABLE_INDUSTRIES.has(name))

    expect(
      unclassifiable.length,
      `The searchable-but-unclassifiable set grew to ${unclassifiable.length}. A prospect ` +
      'in one of these is sourced and then removed as industry_off_target with nothing ' +
      'saying why. Add the provider tag to APOLLO_TO_SPEC, or lower the ceiling if you ' +
      'closed some.',
    ).toBeLessThanOrEqual(KNOWN_UNCLASSIFIABLE_CEILING)
  })

  it('can search for every industry the classifier is able to produce', async () => {
    const { APOLLO_TARGETED_INDUSTRIES } = await import(
      '@/lib/sourcing/handlers/adapter-apollo'
    )
    const targetable = new Set<string>(APOLLO_TARGETED_INDUSTRIES)
    expect(targetable.size).toBeGreaterThan(0)

    const producedButUnsearchable = [...CLASSIFIABLE_INDUSTRIES]
      .filter(name => !targetable.has(name))
      .sort()

    expect(
      producedButUnsearchable,
      'The classifier can label a prospect with an industry no query can go looking for.',
    ).toEqual([])
  })
})
