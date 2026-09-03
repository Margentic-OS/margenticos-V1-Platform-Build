// tests/sourcing/adapter-apollo.test.ts
//
// Unit tests for Apollo sourcing handler.
// Tests adapter translation, seniority mapping, post-filtering, and pagination.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import {
  apolloHandler,
  reportSpecDivergence,
  buildApolloRequest,
  SPEC_FIELD_HANDLING,
} from '@/lib/sourcing/handlers/adapter-apollo'
import { FILTER_SPEC_FIELDS } from '@/lib/agents/icp-filter-spec'
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
// The Apollo search is now BUILT FROM THE CLIENT'S SPEC. These tests assert that each
// spec field reaches the parameter it is supposed to, that a spec the handler cannot
// honour THROWS rather than degrading, and that the manifest describes what is actually
// sent.
//
// Rule Zero applies to fixtures too. The specs below use canonical industry names,
// because those are values the production type demands, but the job titles are abstract
// tokens: a real title in a test fixture is one copy-paste away from a real title in a
// default.

function baseSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_titles: ['role-a', 'role-b'],
    job_titles_excluded: [],
    seniority_levels: [],
    person_countries: ['GB'],
    company_countries: ['GB'],
    company_headcount_min: 5,
    company_headcount_max: 20,
    industries: ['Management Consulting'],
    industries_excluded: [],
    keywords: [],
    keywords_excluded: [],
    notes: '',
    ...over,
  }
}

describe('apolloHandler.adapter: the query is built from the spec', () => {
  it('translates industries to NAICS codes through the handler-owned table', () => {
    const request = apolloHandler.adapter(
      baseSpec({ industries: ['Management Consulting', 'Primary and Secondary Education'] }),
    )
    expect(request.organization_naics_codes).toEqual(['5416', '6111'])
  })

  it('sends job titles as person_titles, which is what makes it a people search', () => {
    const request = apolloHandler.adapter(baseSpec({ job_titles: ['role-a', 'role-c'] }))
    expect(request.person_titles).toEqual(['role-a', 'role-c'])
  })

  it('pairs the headcount bounds into one Apollo range string', () => {
    const request = apolloHandler.adapter(
      baseSpec({ company_headcount_min: 8, company_headcount_max: 30 }),
    )
    expect(request.organization_num_employees_ranges).toEqual(['8,30'])
  })

  it('translates ISO country codes to Apollo place names, on BOTH axes', () => {
    const request = apolloHandler.adapter(
      baseSpec({ person_countries: ['GB', 'IE'], company_countries: ['US'] }),
    )
    expect(request.person_locations).toEqual(['united kingdom', 'ireland'])
    expect(request.organization_locations).toEqual(['united states'])
  })

  // TWO DIFFERENT CLIENTS, ONE ASSERTION. This is the test that fails if the query goes
  // back to being a constant: a constant returns the same NAICS code for both.
  it('sends a different query for a different client', () => {
    const consulting = apolloHandler.adapter(baseSpec())
    const schools = apolloHandler.adapter(
      baseSpec({
        industries: ['Primary and Secondary Education'],
        job_titles: ['role-x'],
        company_headcount_min: 8,
        company_headcount_max: 30,
      }),
    )
    expect(consulting.organization_naics_codes).not.toEqual(schools.organization_naics_codes)
    expect(consulting.person_titles).not.toEqual(schools.person_titles)
    expect(consulting.organization_num_employees_ranges)
      .not.toEqual(schools.organization_num_employees_ranges)
  })

  it('always constrains email status, which is data quality rather than targeting', () => {
    expect(apolloHandler.adapter(baseSpec()).contact_email_status).toEqual(['verified'])
  })

  // ─── Optional parameters are OMITTED, never defaulted ─────────────────────
  //
  // An omitted parameter is Apollo's own no-constraint. A defaulted one is this handler
  // having an opinion about a client's market, which is the defect being removed.

  it('omits keyword tags and seniorities when the spec is silent', () => {
    const request = apolloHandler.adapter(baseSpec())
    expect(request.q_organization_keyword_tags).toBeUndefined()
    expect(request.person_seniorities).toBeUndefined()
  })

  it('sends keyword tags and seniorities when the spec populates them', () => {
    const request = apolloHandler.adapter(
      baseSpec({ keywords: ['management consulting'], seniority_levels: ['owner'] }),
    )
    expect(request.q_organization_keyword_tags).toEqual(['management consulting'])
    expect(request.person_seniorities).toEqual(['owner'])
  })

  it('excludes an industry as a negative NAICS code', () => {
    const request = apolloHandler.adapter(
      baseSpec({ industries_excluded: ['Legal Services'] }),
    )
    expect(request.not_organization_naics_codes).toEqual(['5411'])
  })

  // A client naming the same NAICS parent in both lists would cancel its own search to
  // zero, and a zero result reads as "no such prospects exist".
  it('never excludes a NAICS code the include list also relies on', () => {
    const request = apolloHandler.adapter(
      baseSpec({
        industries: ['Management Consulting'],
        industries_excluded: ['Strategy Consulting'],   // also 5416
      }),
    )
    expect(request.not_organization_naics_codes).toBeUndefined()
  })

  // ─── Refusing is the feature ───────────────────────────────────────────────
  //
  // Every case below is one the previous hardcoded handler served by sourcing the wrong
  // population and reporting success.

  it.each([
    ['a null spec', null],
    ['a spec with no industries', { industries: [] }],
    ['a spec with no job titles', { job_titles: [] }],
    ['a spec with no person countries', { person_countries: [] }],
    ['a spec with no company countries', { company_countries: [] }],
    ['an inverted headcount range', { company_headcount_min: 50, company_headcount_max: 5 }],
  ])('throws on %s rather than sourcing something else', (_label, over) => {
    const spec = over === null ? null : baseSpec(over as Record<string, unknown>)
    expect(() => apolloHandler.adapter(spec as never)).toThrow(/Apollo sourcing failed/)
  })

  it('throws on a canonical industry with no registered NAICS code, naming it', () => {
    expect(() =>
      apolloHandler.adapter(baseSpec({ industries: ['Not A Real Industry'] })),
    ).toThrow(/Not A Real Industry/)
  })

  it('throws on a country code with no registered Apollo location name', () => {
    expect(() => apolloHandler.adapter(baseSpec({ person_countries: ['ZZ'] })))
      .toThrow(/ZZ/)
  })

  // The 2026-08-24 incident: two German GmbHs were mailed because the exclusion lived in
  // convention rather than in the query. It REFUSES rather than quietly dropping, because
  // a client expecting those countries and silently not getting them is a conversation.
  it.each([['DE'], ['CA']])('refuses %s outright rather than dropping it silently', code => {
    expect(() => apolloHandler.adapter(baseSpec({ company_countries: [code] })))
      .toThrow(/legal grounds/)
    expect(() => apolloHandler.adapter(baseSpec({ person_countries: [code] })))
      .toThrow(/legal grounds/)
  })

  // Fresh arrays every call. A shared constant handed to every caller means one caller
  // appending a location silently changes the filter for every client sourced afterwards
  // in that process, and that failure is cross-client and raises no error.
  it('returns arrays no other call shares', () => {
    const a = apolloHandler.adapter(baseSpec())
    const b = apolloHandler.adapter(baseSpec())
    a.organization_locations.push('mutated')
    expect(b.organization_locations).not.toContain('mutated')
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
      industries: ['Management Consulting'],
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
      industries: ['Management Consulting'],
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
      industries: ['Management Consulting'],
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
      industries: ['Management Consulting'],
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
      industries: ['Management Consulting'],
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

    // A spec the handler CAN honour, because the run has to reach page four for this
    // test to mean anything. The old version used an unhonourable one, which no longer
    // gets as far as the first request.
    const spec: Record<string, unknown> = {
      job_titles: ['role-a'], job_titles_excluded: ['role-z'], seniority_levels: [],
      person_countries: ['GB'], company_countries: ['GB'],
      company_headcount_min: 1, company_headcount_max: 50,
      industries: ['Management Consulting'], industries_excluded: [],
      keywords: [], keywords_excluded: [],
      notes: '',
    }

    await apolloHandler.execute(spec)

    expect(call).toBeGreaterThan(1)  // guards itself: a single-page run proves nothing

    const divergenceLogs = infoSpy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('query built from the client spec'),
    )
    expect(divergenceLogs).toHaveLength(1)
  })
})

// ─── The manifest has to describe the query that is actually sent ────────────
//
// TASK 2(d). `supported_fields` used to be the whole of FILTER_SPEC_FIELDS regardless of
// what the query did, and its own comment admitted it described "the handler's
// post-filters and history rather than the search query". The orchestrator checks a
// client's populated spec fields against it and passes, which reads as confirmation that
// the client's spec was honoured. It was not.
//
// These tests are the check that the two agree. They compare the manifest against what
// buildApolloRequest ACTUALLY SENDS, not against a second hand-written list, because a
// second hand-written list is the parallel-array shape that produced the problem.
describe('apolloHandler.supported_fields agrees with the query', () => {
  // A spec that populates EVERY filter field, so each one has the chance to appear.
  const fullSpec: Record<string, unknown> = {
    job_titles: ['role-a'],
    job_titles_excluded: ['role-z'],
    seniority_levels: ['owner'],
    person_countries: ['GB'],
    company_countries: ['IE'],
    company_headcount_min: 5,
    company_headcount_max: 20,
    industries: ['Management Consulting'],
    industries_excluded: ['Legal Services'],
    keywords: ['management consulting'],
    keywords_excluded: ['some-word'],
    notes: '',
  }

  // Which Apollo parameter each 'query' field is supposed to land in. This is the one
  // place the mapping is restated, and the test below proves the restatement is true of
  // the real request rather than trusting it.
  const QUERY_FIELD_TO_PARAM: Record<string, string> = {
    job_titles: 'person_titles',
    seniority_levels: 'person_seniorities',
    person_countries: 'person_locations',
    company_countries: 'organization_locations',
    company_headcount_min: 'organization_num_employees_ranges',
    company_headcount_max: 'organization_num_employees_ranges',
    industries: 'organization_naics_codes',
    industries_excluded: 'not_organization_naics_codes',
    keywords: 'q_organization_keyword_tags',
  }

  it('classifies every filter spec field, and invents none', () => {
    expect(Object.keys(SPEC_FIELD_HANDLING).sort())
      .toEqual([...FILTER_SPEC_FIELDS].sort())
  })

  it('advertises exactly the fields it classifies', () => {
    expect([...apolloHandler.supported_fields].sort())
      .toEqual(Object.keys(SPEC_FIELD_HANDLING).sort())
  })

  // THE ONE THAT MATTERS. Every field the manifest calls 'query' must put something in
  // the request. A field claimed as a query parameter that the request never carries is
  // exactly the divergence the old manifest hid.
  it('every field marked query reaches a populated Apollo parameter', () => {
    const request = buildApolloRequest(fullSpec) as unknown as Record<string, unknown>

    for (const [field, handling] of Object.entries(SPEC_FIELD_HANDLING)) {
      if (handling !== 'query') continue
      const param = QUERY_FIELD_TO_PARAM[field]
      expect(param, `no Apollo parameter recorded for query field ${field}`).toBeDefined()
      const value = request[param]
      expect(value, `${field} is marked query but ${param} is absent`).toBeDefined()
      expect(
        Array.isArray(value) ? value.length : 1,
        `${field} is marked query but ${param} is empty`,
      ).toBeGreaterThan(0)
    }
  })

  // The other direction. A field marked post_filter must NOT be a search parameter, or
  // the manifest is understating what the query does and the divergence report lies.
  it('no field marked post_filter appears as a search parameter', () => {
    const request = buildApolloRequest(fullSpec) as unknown as Record<string, unknown>
    const sent = JSON.stringify(request)

    for (const [field, handling] of Object.entries(SPEC_FIELD_HANDLING)) {
      if (handling !== 'post_filter') continue
      const values = fullSpec[field] as string[]
      for (const value of values) {
        expect(sent, `${field} value "${value}" reached the search query`).not.toContain(value)
      }
    }
  })

  // Guards itself. A test that iterates an empty set passes vacuously, and this suite is
  // entirely iteration over SPEC_FIELD_HANDLING.
  it('is measuring a non-empty set in both directions', () => {
    const values = Object.values(SPEC_FIELD_HANDLING)
    expect(values.filter(v => v === 'query').length).toBeGreaterThan(0)
    expect(values.filter(v => v === 'post_filter').length).toBeGreaterThan(0)
  })
})
