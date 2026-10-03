// Reading file 7, fix 2: a pain's consequence and its offer link are quoted from the client's
// own documents, and code finds each quote there. Invented client, no real names.
import { describe, it, expect } from 'vitest'
import { quotesNotFound, documentText, supportDocumentType, angleSupportFaults } from '../brief'
import { inventedBrief } from '@/lib/outbound-templates/__tests__/fixtures/invented-client'

const docs = {
  positioning: documentText({ invented_pains: ['Invented passage for PA1 consequence.', 'invented passage for PA2   consequence', 'invented passage for PA3 consequence'], invented_value: [{ line: 'Invented passage for PA1 offer link' }, 'invented passage for PA2 offer link', 'invented passage for PA3 offer link'] }),
}

describe('angle support is found in the client\'s documents', () => {
  it('finds every quote, case and spacing aside (control)', () => {
    expect(quotesNotFound(inventedBrief(), docs)).toEqual([])
  })
  it('PLANTED: a quote the document does not hold is reported, naming the angle and the field', () => {
    const brief = inventedBrief()
    brief.pain_angles[0].consequence_support = { source: 'positioning.x', quote: 'growth stalls and it gets harder to scale' }
    expect(quotesNotFound(brief, docs)).toEqual(['PA1.consequence_support: "growth stalls and it gets harder to scale" is not in the positioning document'])
  })
  it('PLANTED: a quote naming a document the client does not have finds nothing', () => {
    const brief = inventedBrief()
    brief.pain_angles[1].link_support = { source: 'icp.tier_1.triggers[0]', quote: 'invented passage for PA2 offer link' }
    expect(quotesNotFound(brief, docs)).toHaveLength(1)
  })
  it('reads the document from the first segment of the source', () => {
    expect(supportDocumentType({ source: 'icp.tier_1.four_forces.push[1]', quote: 'x' })).toBe('icp')
    expect(supportDocumentType({ source: "Doug's notes on reading file 4", quote: 'x' })).toBeNull()
  })
  it('an angle with both passages has no shape fault; a missing one is named (control and plant)', () => {
    const angle = inventedBrief().pain_angles[0]
    expect(angleSupportFaults(angle)).toEqual([])
    expect(angleSupportFaults({ ...angle, link_support: undefined })[0]).toContain('link_support is missing')
  })
})
