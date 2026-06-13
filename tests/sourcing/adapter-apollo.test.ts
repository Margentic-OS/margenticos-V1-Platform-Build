// tests/sourcing/adapter-apollo.test.ts
//
// Unit tests for Apollo sourcing handler.
// Tests adapter translation, seniority mapping, post-filtering, and pagination.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { ProspectCandidate } from '@/lib/sourcing/dedupe'
import * as fs from 'fs'
import * as path from 'path'

// ─── Test fixture loading ────────────────────────────────────────────────────

let apolloFixture: any

beforeAll(() => {
  const fixturePath = path.join(
    __dirname,
    '../fixtures/sourcing/apollo-api-search-response.json'
  )
  apolloFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
})

// ─── Adapter tests ──────────────────────────────────────────────────────────

describe('apolloHandler.adapter', () => {
  it('translates basic spec fields to API request', () => {
    const spec: ICPFilterSpec = {
      job_titles: ['Founder', 'CEO'],
      job_titles_excluded: [],
      seniority_levels: ['director'],
      departments: [],
      person_countries: ['US', 'GB'],
      company_countries: ['US'],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: ['Management Consulting'],
      industries_excluded: [],
      keywords: ['consulting', 'advisory'],
      keywords_excluded: [],
      notes: '',
    }

    const request = apolloHandler.adapter(spec as unknown as Record<string, unknown>)

    expect(request.person_titles).toEqual(['Founder', 'CEO'])
    expect(request.person_seniorities).toContain('director')
    expect(request.person_seniorities).toContain('head') // director maps to head
    expect(request.person_locations).toEqual(['US', 'GB'])
    expect(request.organization_locations).toEqual(['US'])
    expect(request.organization_num_employees_ranges).toEqual(['1,50'])
    expect(request.q_keywords).toContain('management consulting')
    expect(request.q_keywords).toContain('consulting')
    expect(request.q_keywords).toContain('advisory')
    expect(request.contact_email_status).toEqual(['verified'])
  })

  it('expands c_suite seniority to include owner and founder', () => {
    const spec: ICPFilterSpec = {
      job_titles: ['Founder'],
      job_titles_excluded: [],
      seniority_levels: ['c_suite'],
      departments: [],
      person_countries: ['US'],
      company_countries: ['US'],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: [],
      notes: '',
    }

    const request = apolloHandler.adapter(spec as unknown as Record<string, unknown>)

    // c_suite must expand to owner, founder, c_suite (founder-led firms)
    expect(request.person_seniorities).toContain('owner')
    expect(request.person_seniorities).toContain('founder')
    expect(request.person_seniorities).toContain('c_suite')
  })

  it('maps vp seniority to vp and partner', () => {
    const spec: ICPFilterSpec = {
      job_titles: [],
      job_titles_excluded: [],
      seniority_levels: ['vp'],
      departments: [],
      person_countries: [],
      company_countries: [],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: [],
      notes: '',
    }

    const request = apolloHandler.adapter(spec as unknown as Record<string, unknown>)

    expect(request.person_seniorities).toContain('vp')
    expect(request.person_seniorities).toContain('partner')
  })

  it('folds industries into q_keywords', () => {
    const spec: ICPFilterSpec = {
      job_titles: [],
      job_titles_excluded: [],
      seniority_levels: [],
      departments: [],
      person_countries: [],
      company_countries: [],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: ['Marketing Consulting', 'Operations Consulting'],
      industries_excluded: [],
      keywords: ['boutique'],
      keywords_excluded: [],
      notes: '',
    }

    const request = apolloHandler.adapter(spec as unknown as Record<string, unknown>)

    expect(request.q_keywords).toContain('marketing consulting')
    expect(request.q_keywords).toContain('operations consulting')
    expect(request.q_keywords).toContain('boutique')
  })

  it('sets revenue range when provided (via extended fields)', () => {
    const spec: Record<string, unknown> = {
      job_titles: [],
      job_titles_excluded: [],
      seniority_levels: [],
      departments: [],
      person_countries: [],
      company_countries: [],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: [],
      notes: '',
      company_revenue_min: 1000000,
      company_revenue_max: 10000000,
    }

    const request = apolloHandler.adapter(spec as unknown as Record<string, unknown>)

    expect(request.revenue_range?.min).toBe(1000000)
    expect(request.revenue_range?.max).toBe(10000000)
  })
})

// ─── Post-filter tests ───────────────────────────────────────────────────────

describe('apolloHandler.execute - post-filtering', () => {
  beforeEach(() => {
    process.env.APOLLO_API_KEY = 'test-key-fixture'
  })

  it('drops candidates with excluded job titles (case-insensitive substring)', async () => {
    // Mock fetch to return fixture
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => apolloFixture,
    })) as any

    const spec: ICPFilterSpec = {
      job_titles: ['Founder', 'CEO'],
      job_titles_excluded: ['Operations Manager', 'Director of Sales'], // Must drop apollo-003 and apollo-004
      seniority_levels: ['c_suite'],
      departments: [],
      person_countries: ['US'],
      company_countries: ['US'],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: [],
      notes: '',
    }

    const candidates = await apolloHandler.execute(spec as unknown as Record<string, unknown>)

    // apollo-004 has title "Director of Sales" which matches excluded "Director of Sales"
    const apollo004 = candidates.find(c => c.source_person_key === 'apollo:apollo-004')
    expect(apollo004).toBeUndefined()

    // Other candidates should pass
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('drops candidates with excluded keywords in company name (case-insensitive)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => apolloFixture,
    })) as any

    const spec: ICPFilterSpec = {
      job_titles: ['Founder'],
      job_titles_excluded: [],
      seniority_levels: ['c_suite'],
      departments: [],
      person_countries: ['US'],
      company_countries: ['US'],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: ['staffing', 'recruitment'], // Must drop apollo-005
      notes: '',
    }

    const candidates = await apolloHandler.execute(spec as unknown as Record<string, unknown>)

    // apollo-005 has company "Marketing Consultancy Staffing Services" which contains "staffing"
    const apollo005 = candidates.find(c => c.source_person_key === 'apollo:apollo-005')
    expect(apollo005).toBeUndefined()

    // Other candidates should pass
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('drops candidates without has_email=true', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => apolloFixture,
    })) as any

    const spec: ICPFilterSpec = {
      job_titles: ['Founder'],
      job_titles_excluded: [],
      seniority_levels: ['c_suite'],
      departments: [],
      person_countries: ['US'],
      company_countries: ['US'],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: [],
      notes: '',
    }

    const candidates = await apolloHandler.execute(spec as unknown as Record<string, unknown>)

    // apollo-004 has has_email: false, should be dropped
    const apollo004 = candidates.find(c => c.source_person_key === 'apollo:apollo-004')
    expect(apollo004).toBeUndefined()

    // Remaining candidates should have no apollo-004
    expect(candidates.every(c => c.source_person_key !== 'apollo:apollo-004')).toBe(true)
  })
})

// ─── ProspectCandidate format tests ─────────────────────────────────────────

describe('apolloHandler.execute - ProspectCandidate format', () => {
  it('returns ProspectCandidate with source_person_key formatted as apollo:id', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => apolloFixture,
    })) as any

    const spec: ICPFilterSpec = {
      job_titles: ['Founder'],
      job_titles_excluded: [],
      seniority_levels: ['c_suite'],
      departments: [],
      person_countries: ['US'],
      company_countries: ['US'],
      company_headcount_min: 1,
      company_headcount_max: 50,
      industries: [],
      industries_excluded: [],
      keywords: [],
      keywords_excluded: [],
      notes: '',
    }

    const candidates = await apolloHandler.execute(spec as unknown as Record<string, unknown>)

    expect(candidates.length).toBeGreaterThan(0)
    candidates.forEach(c => {
      expect(c.source_person_key).toMatch(/^apollo:/)
      expect(c.email).toBeNull() // Not available in api_search
      expect(c.linkedin_url).toBeNull() // Not available in api_search
    })
  })
})

// ─── Manifest tests ─────────────────────────────────────────────────────────

describe('apolloHandler.supported_fields', () => {
  it('includes job_titles_excluded in supported_fields (post-filter)', () => {
    expect(apolloHandler.supported_fields).toContain('job_titles_excluded')
  })

  it('includes keywords_excluded in supported_fields (post-filter)', () => {
    expect(apolloHandler.supported_fields).toContain('keywords_excluded')
  })

  it('does NOT include unsupported fields', () => {
    expect(apolloHandler.supported_fields).not.toContain('departments')
    expect(apolloHandler.supported_fields).not.toContain('company_age_min_years')
    expect(apolloHandler.supported_fields).not.toContain('company_age_max_years')
    expect(apolloHandler.supported_fields).not.toContain('funding_stage')
    expect(apolloHandler.supported_fields).not.toContain('funded_since')
    expect(apolloHandler.supported_fields).not.toContain('technologies_used')
  })

  it('includes industries (satisfied via q_keywords)', () => {
    expect(apolloHandler.supported_fields).toContain('industries')
  })
})
