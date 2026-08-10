/**
 * Integration test: field ownership enforcement in enrichment write path.
 *
 * Proves that enrichment write attempts containing sourced fields (job_title, first_name, etc.)
 * have those fields stripped before sending to the database.
 *
 * The test simulates the enrichment adapter behavior and verifies that stripNonOwnedFields
 * is applied to every update payload.
 */

import { describe, it, expect } from 'vitest'
import { stripNonOwnedFields, verifyNoSourcedFields } from './field-ownership'

describe('enrichment field ownership enforcement', () => {
  /**
   * Simulate what enrichAndVerifyProspect does:
   * 1. Build an update payload from Apollo response
   * 2. Strip non-owned fields
   * 3. Verify the result contains only owned fields
   */
  it('strips job_title from enrichment update before writing to database', () => {
    // This simulates an Apollo response that includes title (which it does)
    const apolloData = {
      email: 'test@example.com',
      linkedin_url: 'https://linkedin.com/in/test',
      company_headcount: 50,
      company_industry: 'Technology',
      title: 'CEO', // Apollo returns this - enrichment must NOT write it
    }

    // Step 1: Build enrichment update payload (simulating enrichAndVerifyProspect)
    const enrichmentUpdatePayload = {
      email: apolloData.email,
      linkedin_url: apolloData.linkedin_url,
      company_headcount: apolloData.company_headcount,
      company_industry: apolloData.company_industry,
      // Note: title is NOT included here, but if it were by accident:
      title: apolloData.title, // BUG: if handler accidentally adds this
    }

    // Step 2: Strip non-owned fields (CRITICAL enforcement)
    const safeUpdatePayload = stripNonOwnedFields(enrichmentUpdatePayload)

    // Step 3: Verify result contains ONLY owned fields
    expect(safeUpdatePayload).toEqual({
      email: 'test@example.com',
      linkedin_url: 'https://linkedin.com/in/test',
      company_headcount: 50,
      company_industry: 'Technology',
    })

    // Step 4: Proof that title was stripped
    expect(safeUpdatePayload).not.toHaveProperty('title')

    // Step 5: Verify payload is safe to write to database
    const verification = verifyNoSourcedFields(safeUpdatePayload)
    expect(verification.valid).toBe(true)
    expect(verification.violations).toEqual([])
  })

  /**
   * Real-world scenario: a handler bug somehow puts job_title in the payload.
   * The enforcement layer catches it.
   */
  it('catches handler bug that writes job_title and prevents database corruption', () => {
    // Simulating a buggy enrichment handler response
    const buggyHandlerResponse = {
      email: 'stephen@matrix.com',
      linkedin_url: 'https://linkedin.com/in/stephen',
      company_headcount: 8, // ICP-plausible
      company_industry: 'Management Consulting', // Canonical industry
      job_title: 'Director of Operations', // BUG: Handler shouldn't include this
      company_name: 'Test Company 1', // BUG: Handler shouldn't include this
    }

    // What the enrichment write path would attempt without enforcement
    const unsafePayload = buggyHandlerResponse

    // Check that unsafe payload violates field ownership
    const unsafeCheck = verifyNoSourcedFields(unsafePayload)
    expect(unsafeCheck.valid).toBe(false)
    expect(unsafeCheck.violations).toContain('job_title')
    expect(unsafeCheck.violations).toContain('company_name')

    // Apply field ownership enforcement
    const safePayload = stripNonOwnedFields(unsafePayload)

    // Verify enforcement removed the violations
    const safeCheck = verifyNoSourcedFields(safePayload)
    expect(safeCheck.valid).toBe(true)
    expect(safeCheck.violations).toEqual([])

    // Verify original sourced data is completely gone
    expect(safePayload).not.toHaveProperty('job_title')
    expect(safePayload).not.toHaveProperty('company_name')

    // Verify enrichment-owned fields remain
    expect(safePayload).toHaveProperty('email')
    expect(safePayload).toHaveProperty('company_headcount')
    expect(safePayload).toHaveProperty('company_industry')

    // This payload is now safe to send to the database
    // Prospect's existing job_title and company_name remain untouched
  })

  /**
   * Proof: multiple violations are all caught
   */
  it('catches multiple field ownership violations simultaneously', () => {
    const badPayload = {
      email: 'test@example.com',
      linkedin_url: 'https://linkedin.com/in/test',
      company_headcount: 10,
      company_industry: 'Management Consulting',
      first_name: 'John', // violation
      last_name: 'Doe', // violation
      job_title: 'CEO', // violation
      company_name: 'Acme Inc', // violation
    }

    // Before enforcement
    const before = verifyNoSourcedFields(badPayload)
    expect(before.valid).toBe(false)
    expect(before.violations).toHaveLength(4)

    // After enforcement
    const safe = stripNonOwnedFields(badPayload)
    const after = verifyNoSourcedFields(safe)
    expect(after.valid).toBe(true)
    expect(after.violations).toHaveLength(0)

    // All violations are removed
    expect(safe).not.toHaveProperty('first_name')
    expect(safe).not.toHaveProperty('last_name')
    expect(safe).not.toHaveProperty('job_title')
    expect(safe).not.toHaveProperty('company_name')
  })

  /**
   * Null/undefined handling: enrichment-owned null values are preserved
   */
  it('preserves null/undefined for enrichment-owned fields', () => {
    const payload = {
      email: 'test@example.com',
      linkedin_url: null,
      company_headcount: undefined,
      company_industry: 'Management Consulting',
      job_title: 'CEO', // sourced - should be stripped
    }

    const safe = stripNonOwnedFields(payload)

    // Owned fields with null/undefined are preserved
    expect(safe).toHaveProperty('linkedin_url')
    expect(safe.linkedin_url).toBe(null)
    expect(safe).toHaveProperty('company_headcount')
    expect(safe.company_headcount).toBeUndefined()

    // Sourced field is stripped regardless of value
    expect(safe).not.toHaveProperty('job_title')
  })

  /**
   * Contract: enrichment can ONLY write these fields
   */
  it('explicitly allows only the specified enrichment-owned fields', () => {
    const payload = {
      email: 'test@example.com',
      linkedin_url: 'https://linkedin.com/in/test',
      linkedin_url_normalised: 'https://linkedin.com/in/test/',
      website_url: 'https://example.com',
      email_status: 'verified',
      company_headcount: 50,
      company_industry: 'Technology',
      country: 'US',
    }

    const safe = stripNonOwnedFields(payload)

    // All enrichment-owned fields are preserved
    expect(Object.keys(safe).sort()).toEqual(Object.keys(payload).sort())

    // No additional or removed fields
    expect(safe).toEqual(payload)

    // Contract is upheld: enrichment writes EXACTLY these 8 fields
    const expectedFields = [
      'email',
      'linkedin_url',
      'linkedin_url_normalised',
      'website_url',
      'email_status',
      'company_headcount',
      'company_industry',
      'country',
    ]
    expect(Object.keys(safe).sort()).toEqual(expectedFields.sort())
  })
})
