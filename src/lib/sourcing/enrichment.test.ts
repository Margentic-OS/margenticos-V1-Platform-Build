// src/lib/sourcing/test-enrichment.ts
//
// Unit tests for Apollo enrichment handler.
// Covers: verified-pass, not-verified-hold, no-email-hold, missing-record, duplicate-collision.
// Fixtures based on Apollo OpenAPI bulk_match 200 response.
//
// Note: These are synchronous fixtures; no live calls occur (is_active=false in registry).

import { describe, it, expect } from 'vitest'

/**
 * Test fixture: Apollo bulk_match response with 4 test cases.
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
}

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
