import { describe, it, expect } from 'vitest'
import { checkSendEligibility } from '../send-eligibility-rules'

describe('send-eligibility-rules', () => {
  describe('checkSendEligibility', () => {
    it('should allow US prospects', () => {
      const result = checkSendEligibility('US', 'john@example.com')
      expect(result.is_eligible).toBe(true)
      expect(result.reason).toBeNull()
    })

    it('should exclude Germany (DE country)', () => {
      const result = checkSendEligibility('DE', 'daniel@example.de')
      expect(result.is_eligible).toBe(false)
      expect(result.reason).toBe('country_excluded_de')
    })

    it('should exclude .de domain when country is null', () => {
      const result = checkSendEligibility(null, 'daniel@craid.de')
      expect(result.is_eligible).toBe(false)
      expect(result.reason).toBe('country_excluded_de')
    })

    it('should allow non-DE domains when country is null', () => {
      const result = checkSendEligibility(null, 'john@example.com')
      expect(result.is_eligible).toBe(true)
      expect(result.reason).toBeNull()
    })

    it('should allow .de domain if country explicitly US', () => {
      const result = checkSendEligibility('US', 'john@example.de')
      expect(result.is_eligible).toBe(true)
      expect(result.reason).toBeNull()
    })

    it('should handle null email', () => {
      const result = checkSendEligibility(null, null)
      expect(result.is_eligible).toBe(true)
      expect(result.reason).toBeNull()
    })

    it('should handle emails with multiple @ symbols (take last domain)', () => {
      const result = checkSendEligibility(null, 'name+alias@domain.de')
      expect(result.is_eligible).toBe(false)
      expect(result.reason).toBe('country_excluded_de')
    })
  })
})
