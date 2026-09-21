// PIECE 1: the variant count an operator sees before approving.
//
// BOTH DIRECTIONS ON EVERY CASE. A notice that only appears when something is wrong is
// indistinguishable from a notice that is broken, so the complete case must produce a
// message too, and the short case must name exactly what is dropped.

import { describe, it, expect } from 'vitest'
import { compareVariantCoverage, variantKeysFromSuggestedValue } from '../variant-coverage'
import { variantCoverageMessage } from '@/components/approvals/ApprovalsView'

const doc = (...keys: string[]) => ({
  variants: Object.fromEntries(keys.map(k => [k, { emails: [] }])),
})
const suggested = (...keys: string[]) => JSON.stringify(doc(...keys))

describe('reading the variant keys', () => {
  it('reads them from a suggestion payload, sorted', () => {
    expect(variantKeysFromSuggestedValue(suggested('D', 'A', 'C'))).toEqual(['A', 'C', 'D'])
  })

  // A null is "no answer", never "no problem". A payload that will not parse must not
  // render as a document with zero variants.
  it.each([
    ['null', null],
    ['not JSON', '}{'],
    ['JSON with no variants key', '{"emails":[]}'],
    ['variants as an array', '{"variants":[]}'],
  ])('returns null for %s rather than a count', (_name, payload) => {
    expect(variantKeysFromSuggestedValue(payload as string | null)).toBeNull()
  })
})

describe('the complete case', () => {
  const four = compareVariantCoverage({
    documentType: 'messaging', suggestedValue: suggested('A', 'B', 'C', 'D'), liveContent: doc('A', 'B', 'C', 'D'),
  })!

  it('drops nothing', () => {
    expect(four.missing).toEqual([])
  })

  it('STILL SAYS SOMETHING, so the operator can see the check ran', () => {
    expect(variantCoverageMessage(four)).toBe('4 variants: A, B, C, D.')
  })
})

describe('the short case', () => {
  const short = compareVariantCoverage({
    documentType: 'messaging', suggestedValue: suggested('A', 'C', 'D'), liveContent: doc('A', 'B', 'C', 'D'),
  })!

  it('names exactly the variant that would be dropped', () => {
    expect(short.missing).toEqual(['B'])
  })

  it('says both counts, what is dropped, and what happens to those prospects', () => {
    const msg = variantCoverageMessage(short)
    expect(msg).toContain('3 variants (A, C, D)')
    expect(msg).toContain('live document has 4 (A, B, C, D)')
    expect(msg).toContain('drops B')
    expect(msg).toContain('reassigned to another variant at send time')
    expect(msg).toContain('offer line of the variant they leave')
  })

  it('handles more than one dropped variant', () => {
    const two = compareVariantCoverage({
      documentType: 'messaging', suggestedValue: suggested('A', 'C'), liveContent: doc('A', 'B', 'C', 'D'),
    })!
    expect(two.missing).toEqual(['B', 'D'])
    expect(variantCoverageMessage(two)).toContain('drops B, D')
    expect(variantCoverageMessage(two)).toContain('assigned to them')
  })
})

describe('what it deliberately does not report', () => {
  it('returns null for a document type that has no variants', () => {
    expect(compareVariantCoverage({
      documentType: 'icp', suggestedValue: suggested('A'), liveContent: doc('A', 'B'),
    })).toBeNull()
  })

  // The FIRST messaging document for a client has nothing to be short against.
  it('reports no missing variants when there is no live document yet', () => {
    const first = compareVariantCoverage({
      documentType: 'messaging', suggestedValue: suggested('A', 'B', 'C', 'D'), liveContent: null,
    })!
    expect(first.live).toEqual([])
    expect(first.missing).toEqual([])
    expect(variantCoverageMessage(first)).toBe('4 variants: A, B, C, D.')
  })

  // A suggestion with MORE variants than the live document is not a loss.
  it('reports nothing missing when the suggestion adds a variant', () => {
    const grown = compareVariantCoverage({
      documentType: 'messaging', suggestedValue: suggested('A', 'B', 'C', 'D'), liveContent: doc('A', 'B', 'C'),
    })!
    expect(grown.missing).toEqual([])
  })
})
