// The data-minimisation boundary.
//
// These tests exist because the failure mode is not a crash. It is storing a prospect's
// home address and personal phone number, quietly, for people who have never heard of us,
// and only discovering it in a subject access request or a breach.
//
// We email the UK and Ireland. UK GDPR data minimisation requires keeping what the
// purpose needs, not everything the vendor returns.

import { describe, it, expect } from 'vitest'
import {
  buildApolloEnrichmentSubset,
  assertNoForbiddenFields,
  APOLLO_FORBIDDEN_FIELDS,
  APOLLO_PERSON_KEEP,
  APOLLO_ORG_KEEP,
} from '../apollo-enrichment-subset'

/** A realistic bulk_match person, using the exact field names the live probe returned. */
const fullMatch = () => ({
  id: 'apollo-1', first_name: 'Ada', last_name: 'Lovelace', name: 'Ada Lovelace',
  email: 'ada@example.com', email_status: 'verified', linkedin_url: 'https://li/in/ada',
  title: 'Founder', country: 'United Kingdom',
  seniority: 'founder', departments: ['operations'], subdepartments: ['ops'],
  functions: ['operations'], headline: 'Founder at Analytical Engines',
  organization_id: 'org-1',
  // Forbidden, all of it.
  street_address: '12 Privacy Lane', raw_address: '12 Privacy Lane, London',
  postal_code: 'SW1A 1AA', city: 'London', state: 'Greater London',
  formatted_address: '12 Privacy Lane, London SW1A 1AA', phone: '+44 7700 900000',
  photo_url: 'https://photos/ada.jpg', facebook_url: 'https://fb/ada',
  twitter_url: 'https://x/ada', github_url: 'https://gh/ada',
  employment_history: [{
    title: 'Founder', organization_name: 'Analytical Engines', organization_id: 'org-1',
    start_date: '2016-10-01', end_date: null, current: true, kind: 'employment',
    description: 'Runs the firm.',
    // Forbidden, nested.
    emails: ['ada@personal.example'], raw_address: '12 Privacy Lane, London',
  }],
  organization: {
    id: 'org-1', name: 'Analytical Engines', primary_domain: 'ae.com',
    estimated_num_employees: 12, industry: 'Management Consulting',
    founded_year: 2016, organization_revenue: 1000000,
    organization_headcount_six_month_growth: 11,
    organization_headcount_twelve_month_growth: 24,
    organization_headcount_twenty_four_month_growth: 40,
    industries: ['consulting'], secondary_industries: ['software'],
    naics_codes: ['541611'], sic_codes: ['8742'], keywords: ['operations'],
    linkedin_uid: '12345', linkedin_url: 'https://li/company/ae', website_url: 'https://ae.com',
    // Forbidden, org-level.
    street_address: '1 Office Park', city: 'London', state: 'Greater London',
    postal_code: 'EC1A 1BB', phone: '+44 20 7000 0000', raw_address: '1 Office Park, London',
    twitter_url: 'https://x/ae', facebook_url: 'https://fb/ae',
  },
})

describe('NOTHING FORBIDDEN SURVIVES', () => {
  it.each(APOLLO_FORBIDDEN_FIELDS)('drops %s at every nesting level', field => {
    const subset = buildApolloEnrichmentSubset(fullMatch())
    expect(JSON.stringify(subset)).not.toContain(`"${field}"`)
  })

  it('drops the home address, postcode and personal phone specifically', () => {
    const json = JSON.stringify(buildApolloEnrichmentSubset(fullMatch()))
    expect(json).not.toContain('12 Privacy Lane')
    expect(json).not.toContain('SW1A 1AA')
    expect(json).not.toContain('+44 7700 900000')
  })

  it('drops the emails array nested inside employment_history', () => {
    // The one that is easiest to miss, because the entry itself is wanted.
    const subset = buildApolloEnrichmentSubset(fullMatch()) as Record<string, any>
    expect(subset.employment_history[0]).not.toHaveProperty('emails')
    expect(subset.employment_history[0]).not.toHaveProperty('raw_address')
    expect(JSON.stringify(subset)).not.toContain('ada@personal.example')
  })

  it('drops org-level address and phone, not just person-level', () => {
    const subset = buildApolloEnrichmentSubset(fullMatch()) as Record<string, any>
    expect(subset.organization).not.toHaveProperty('street_address')
    expect(subset.organization).not.toHaveProperty('phone')
    expect(subset.organization).not.toHaveProperty('city')
  })

  it('is an ALLOW-LIST: a field Apollo adds later is dropped by default', () => {
    // The whole reason this is not a denylist-filtered copy.
    const withNewField = { ...fullMatch(), some_field_apollo_added_in_2027: 'sensitive' }
    expect(JSON.stringify(buildApolloEnrichmentSubset(withNewField)))
      .not.toContain('some_field_apollo_added_in_2027')
  })
})

describe('EVERYTHING APPROVED IS KEPT', () => {
  it('keeps employment_history, the field this whole change exists for', () => {
    const subset = buildApolloEnrichmentSubset(fullMatch()) as Record<string, any>
    expect(subset.employment_history).toHaveLength(1)
    expect(subset.employment_history[0]).toMatchObject({
      title: 'Founder', organization_name: 'Analytical Engines',
      start_date: '2016-10-01', current: true,
    })
  })

  it.each(['seniority', 'departments', 'subdepartments', 'functions', 'headline', 'organization_id'])(
    'keeps person field %s', field => {
      expect(buildApolloEnrichmentSubset(fullMatch())).toHaveProperty(field)
    })

  it.each(APOLLO_ORG_KEEP)('keeps organization field %s', field => {
    const subset = buildApolloEnrichmentSubset(fullMatch()) as Record<string, any>
    expect(subset.organization).toHaveProperty(field)
  })

  it('keeps the headcount growth figures, which are a dateable-shaped signal', () => {
    const subset = buildApolloEnrichmentSubset(fullMatch()) as Record<string, any>
    expect(subset.organization.organization_headcount_twelve_month_growth).toBe(24)
  })
})

describe('degrades safely', () => {
  it('returns null for null, undefined and non-objects', () => {
    expect(buildApolloEnrichmentSubset(null)).toBeNull()
    expect(buildApolloEnrichmentSubset(undefined)).toBeNull()
    expect(buildApolloEnrichmentSubset('nope' as never)).toBeNull()
  })

  it('returns null rather than an empty object when nothing survives', () => {
    // An empty object stored looks like data. null looks like the absence of it.
    expect(buildApolloEnrichmentSubset({ street_address: '12 Privacy Lane' })).toBeNull()
  })

  it('never throws, because it runs after the credit is spent', () => {
    const circular: Record<string, unknown> = { seniority: 'founder' }
    circular.self = circular
    expect(() => buildApolloEnrichmentSubset(circular)).not.toThrow()
  })

  it('handles a malformed employment_history without dropping the rest', () => {
    const m = { ...fullMatch(), employment_history: 'not an array' as never }
    const subset = buildApolloEnrichmentSubset(m) as Record<string, any>
    expect(subset).not.toHaveProperty('employment_history')
    expect(subset.seniority).toBe('founder')
  })
})

describe('assertNoForbiddenFields is the backstop for a careless allow-list edit', () => {
  it('throws on a forbidden field at the top level', () => {
    expect(() => assertNoForbiddenFields({ phone: '+44' })).toThrow(/Forbidden field "phone"/)
  })

  it('throws on one nested inside an array', () => {
    expect(() => assertNoForbiddenFields({ employment_history: [{ emails: ['x'] }] }))
      .toThrow(/Forbidden field "emails"/)
  })

  it('names the path so the offender is findable', () => {
    expect(() => assertNoForbiddenFields({ organization: { street_address: 'x' } }))
      .toThrow(/root\.organization\.street_address/)
  })

  it('passes a clean subset', () => {
    expect(() => assertNoForbiddenFields(buildApolloEnrichmentSubset(fullMatch()))).not.toThrow()
  })
})

describe('country is NOT in the subset', () => {
  it('is excluded, because it is written as a first-class column', () => {
    // A jurisdiction gate has to filter on it in a WHERE clause. Buried in jsonb it
    // cannot be indexed or queried cleanly, and this is the field whose absence let two
    // German companies into the C0 send.
    expect(buildApolloEnrichmentSubset(fullMatch())).not.toHaveProperty('country')
    expect(APOLLO_PERSON_KEEP).not.toContain('country' as never)
  })
})
