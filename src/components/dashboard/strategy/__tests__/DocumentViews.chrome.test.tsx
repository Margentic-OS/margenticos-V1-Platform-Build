// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'

// Test that no em/en dashes appear in strategy document component chrome (labels, headers, separators)
describe('Strategy document views - no dashes in chrome', () => {
  const EM_DASH = '—' // U+2014
  const EN_DASH = '–' // U+2013

  describe('PositioningDocumentView chrome', () => {
    it('should not have dashes in section labels and headers', () => {
      const labels = [
        'Positioning statement',
        'Unique attributes',
        'Market category',
        'Competitive landscape',
        'White space opportunity',
        'Key messages',
        'Value themes',
      ]

      labels.forEach(label => {
        expect(label).not.toContain(EM_DASH)
        expect(label).not.toContain(EN_DASH)
      })
    })
  })

  describe('MessagingDocumentView chrome', () => {
    it('should not have dashes in email sequence labels', () => {
      const labels = [
        'First touch',
        'Follow-up 1',
        'Follow-up 2',
        'Breakup',
        'Email sequence',
      ]

      labels.forEach(label => {
        expect(label).not.toContain(EM_DASH)
        expect(label).not.toContain(EN_DASH)
      })
    })

    it('should not have dashes in variant labels', () => {
      const variants = [
        'A - Pain-led',
        'B - Outcome-led',
        'C - Peer pattern',
        'D - Pattern interrupt',
      ]

      variants.forEach(variant => {
        expect(variant).not.toContain(EM_DASH)
        expect(variant).not.toContain(EN_DASH)
      })
    })
  })

  describe('IcpDocumentView chrome', () => {
    it('should not have dashes in tier labels', () => {
      const labels = [
        'Tier 1 - Primary target',
        'Tier 2 - Secondary target',
        'Tier 3 - Opportunistic',
        'Company profile',
        'Buyer profile',
        'Four forces',
      ]

      labels.forEach(label => {
        expect(label).not.toContain(EM_DASH)
        expect(label).not.toContain(EN_DASH)
      })
    })
  })

  describe('TovDocumentView chrome', () => {
    it('should not have dashes in voice guide section labels', () => {
      const labels = [
        'Voice characteristics',
        'Writing rules',
        'Before / after examples',
        'Do / don\'t',
        'Voice summary',
        'Vocabulary',
      ]

      labels.forEach(label => {
        expect(label).not.toContain(EM_DASH)
        expect(label).not.toContain(EN_DASH)
      })
    })
  })
})
