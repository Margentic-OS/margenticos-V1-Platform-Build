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

    // A provider tag whose string already IS a canonical name resolves without anyone
    // writing an alias for it. This is the derived identity layer, and these three are
    // not hypothetical: they are among the 24 distinct company_industry values stored in
    // the prospects table on 2026-09-03, and before the range was derived all three
    // returned null and were removed as industry_off_target.
    it('resolves a tag that is already a canonical name, with no alias written for it', () => {
      expect(mapApolloToSpecIndustry('biotechnology')).toBe('Biotechnology')
      expect(mapApolloToSpecIndustry('insurance')).toBe('Insurance')
      expect(mapApolloToSpecIndustry('legal services')).toBe('Legal Services')
    })

    // The identity layer is checked BEFORE the alias table, which matters for the one
    // key that is both. Without that order a tag naming a canonical industry exactly
    // would be rewritten into a neighbouring one, which is what made this canonical name
    // targetable and permanently unclassifiable.
    it('prefers the exact canonical name over an alias that would widen it', () => {
      expect(mapApolloToSpecIndustry('executive coaching')).toBe('Executive Coaching')
      expect(mapApolloToSpecIndustry('business coaching')).toBe('Business Coaching')
    })

    // Still fail-closed for a tag whose WORDING differs from every canonical name. That
    // gap is real and is not closed here: closing it means writing the provider's own tag
    // spellings, which cannot be read from the free search response and must not be
    // guessed. An unknown tag reaches the operator's mapping queue instead.
    it('returns null for a tag no canonical name and no alias matches (fail closed)', () => {
      expect(mapApolloToSpecIndustry('restaurants')).toBeNull()
      expect(mapApolloToSpecIndustry('apparel & fashion')).toBeNull()
      expect(mapApolloToSpecIndustry('automotive')).toBeNull()
      expect(mapApolloToSpecIndustry('think tanks')).toBeNull()
      expect(mapApolloToSpecIndustry('nonprofit organization management')).toBeNull()
    })

    it('returns null for null/empty input', () => {
      expect(mapApolloToSpecIndustry(null)).toBeNull()
      expect(mapApolloToSpecIndustry('')).toBeNull()
    })
  })
})
