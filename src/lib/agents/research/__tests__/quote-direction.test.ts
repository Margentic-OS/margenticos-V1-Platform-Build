// A quotation proves words were in the material. It does not prove they support the verdict
// they are attached to, and no surface rule separates the two. These tests pin the structural
// answer: the direction is declared per condition, and a miss on a condition whose NO the
// research cannot show is not counted however good the quotation is.
//
// The worked example is real. On 2026-09-14 the fit judge marked LKO Information Management
// Consulting a MISS on credibility_proof, quoting the firm's own marketing copy about its
// "exemplary service delivery" as proof that it had no proof of results. The quote check
// passed, because the text is genuinely on their site, and the prospect graded weak.

import { describe, it, expect } from 'vitest'
import {
  countedResult, gradeFromDimensions, checkFitDimensions, formatFitDimensions,
  type FitDimension, type DimensionReadings,
} from '../fit-dimensions'

const dim = (over: Partial<FitDimension> = {}): FitDimension => ({
  key: 'credibility_proof',
  statement: 'The firm has case studies, testimonials, or demonstrable proof of results.',
  source: 'They have no case studies, testimonials, or demonstrable proof of results.',
  role: 'required',
  establishable: true,
  ...over,
})

describe('a miss needs a direction research can show', () => {
  it('THE LKO CASE: a found quotation no longer carries a miss where the NO cannot be shown', () => {
    const d = dim({ miss_establishable: false })
    // quoteOk is true: the words really are in the material. That used to be enough.
    expect(countedResult(d, 'miss', true)).toBe('unknown')
  })

  it('the same reading still counts as a miss while the NO is one research can show', () => {
    expect(countedResult(dim(), 'miss', true)).toBe('miss')
    expect(countedResult(dim({ miss_establishable: true }), 'miss', true)).toBe('miss')
  })

  it('THE PARRISH CASE: a threshold condition keeps its quoted miss', () => {
    // "annual revenue of $750K" against a $1M floor. A contradicting value is quotable, so
    // this direction IS establishable, and 8 such readings must not be downgraded.
    const revenue = dim({
      key: 'revenue_floor',
      statement: "The company's annual revenue is at or above $1M.",
      source: 'Annual revenue is below $1M.',
      establishable: false,
    })
    expect(countedResult(revenue, 'miss', true)).toBe('miss')
  })

  it('does not touch a match, which is the direction that IS establishable', () => {
    expect(countedResult(dim({ miss_establishable: false }), 'match', true)).toBe('match')
  })

  it('still refuses a miss that has no quotation at all', () => {
    expect(countedResult(dim({ miss_establishable: false }), 'miss', false)).toBe('unknown')
    expect(countedResult(dim(), 'miss', false)).toBe('unknown')
  })

  it('an undeclared direction means today\'s behaviour, so no stored spec changes meaning', () => {
    const d = dim()
    expect(d.miss_establishable).toBeUndefined()
    expect(countedResult(d, 'miss', true)).toBe('miss')
  })

  it('on a condition research usually cannot establish, a refused miss lands on unestablished', () => {
    const d = dim({ establishable: false, miss_establishable: false })
    expect(countedResult(d, 'miss', true)).toBe('unestablished')
  })
})

describe('the grade stops resting on a miss nothing could have shown', () => {
  const dims: FitDimension[] = [
    dim({ key: 'company_geography', statement: 'Located in the US, UK or Ireland.', source: 'US, UK, Ireland only.', role: 'required' }),
    dim({ key: 'credibility_proof', role: 'required', establishable: false, miss_establishable: false }),
  ]
  const readings = (cred: 'miss' | 'match'): DimensionReadings => ({
    company_geography: { judged: 'match', evidence: 'Dublin, Ireland', quote_found: true, counted: 'match' },
    credibility_proof: {
      judged: cred,
      evidence: 'We bring over 20 years of experience to the table ... exemplary service delivery',
      quote_found: true,
      counted: countedResult(dims[1], cred, true),
    },
  })

  it('the LKO shape no longer grades weak', () => {
    expect(gradeFromDimensions(dims, readings('miss')).icp_fit).not.toBe('weak')
  })

  it('and a real miss on a direction research CAN show still grades weak', () => {
    const shown: FitDimension[] = [dims[0], dim({ key: 'credibility_proof', role: 'required', miss_establishable: true })]
    const r: DimensionReadings = {
      company_geography: { judged: 'match', evidence: 'Dublin, Ireland', quote_found: true, counted: 'match' },
      credibility_proof: { judged: 'miss', evidence: 'x', quote_found: true, counted: 'miss' },
    }
    expect(gradeFromDimensions(shown, r).icp_fit).toBe('weak')
  })
})

describe('the field is read strictly and shown to the judge', () => {
  it('accepts a list that declares it, and one that does not', () => {
    const withField = checkFitDimensions([{ ...dim(), miss_establishable: false }])
    expect(withField.ok).toBe(true)
    if (withField.ok) expect(withField.dimensions[0].miss_establishable).toBe(false)

    const without = checkFitDimensions([dim()])
    expect(without.ok).toBe(true)
    if (without.ok) expect(without.dimensions[0].miss_establishable).toBeUndefined()
  })

  it('refuses a non-boolean rather than treating it as false', () => {
    const bad = checkFitDimensions([{ ...dim(), miss_establishable: 'no' }])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('miss_establishable')
  })

  it('tells the judge not to answer miss where the NO cannot be shown', () => {
    const shown = formatFitDimensions([dim({ miss_establishable: false })])
    expect(shown).toContain('Do not answer miss')
    // and says nothing extra where the direction is open
    expect(formatFitDimensions([dim()])).not.toContain('Do not answer miss')
  })
})
