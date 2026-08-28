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

// This is the assertion that would have caught the live gap, and it checks the registry
// against the WORLD rather than against itself: it reads the handler's OWN targeting list
// and asserts every name in it can come back out of the classifier.
//
// It is currently EXPECTED TO FAIL for four names and is written as an explicit,
// enumerated allowlist rather than a skip, so that (a) the four are visible in the test
// output as a known debt and (b) a FIFTH one appearing fails the build.
describe('handler targeting vs classifier range', () => {
  it('has exactly the four known unclassifiable targeted industries, and no more', async () => {
    const { APOLLO_TARGETED_INDUSTRIES } = await import(
      '@/lib/sourcing/handlers/adapter-apollo'
    )
    // Guards itself: a scan that finds nothing must fail rather than pass vacuously.
    expect(APOLLO_TARGETED_INDUSTRIES.length).toBeGreaterThan(0)
    expect(CLASSIFIABLE_INDUSTRIES.size).toBeGreaterThan(0)

    const unclassifiable = APOLLO_TARGETED_INDUSTRIES
      .filter(name => !CLASSIFIABLE_INDUSTRIES.has(name))
      .sort()

    expect(unclassifiable).toEqual([
      'Engineering Consulting',
      'Environmental Consulting',
      'Executive Coaching',
      'Healthcare Consulting',
    ])
  })
})
