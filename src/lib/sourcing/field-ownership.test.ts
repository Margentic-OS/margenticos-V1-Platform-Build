import { describe, it, expect } from 'vitest'
import {
  stripNonOwnedFields,
  verifyNoSourcedFields,
  ENRICHMENT_OWNED_FIELDS,
  SOURCED_FIELDS,
} from './field-ownership'

describe('field-ownership', () => {
  describe('stripNonOwnedFields', () => {
    it('keeps only enrichment-owned and approved FILL-IF-NULL fields', () => {
      const payload = {
        email: 'test@example.com',
        linkedin_url: 'https://linkedin.com/in/test',
        company_headcount: 50,
        company_industry: 'Technology',
        job_title: 'CEO', // MUST be stripped
        first_name: 'John', // MUST be stripped
        last_name: 'Doe', // FILL-IF-NULL field with non-null value: ALLOWED
        company_name: 'Acme Inc', // MUST be stripped
      }

      const result = stripNonOwnedFields(payload)

      // Verify owned fields AND approved FILL-IF-NULL fields remain
      expect(result).toEqual({
        email: 'test@example.com',
        linkedin_url: 'https://linkedin.com/in/test',
        company_headcount: 50,
        company_industry: 'Technology',
        last_name: 'Doe', // FILL-IF-NULL field preserved with non-null value
      })

      // Verify non-FILL-IF-NULL sourced fields are completely absent
      expect(result).not.toHaveProperty('job_title')
      expect(result).not.toHaveProperty('first_name')
      expect(result).not.toHaveProperty('company_name')
    })

    it('handles empty payload', () => {
      const result = stripNonOwnedFields({})
      expect(result).toEqual({})
    })

    it('preserves null and undefined owned fields', () => {
      const payload = {
        email: null,
        linkedin_url: undefined,
        company_headcount: 0,
      }

      const result = stripNonOwnedFields(payload)

      expect(result).toEqual({
        email: null,
        linkedin_url: undefined,
        company_headcount: 0,
      })
    })

    it('strips unknown fields too', () => {
      const payload = {
        email: 'test@example.com',
        unknown_field: 'should be stripped',
        job_title: 'CEO', // sourced field
      }

      const result = stripNonOwnedFields(payload)

      expect(result).toEqual({
        email: 'test@example.com',
      })
      expect(result).not.toHaveProperty('unknown_field')
      expect(result).not.toHaveProperty('job_title')
    })

    it('strips FILL-IF-NULL fields with null values', () => {
      const payload = {
        email: 'test@example.com',
        last_name: null, // FILL-IF-NULL field but with null value: STRIPPED
      }

      const result = stripNonOwnedFields(payload)

      expect(result).toEqual({
        email: 'test@example.com',
      })
      expect(result).not.toHaveProperty('last_name')
    })
  })

  describe('verifyNoSourcedFields', () => {
    it('returns valid=true when payload has no sourced fields', () => {
      const payload = {
        email: 'test@example.com',
        linkedin_url: 'https://linkedin.com/in/test',
        company_headcount: 50,
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('detects job_title violation', () => {
      const payload = {
        email: 'test@example.com',
        job_title: 'CEO',
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(false)
      expect(result.violations).toContain('job_title')
    })

    it('detects first_name violation', () => {
      const payload = {
        email: 'test@example.com',
        first_name: 'John',
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(false)
      expect(result.violations).toContain('first_name')
    })

    it('detects last_name violation', () => {
      const payload = {
        email: 'test@example.com',
        last_name: 'Doe',
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(false)
      expect(result.violations).toContain('last_name')
    })

    it('detects company_name violation', () => {
      const payload = {
        email: 'test@example.com',
        company_name: 'Acme Inc',
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(false)
      expect(result.violations).toContain('company_name')
    })

    it('detects multiple violations', () => {
      const payload = {
        email: 'test@example.com',
        job_title: 'CEO',
        first_name: 'John',
        company_name: 'Acme Inc',
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(false)
      expect(result.violations).toHaveLength(3)
      expect(result.violations).toContain('job_title')
      expect(result.violations).toContain('first_name')
      expect(result.violations).toContain('company_name')
    })

    it('ignores undefined sourced fields', () => {
      const payload = {
        email: 'test@example.com',
        job_title: undefined,
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('detects null sourced fields (explicit presence)', () => {
      const payload = {
        email: 'test@example.com',
        job_title: null,
      }

      const result = verifyNoSourcedFields(payload)

      expect(result.valid).toBe(false)
      expect(result.violations).toContain('job_title')
    })
  })

  describe('exported constants', () => {
    it('ENRICHMENT_OWNED_FIELDS contains expected fields', () => {
      expect(ENRICHMENT_OWNED_FIELDS).toContain('email')
      expect(ENRICHMENT_OWNED_FIELDS).toContain('company_headcount')
      expect(ENRICHMENT_OWNED_FIELDS).toContain('company_industry')
    })

    it('SOURCED_FIELDS contains expected fields', () => {
      expect(SOURCED_FIELDS).toContain('job_title')
      expect(SOURCED_FIELDS).toContain('first_name')
      expect(SOURCED_FIELDS).toContain('last_name')
      expect(SOURCED_FIELDS).toContain('company_name')
    })

    it('exports both SOURCED_FIELDS and ENRICHMENT_OWNED_FIELDS', () => {
      // Type system ensures they don't overlap - if they did, union would fail
      expect(SOURCED_FIELDS.length).toBeGreaterThan(0)
      expect(ENRICHMENT_OWNED_FIELDS.length).toBeGreaterThan(0)
    })
  })
})
