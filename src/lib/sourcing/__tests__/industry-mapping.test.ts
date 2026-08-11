import { describe, it, expect } from 'vitest'
import { mapApolloToSpecIndustry } from '../industry-mapping'

describe('industry-mapping', () => {
  describe('mapApolloToSpecIndustry', () => {
    it('maps human resources to Human Resources Consulting', () => {
      expect(mapApolloToSpecIndustry('human resources')).toBe('Human Resources Consulting')
    })

    it('maps information technology & services to Information Technology Consulting', () => {
      expect(mapApolloToSpecIndustry('information technology & services')).toBe('Information Technology Consulting')
    })

    it('maps financial services to Financial Advisory Services', () => {
      expect(mapApolloToSpecIndustry('financial services')).toBe('Financial Advisory Services')
    })

    it('maps professional training & coaching to Business Coaching', () => {
      expect(mapApolloToSpecIndustry('professional training & coaching')).toBe('Business Coaching')
    })

    it('maps management consulting to Management Consulting', () => {
      expect(mapApolloToSpecIndustry('management consulting')).toBe('Management Consulting')
    })

    it('maps marketing & advertising to Marketing Consulting', () => {
      expect(mapApolloToSpecIndustry('marketing & advertising')).toBe('Marketing Consulting')
    })

    it('is case-insensitive', () => {
      expect(mapApolloToSpecIndustry('HUMAN RESOURCES')).toBe('Human Resources Consulting')
      expect(mapApolloToSpecIndustry('Information Technology & Services')).toBe('Information Technology Consulting')
    })

    it('handles whitespace', () => {
      expect(mapApolloToSpecIndustry('  human resources  ')).toBe('Human Resources Consulting')
    })

    it('returns null for unmapped industries (fail closed)', () => {
      expect(mapApolloToSpecIndustry('restaurants')).toBeNull()
      expect(mapApolloToSpecIndustry('apparel & fashion')).toBeNull()
      expect(mapApolloToSpecIndustry('automotive')).toBeNull()
      expect(mapApolloToSpecIndustry('biotechnology')).toBeNull()
      expect(mapApolloToSpecIndustry('think tanks')).toBeNull()
      expect(mapApolloToSpecIndustry('nonprofit organization management')).toBeNull()
    })

    it('returns null for null/empty input', () => {
      expect(mapApolloToSpecIndustry(null)).toBeNull()
      expect(mapApolloToSpecIndustry('')).toBeNull()
    })
  })
})
