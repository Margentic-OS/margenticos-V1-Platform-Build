import { describe, it, expect } from 'vitest'
import { inspectFilterSpec, summariseSpecFindings } from '@/lib/sourcing/inspect-filter-spec'
import { FILTER_SPEC_FIELDS } from '@/lib/agents/icp-filter-spec'
import { CLASSIFIABLE_INDUSTRIES } from '@/lib/sourcing/industry-mapping'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'

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

  // A ceiling of 0 is present and is a number, so neither field_missing nor
  // field_wrong_type sees it, and the size disqualifier reads it as "no ceiling stated"
  // and does not run. Reported once per run here rather than once per prospect there.
  it('reports a headcount ceiling that is present, numeric and unusable', () => {
    for (const bad of [0, -1]) {
      const findings = inspectFilterSpec(goodSpec({ company_headcount_max: bad }))
      expect(findings.map(f => f.code)).toContain('headcount_ceiling_unusable')
    }
  })

  it('says nothing about a usable headcount ceiling', () => {
    const codes = inspectFilterSpec(goodSpec({ company_headcount_max: 20 })).map(f => f.code)
    expect(codes).not.toContain('headcount_ceiling_unusable')
  })

  it('does not require the metadata fields', () => {
    const spec = goodSpec()
    delete (spec as Record<string, unknown>).notes
    // notes constrains nothing, so its absence is cosmetic and must not be reported.
    expect(inspectFilterSpec(spec)).toEqual([])
  })

  // WHAT THIS FINDING NOW MEANS, because it changed and the old fixture hid the change.
  //
  // It used to be demonstrated with a real canonical industry, because the classifier's
  // range was a hand-written subset of the taxonomy and a perfectly valid canonical name
  // could fall outside it. That gap is closed: CLASSIFIABLE_INDUSTRIES is derived from
  // CANONICAL_INDUSTRIES, so no canonical name can trigger this any more, and a fixture
  // naming one would now assert the defect rather than the mechanism.
  //
  // The finding is NOT vacuous. A stored spec is frozen at write time and is not
  // re-validated on read, so a spec written before the taxonomy validation can carry a
  // name that is not canonical at all. That is the live case this now catches, and the
  // fixture uses an abstract token for it: a real sector name here would be Rule Zero
  // debt and would go stale the moment that sector entered the taxonomy.
  it('reports an industry name the classifier can never produce', () => {
    const findings = inspectFilterSpec(goodSpec({ industries: ['Not A Classifiable Industry'] }))
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('industry_unclassifiable')
    expect(findings[0].detail).toContain('Not A Classifiable Industry')
  })

  it('reports nothing for a canonical industry, now that every one of them is classifiable', () => {
    for (const name of CANONICAL_INDUSTRIES) {
      expect(inspectFilterSpec(goodSpec({ industries: [name] }))).toEqual([])
    }
  })

  it('accepts operator-added mappings as making an industry classifiable', () => {
    const findings = inspectFilterSpec(
      goodSpec({ industries: ['Not A Classifiable Industry'] }),
      ['Not A Classifiable Industry'],
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
    const s = summariseSpecFindings(inspectFilterSpec(goodSpec({ industries: ['Not A Classifiable Industry'] })))
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
  it('targets no industry the classifier cannot produce', async () => {
    const { APOLLO_TARGETED_INDUSTRIES } = await import(
      '@/lib/sourcing/handlers/adapter-apollo'
    )
    // Guards itself: a scan that finds nothing must fail rather than pass vacuously.
    expect(APOLLO_TARGETED_INDUSTRIES.length).toBeGreaterThan(0)
    expect(CLASSIFIABLE_INDUSTRIES.size).toBeGreaterThan(0)

    const unclassifiable = APOLLO_TARGETED_INDUSTRIES
      .filter(name => !CLASSIFIABLE_INDUSTRIES.has(name))
      .sort()

    // EMPTY, and it got there by DERIVING the classifier's range from the taxonomy rather
    // than by adding four entries to a tag table. The four names this used to enumerate
    // were the visible part of a larger gap: the range was the 15 distinct values of a
    // hand-written table, so 58 of the 73 canonical names had no route back. The four were
    // simply the ones the handler also targeted.
    //
    // The self-guard above still matters more than this assertion. An empty result is the
    // correct answer AND the answer a scan that found nothing would give, so the two
    // toBeGreaterThan checks are what stop this passing vacuously.
    expect(unclassifiable).toEqual([])
  })
})
