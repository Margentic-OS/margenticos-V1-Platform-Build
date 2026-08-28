// tests/sourcing/adapter-apollo.test.ts
//
// Unit tests for Apollo sourcing handler.
// Tests adapter translation, seniority mapping, post-filtering, and pagination.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { apolloHandler, reportSpecDivergence } from '@/lib/sourcing/handlers/adapter-apollo'
import { logger } from '@/lib/logger'
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
//
// The Apollo search filter is hardcoded (see adapter-apollo.ts). These tests
// assert the filter is what was measured, and that no spec value can change it.
// The point of the second half is the 2026-08-24 incident: two German GmbHs were
// mailed because the exclusion lived in convention rather than in the query.

// A spec that asks for everything the hardcoded filter refuses. If any of these
// values can reach the Apollo request, the filter is not a filter.
const HOSTILE_SPEC: Record<string, unknown> = {
  job_titles: ['Founder', 'CEO'],
  job_titles_excluded: [],
  seniority_levels: ['entry', 'manager'],
  person_countries: ['DE', 'CA', 'AU', 'NL'],
  company_countries: ['DE', 'CA'],
  company_headcount_min: 500,
  company_headcount_max: 20000,
  industries: ['Software Publishers'],
  industries_excluded: [],
  keywords: ['consulting', 'advisory'],
  keywords_excluded: [],
  notes: '',
  company_revenue_min: 1000000,
  company_revenue_max: 10000000,
}

describe('apolloHandler.adapter', () => {
  it('sends the measured filter: NAICS 5416, keyword tags, 5-20, US/UK/IE, verified', () => {
    const request = apolloHandler.adapter({} as Record<string, unknown>)

    expect(request.organization_naics_codes).toEqual(['5416'])
    expect(request.q_organization_keyword_tags).toEqual([
      'management consulting',
      'business consulting',
      'strategy consulting',
    ])
    expect(request.organization_num_employees_ranges).toEqual(['5,20'])
    expect(request.organization_locations).toEqual([
      'united states',
      'united kingdom',
      'ireland',
    ])
    expect(request.person_locations).toEqual([
      'united states',
      'united kingdom',
      'ireland',
    ])
    expect(request.person_seniorities).toEqual(['owner', 'founder', 'c_suite', 'partner'])
    expect(request.contact_email_status).toEqual(['verified'])
  })

  it('includes c_suite and partner, because Apollo seniority is title-derived', () => {
    // In professional services the owner is usually titled Partner or Managing
    // Partner. owner+founder alone measured 29,139 against 72,458 with all four.
    const request = apolloHandler.adapter({} as Record<string, unknown>)

    expect(request.person_seniorities).toContain('partner')
    expect(request.person_seniorities).toContain('c_suite')
  })

  it('never sends q_keywords, which is AND over person and company names', () => {
    // The defect this replaced: q_keywords only ever matched firms with the
    // literal word in their name. q_organization_keyword_tags is the OR
    // parameter and the correct one for sourcing by category.
    const request = apolloHandler.adapter(HOSTILE_SPEC)

    expect(request).not.toHaveProperty('q_keywords')
    expect(request).toHaveProperty('q_organization_keyword_tags')
  })

  it('does not exclude NAICS 5418, and does not include it either', () => {
    // Firms carry more than one NAICS code, so a consultancy coded 5416 and 5418
    // is in scope and an exclusion would drop it. Adding 5418 to the include list
    // is a different query and measured 66,134 against the target 61,524.
    const request = apolloHandler.adapter({} as Record<string, unknown>)

    expect(request.organization_naics_codes).not.toContain('5418')
    expect(request).not.toHaveProperty('organization_naics_codes_excluded')
    expect(request.organization_naics_codes).toEqual(['5416'])
  })

  it('constrains WHERE THE PERSON IS, not just where the firm is registered', () => {
    // CASL attaches to the recipient. Filtering only on organization_locations
    // left 545 people in Canada and 238 in Germany reachable at in-scope US/UK/IE
    // firms, which is the same exposure as the two mailed GmbHs rather than a
    // smaller one. Both axes must be constrained, and to the same three countries.
    const request = apolloHandler.adapter(HOSTILE_SPEC)

    expect(request.person_locations).toEqual(request.organization_locations)
    expect(request.person_locations).toEqual([
      'united states',
      'united kingdom',
      'ireland',
    ])
  })

  it('cannot be made to source Germany or Canada by any spec value', () => {
    const request = apolloHandler.adapter(HOSTILE_SPEC)
    const serialised = JSON.stringify(request).toLowerCase()

    expect(request.organization_locations).not.toContain('germany')
    expect(request.organization_locations).not.toContain('canada')
    expect(request.person_locations).not.toContain('germany')
    expect(request.person_locations).not.toContain('canada')
    expect(serialised).not.toContain('germany')
    expect(serialised).not.toContain('canada')
    expect(serialised).not.toContain('"de"')
    expect(serialised).not.toContain('"ca"')
  })

  it('ignores every other spec field: titles, headcount, revenue, industries', () => {
    const request = apolloHandler.adapter(HOSTILE_SPEC)

    expect(request).not.toHaveProperty('person_titles')
    expect(request).not.toHaveProperty('revenue_range')
    expect(request.organization_num_employees_ranges).toEqual(['5,20'])
    // person_locations exists, but it is the hardcoded value rather than the
    // spec's person_countries, which asked for DE, CA, AU and NL.
    expect(request.person_locations).toEqual([
      'united states',
      'united kingdom',
      'ireland',
    ])
  })

  // ─── The divergence log ───────────────────────────────────────────────────
  //
  // These exist because the log used to be conditional on the spec naming a country
  // outside US/GB/IE. After ADR-032 set the spec defaults to GB/IE/US, that
  // condition is false for every new client, so the run that diverges on headcount,
  // industries, keywords, titles and revenue produced no line at all. The absence
  // read as 'nothing diverged'. It meant 'the one thing I test for is absent'.

  it('logs the divergence on EVERY run, including a spec that names no country', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    reportSpecDivergence({} as Record<string, unknown>)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('hardcoded filter in force')
    spy.mockRestore()
  })

  it('still logs when the spec countries agree with the filter, which is the gap', () => {
    // The exact shape that used to be silent: defaults in force, country test
    // passes, and four other fields are discarded without a word.
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    reportSpecDivergence({
      person_countries: ['GB', 'IE', 'US'],
      company_countries: ['GB', 'IE', 'US'],
      company_headcount_min: 500,
      company_headcount_max: 20000,
      industries: ['Software Publishers'],
      keywords: ['advisory'],
    } as Record<string, unknown>)

    expect(spy).toHaveBeenCalledTimes(1)
    const meta = spy.mock.calls[0][1] as Record<string, unknown>

    expect(meta.ignored_spec_countries).toEqual([])
    expect(meta.ignored_spec_fields).toEqual(
      expect.arrayContaining([
        'company_headcount_min',
        'company_headcount_max',
        'industries',
        'keywords',
      ]),
    )
    spy.mockRestore()
  })

  it('reports the headcount the filter actually sends, not the one the spec asked for', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    reportSpecDivergence(HOSTILE_SPEC)
    const meta = spy.mock.calls[0][1] as Record<string, unknown>

    expect(meta.filter_headcount_ranges).toEqual(['5,20'])
    expect(meta.ignored_spec_countries).toEqual(
      expect.arrayContaining(['DE', 'CA', 'AU', 'NL']),
    )
    spy.mockRestore()
  })

  it('does not report an unpopulated field, or a post-filtered one, as diverging', () => {
    // job_titles_excluded and keywords_excluded ARE honoured, as post-filters in
    // execute(). Reporting them would pad the list until the real ones stop showing.
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    reportSpecDivergence({
      job_titles: [],
      keywords: '',
      industries_excluded: null,
      job_titles_excluded: ['Intern'],
      keywords_excluded: ['recruiting'],
    } as Record<string, unknown>)

    const meta = spy.mock.calls[0][1] as Record<string, unknown>

    expect(meta.ignored_spec_fields).toEqual([])
    spy.mockRestore()
  })

  it('cannot be contaminated by a caller mutating a previous request', () => {
    // A shallow spread would share array instances with the module-level constant,
    // so this mutation would leak into every later client in the same process.
    const first = apolloHandler.adapter({} as Record<string, unknown>)
    first.organization_locations.push('germany')
    first.person_locations.push('canada')
    first.person_seniorities.push('entry')

    const second = apolloHandler.adapter({} as Record<string, unknown>)

    expect(second.organization_locations).toEqual([
      'united states',
      'united kingdom',
      'ireland',
    ])
    expect(second.person_locations).toEqual([
      'united states',
      'united kingdom',
      'ireland',
    ])
    expect(second.person_seniorities).toEqual(['owner', 'founder', 'c_suite', 'partner'])
  })

  it('returns an identical request for any two specs', () => {
    const fromEmpty = apolloHandler.adapter({} as Record<string, unknown>)
    const fromHostile = apolloHandler.adapter(HOSTILE_SPEC)

    expect({ ...fromHostile }).toEqual({ ...fromEmpty })
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

  it('extracts first_name, job_title, company_name from Apollo people', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => apolloFixture,
    })) as any

    const spec: ICPFilterSpec = {
      job_titles: ['Founder'],
      job_titles_excluded: [],
      seniority_levels: ['c_suite'],
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

    // apollo-001 should have name and job_title extracted from fixture
    const apollo001 = candidates.find(c => c.source_person_key === 'apollo:apollo-001')
    expect(apollo001).toBeDefined()
    expect(apollo001?.first_name).toBe('Sarah')
    expect(apollo001?.job_title).toBe('Founder')
    expect(apollo001?.company_name).toBe('Management Consulting Advisory')

    // All candidates should have source_person_key, most should have basic fields
    candidates.forEach(c => {
      expect(c.source_person_key).toMatch(/^apollo:/)
      // first_name and company_name should not be NULL on all rows (guard against empty-shell regression)
      if (c.first_name === null && c.company_name === null) {
        throw new Error(`Candidate ${c.source_person_key} is an empty shell (both first_name and company_name are NULL)`)
      }
    })
  })
})

// ─── Manifest tests ─────────────────────────────────────────────────────────


// ─── The divergence report fires once per RUN, not once per PAGE ─────────────
//
// This is the whole point of extracting reportSpecDivergence out of adapter(). adapter()
// is called inside the pagination loop; the log used to live inside it, so the single
// line saying "the client's stored spec was discarded" was emitted once per page, up to
// MAX_PAGES = 500 times. Its own volume was what made it noise.
//
// The assertion is on the COUNT, because that is the thing that regressed and the thing
// a future refactor could silently undo by moving the call back inside the loop.
describe('apolloHandler.execute - divergence report volume', () => {
  beforeEach(() => {
    process.env.APOLLO_API_KEY = 'test-key-fixture'
    vi.restoreAllMocks()
  })

  it('logs the divergence exactly once across a multi-page run', async () => {
    // Three full pages of 100, then a short page, which is what stops pagination.
    const full = {
      people: Array.from({ length: 100 }, (_, i) => ({
        id: `p${i}`,
        first_name: 'A',
        last_name_obfuscated: 'B',
        title: 'Founder',
        has_email: true,
        organization: { name: 'Acme' },
      })),
      total_entries: 350,
    }
    const short = { ...full, people: full.people.slice(0, 50) }

    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      return { ok: true, status: 200, json: async () => (call >= 4 ? short : full) }
    }) as never

    const infoSpy = vi.spyOn(logger, 'info')

    const spec: Record<string, unknown> = {
      job_titles: [], job_titles_excluded: [], seniority_levels: [],
      person_countries: ['DE'], company_countries: ['DE'],
      company_headcount_min: 1, company_headcount_max: 50,
      industries: [], industries_excluded: [], keywords: [], keywords_excluded: [],
      notes: '',
    }

    await apolloHandler.execute(spec)

    expect(call).toBeGreaterThan(1)  // guards itself: a single-page run proves nothing

    const divergenceLogs = infoSpy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('hardcoded filter in force'),
    )
    expect(divergenceLogs).toHaveLength(1)
  })
})

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

  it('still lists industries, now satisfied by the hardcoded NAICS + keyword tags', () => {
    expect(apolloHandler.supported_fields).toContain('industries')
  })
})
