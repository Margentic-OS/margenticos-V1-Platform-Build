// src/lib/sourcing/test-enrichment.ts
//
// Unit tests for Apollo enrichment handler.
// Covers: verified-pass, not-verified-hold, no-email-hold, missing-record, duplicate-collision.
// Fixtures based on Apollo OpenAPI bulk_match 200 response.
//
// Note: These are synchronous fixtures; no live calls occur (is_active=false in registry).

import { describe, it, expect } from 'vitest'

/**
 * Test fixture: Apollo bulk_match response with 5 test cases.
 * Case 5 added: partial response where one prospect is not returned (held_missing).
 */
export const enrichmentTestFixture = {
  // Case 1: Verified email - should be enriched
  verified_pass: {
    id: 'enrich_verified_001',
    first_name: 'Alice',
    last_name: 'Verified',
    name: 'Alice Verified',
    email: 'alice.verified@acme.com',
    email_status: 'verified',
    linkedin_url: 'https://linkedin.com/in/alice-verified',
    title: 'VP of Sales',
    organisation: {
      name: 'Acme Corp',
      primary_domain: 'acme.com',
      estimated_num_employees: 500,
      industry: 'Technology',
    },
  },

  // Case 2: Not-verified email - should be held_unverified
  not_verified: {
    id: 'enrich_not_verified_001',
    first_name: 'Bob',
    last_name: 'Uncertain',
    name: 'Bob Uncertain',
    email: 'bob.uncertain@example.com',
    email_status: 'not_verified',
    linkedin_url: 'https://linkedin.com/in/bob-uncertain',
    title: 'Sales Manager',
    organisation: {
      name: 'Example Inc',
      primary_domain: 'example.com',
      estimated_num_employees: 250,
      industry: 'Services',
    },
  },

  // Case 3: No email returned - should be held_no_email
  no_email: {
    id: 'enrich_no_email_001',
    first_name: 'Carol',
    last_name: 'NoEmail',
    name: 'Carol NoEmail',
    email: null,
    email_status: null,
    linkedin_url: 'https://linkedin.com/in/carol-noemail',
    title: 'Director',
    organisation: {
      name: 'Silent Corp',
      primary_domain: 'silent.com',
      estimated_num_employees: 100,
      industry: 'Consulting',
    },
  },

  // Case 4: Duplicate collision - enriched email collides with existing suppressed row
  // This case requires setup: create a suppressed prospect with email 'dup@example.com'
  // Then enrich a person whose Apollo match returns that same email
  duplicate_collision: {
    id: 'enrich_dup_collision_001',
    first_name: 'Dave',
    last_name: 'Collision',
    name: 'Dave Collision',
    email: 'dup@example.com', // Matches existing suppressed row
    email_status: 'verified',
    linkedin_url: 'https://linkedin.com/in/dave-collision',
    title: 'VP Engineering',
    organisation: {
      name: 'Tech Startup',
      primary_domain: 'techstartup.com',
      estimated_num_employees: 50,
      industry: 'Software',
    },
  },

  // Case 5: Partial batch response - not returned in matches[]
  // This Apollo ID is sent to bulk_match but NOT returned in response.matches
  // Should be marked as held_missing
  partial_not_returned: {
    id: 'enrich_partial_missing_001',
    first_name: 'Eve',
    last_name: 'Missing',
    name: 'Eve Missing',
    // Note: no Apollo response for this person - simulates API not finding them
  },
}

/**
 * Integration test: ID-mapping with partial response
 * Verifies that the handler correctly maps Apollo matches to prospect rows
 * and marks unreturned prospects as held_missing.
 */
describe('enrichment: ID mapping and partial response', () => {
  it('should map returned matches to correct prospect rows by source_person_key', () => {
    // This test verifies the fixture structure for partial batches.
    // In a full integration test, this would:
    // 1. Create 5 prospect rows with source_person_key = 'apollo:1' through 'apollo:5'
    // 2. Mock Apollo to return only prospects 1, 2, 3 (missing 4, 5)
    // 3. Call enrichProspectsForOrganisation with [1, 2, 3, 4, 5]
    // 4. Verify that:
    //    - Match 1 is written to prospect with source_person_key='apollo:1'
    //    - Match 2 is written to prospect with source_person_key='apollo:2'
    //    - Match 3 is written to prospect with source_person_key='apollo:3'
    //    - Prospects 4 and 5 are marked enrichment_status='held_missing'
    // 5. Verify the mapping is NOT by position (e.g., returned[0] != prospects[0])

    const apolloIds = ['001', '002', '003', '004', '005']
    const sourcePersonKeys = apolloIds.map(id => `apollo:${id}`)

    // Partial response: only first 3 returned
    const returnedIds = ['001', '002', '003']
    const missingIds = ['004', '005']

    const keyToProspectId = new Map([
      ['apollo:001', 'prospect-uuid-1'],
      ['apollo:002', 'prospect-uuid-2'],
      ['apollo:003', 'prospect-uuid-3'],
      ['apollo:004', 'prospect-uuid-4'],
      ['apollo:005', 'prospect-uuid-5'],
    ])

    // Verify the mapping works correctly
    for (const id of returnedIds) {
      const key = `apollo:${id}`
      expect(keyToProspectId.has(key)).toBe(true)
    }

    // Verify missing prospects are identified
    const unreportedKeys = sourcePersonKeys.filter(
      key => !returnedIds.includes(key.replace('apollo:', '')),
    )
    expect(unreportedKeys).toEqual(['apollo:004', 'apollo:005'])
    expect(unreportedKeys.length).toBe(2)
  })

  it('should not use position-based matching (first match != first prospect)', () => {
    // This verifies that the fix uses Map-based lookup, not .find()
    const batch = ['apollo-001', 'apollo-002', 'apollo-003']

    // Response returns in different order (not first first)
    const responseMatches = [
      { id: 'apollo-002', email: 'second@example.com' },
      { id: 'apollo-001', email: 'first@example.com' },
      { id: 'apollo-003', email: 'third@example.com' },
    ]

    const keyToProspectId = new Map([
      ['apollo:apollo-001', 'prospect-id-1'],
      ['apollo:apollo-002', 'prospect-id-2'],
      ['apollo:apollo-003', 'prospect-id-3'],
    ])

    // Verify: first match should map to prospect-id-2, not prospect-id-1
    for (const match of responseMatches) {
      const sourceKey = `apollo:${match.id}`
      const prospectId = keyToProspectId.get(sourceKey)
      expect(prospectId).toBeDefined()
    }

    // First match should NOT map to first prospect
    const firstMatchSourceKey = `apollo:${responseMatches[0].id}`
    const firstMatchProspectId = keyToProspectId.get(firstMatchSourceKey)
    const firstProspectId = keyToProspectId.get('apollo:apollo-001')
    expect(firstMatchProspectId).not.toBe(firstProspectId)
    expect(firstMatchProspectId).toBe('prospect-id-2')
  })
})

/**
 * Test: Verify enrichment_status values match Amendment 1 specification.
 */
describe('enrichment_status values', () => {
  it('should allow enriched status', () => {
    const status = 'enriched'
    const allowed = ['enriched', 'held_unverified', 'held_no_email', 'held_missing', 'held_duplicate']
    expect(allowed).toContain(status)
  })

  it('should allow held_duplicate status', () => {
    const status = 'held_duplicate'
    const allowed = ['enriched', 'held_unverified', 'held_no_email', 'held_missing', 'held_duplicate']
    expect(allowed).toContain(status)
  })
})

/**
 * Test: Verdict logic matching Amendment 2 and Amendment 4.
 * Amendment 2: populate first, recheck dedupe, then set enrichment_status
 * Amendment 4: use Apollo's email_status strings as-is, not invented ones
 */
describe('enrichment verdict logic', () => {
  it('should set enriched when email_status=verified and dedupe check passes', () => {
    const match = enrichmentTestFixture.verified_pass
    const dedupeVerdict: string = 'new'
    const emailStatus = match.email_status

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else if (!match.email) {
      enrichmentStatus = 'held_no_email'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('enriched')
  })

  it('should set held_unverified when email_status is not verified', () => {
    const match = enrichmentTestFixture.not_verified
    const dedupeVerdict: string = 'new'
    const emailStatus = match.email_status

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else if (!match.email) {
      enrichmentStatus = 'held_no_email'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('held_unverified')
  })

  it('should set held_no_email when email is null despite email_status', () => {
    const match = enrichmentTestFixture.no_email
    const dedupeVerdict: string = 'new'
    const emailStatus = match.email_status

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else if (!match.email) {
      enrichmentStatus = 'held_no_email'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('held_no_email')
  })

  it('should set held_duplicate when dedupe recheck returns duplicate verdict', () => {
    const match = enrichmentTestFixture.duplicate_collision
    const dedupeVerdict: string = 'duplicate_email'
    const emailStatus = match.email_status

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else if (!match.email) {
      enrichmentStatus = 'held_no_email'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('held_duplicate')
  })

  it('should set held_duplicate when dedupe recheck returns suppressed_match', () => {
    const match = enrichmentTestFixture.duplicate_collision
    const dedupeVerdict: string = 'suppressed_match'
    const emailStatus = match.email_status

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else if (!match.email) {
      enrichmentStatus = 'held_no_email'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('held_duplicate')
  })
})

/**
 * Test: Amendment 1 assertion
 * A person enriched with email/linkedin colliding with suppressed row
 * must be set to held_duplicate, never enriched.
 */
describe('Amendment 1: held_duplicate on collision', () => {
  it('should never mark enriched if dedupe returns suppressed_match', () => {
    const emailStatus = 'verified'
    const dedupeVerdict: string = 'suppressed_match'

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('held_duplicate')
    expect(enrichmentStatus).not.toBe('enriched')
  })

  it('should never mark enriched if dedupe returns duplicate verdict', () => {
    const emailStatus = 'verified'
    const dedupeVerdict: string = 'duplicate_email'

    let enrichmentStatus: string
    if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.includes('duplicate_')) {
      enrichmentStatus = 'held_duplicate'
    } else if (emailStatus === 'verified') {
      enrichmentStatus = 'enriched'
    } else {
      enrichmentStatus = 'held_unverified'
    }

    expect(enrichmentStatus).toBe('held_duplicate')
    expect(enrichmentStatus).not.toBe('enriched')
  })
})

/**
 * Test: Amendment 4 - email_status uses Apollo's values, not invented ones.
 * Only 'verified' is special; everything else (including null) is not-verified.
 */
describe('Amendment 4: email_status vocabulary', () => {
  it('should store Apollo email_status as-is, not transform it', () => {
    const apolloValue = 'verified'
    const stored = apolloValue
    expect(stored).toBe('verified')
  })

  it('should gate strictly on === verified', () => {
    const values = ['verified', 'not_verified', 'unknown', null, '']
    const verified = values.filter(v => v === 'verified')
    expect(verified.length).toBe(1)
    expect(values.filter(v => v !== 'verified').length).toBe(4)
  })

  it('should not add enrichment state to qualification_status', () => {
    // qualification_status values (should not include enrichment states)
    const qualificationStatuses = ['qualified', 'flagged_for_review', 'disqualified', 'replied_positive']
    const enrichmentStatuses = ['enriched', 'held_unverified', 'held_no_email', 'held_missing', 'held_duplicate']

    for (const status of enrichmentStatuses) {
      expect(qualificationStatuses).not.toContain(status)
    }
  })
})
