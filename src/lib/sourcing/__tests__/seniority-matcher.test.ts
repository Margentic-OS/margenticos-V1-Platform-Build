import { describe, it, expect } from 'vitest'
import { isDecisionMaker } from '../tier-classification'

describe('Decision-maker seniority matching', () => {
  describe('Single-role titles', () => {
    it('matches CEO', () => {
      expect(isDecisionMaker('CEO')).toBe(true)
    })

    it('matches Chief Executive Officer', () => {
      expect(isDecisionMaker('Chief Executive Officer')).toBe(true)
    })

    it('matches Founder', () => {
      expect(isDecisionMaker('Founder')).toBe(true)
    })

    it('matches Managing Director', () => {
      expect(isDecisionMaker('Managing Director')).toBe(true)
    })

    it('matches Managing Partner', () => {
      expect(isDecisionMaker('Managing Partner')).toBe(true)
    })

    it('matches Principal', () => {
      expect(isDecisionMaker('Principal')).toBe(true)
    })

    it('matches Principal Consultant', () => {
      expect(isDecisionMaker('Principal Consultant')).toBe(true)
    })

    it('matches Partner', () => {
      expect(isDecisionMaker('Partner')).toBe(true)
    })

    it('matches Owner', () => {
      expect(isDecisionMaker('Owner')).toBe(true)
    })

    it('matches Co-founder', () => {
      expect(isDecisionMaker('Co-founder')).toBe(true)
    })

    it('rejects VP without decision maker', () => {
      expect(isDecisionMaker('VP Sales')).toBe(false)
    })

    it('rejects Director (not decision maker)', () => {
      expect(isDecisionMaker('Director of Sales')).toBe(false)
    })
  })

  describe('Compound titles with separators', () => {
    it('matches "Founder & CEO"', () => {
      expect(isDecisionMaker('Founder & CEO')).toBe(true)
    })

    it('matches "CEO/President"', () => {
      expect(isDecisionMaker('CEO/President')).toBe(true)
    })

    it('matches "Principal | Partner"', () => {
      expect(isDecisionMaker('Principal | Partner')).toBe(true)
    })

    it('matches "Managing Director + Owner"', () => {
      expect(isDecisionMaker('Managing Director + Owner')).toBe(true)
    })

    it('matches "Managing Partner and Founder"', () => {
      expect(isDecisionMaker('Managing Partner and Founder')).toBe(true)
    })

    it('matches "CEO & Founder"', () => {
      expect(isDecisionMaker('CEO & Founder')).toBe(true)
    })

    it('matches "Co-Founder / CTO"', () => {
      expect(isDecisionMaker('Co-Founder / CTO')).toBe(true)
    })

    it('rejects "VP / Director" (neither are decision makers)', () => {
      expect(isDecisionMaker('VP / Director')).toBe(false)
    })
  })

  describe('Case insensitivity', () => {
    it('matches lowercase "ceo"', () => {
      expect(isDecisionMaker('ceo')).toBe(true)
    })

    it('matches mixed case "Ceo"', () => {
      expect(isDecisionMaker('Ceo')).toBe(true)
    })

    it('matches mixed case "FOUNDER"', () => {
      expect(isDecisionMaker('FOUNDER')).toBe(true)
    })

    it('matches mixed case "managing Partner"', () => {
      expect(isDecisionMaker('managing Partner')).toBe(true)
    })
  })

  describe('Real Apollo data patterns', () => {
    it('matches "CEO"', () => {
      expect(isDecisionMaker('CEO')).toBe(true)
    })

    it('matches "Managing Partner"', () => {
      expect(isDecisionMaker('Managing Partner')).toBe(true)
    })

    it('matches "Managing Director"', () => {
      expect(isDecisionMaker('Managing Director')).toBe(true)
    })

    it('matches "Principal Consultant"', () => {
      expect(isDecisionMaker('Principal Consultant')).toBe(true)
    })

    it('matches "Founder"', () => {
      expect(isDecisionMaker('Founder')).toBe(true)
    })

    it('matches "Owner"', () => {
      expect(isDecisionMaker('Owner')).toBe(true)
    })
  })

  describe('Edge cases', () => {
    it('handles null job_title', () => {
      expect(isDecisionMaker(null)).toBe(false)
    })

    it('handles empty string', () => {
      expect(isDecisionMaker('')).toBe(false)
    })

    it('handles whitespace only', () => {
      expect(isDecisionMaker('   ')).toBe(false)
    })
  })
})
