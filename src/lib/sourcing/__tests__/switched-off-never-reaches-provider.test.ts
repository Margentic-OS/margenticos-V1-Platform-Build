// A FILTER A CLIENT'S SETTINGS SWITCH OFF MUST NEVER REACH THE PROVIDER.
//
// Until 2026-09-10 the handler built the list of switched-off filters into a set and never
// read the set, so every switched-off filter was sent anyway. The only earlier end-to-end
// test covered seniority, which passed for a different reason (the band list is left empty
// upstream), so nothing noticed.
//
// These tests check the WORLD rather than the list. The last block reads the body of the
// request the provider actually receives, through the handler's own execute().
//
// DERIVED FROM OMITTABLE_AXES: an axis added to that list is tested here with no edit, and
// the map test fails until the handler says what the new axis removes.
//
// RULE ZERO. No industry, sector, country or company name appears below. Industries and
// countries are taken from the exported lists and fixtures by position; every other value
// is a placeholder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  apolloHandler, buildApolloRequest, readOmittedAxes, OMITTED_AXIS_TARGET,
} from '@/lib/sourcing/handlers/adapter-apollo'
import {
  CANONICAL_INDUSTRIES, OMITTABLE_AXES, deriveFilterSpec, type IcpDocument,
} from '@/lib/agents/icp-filter-spec'
import { aTargetableCode, aGeography } from '@/test-utils/geography-fixture'
import { someBands, seniorityFixture } from '@/test-utils/seniority-fixture'

const EXCLUDED_WORD = 'placeholder-excluded-word'

function specWith(over: Record<string, unknown> = {}): Record<string, unknown> {
  const code = aTargetableCode()
  return {
    job_titles: ['placeholder-role'],
    job_titles_excluded: [],
    seniority_levels: someBands(2),
    person_countries: [code],
    company_countries: [code],
    company_headcount_min: 5,
    company_headcount_max: 20,
    industries: [CANONICAL_INDUSTRIES[0]],
    industries_excluded: [],
    keywords: ['placeholder-term-a', 'placeholder-term-b'],
    keywords_excluded: [EXCLUDED_WORD],
    company_revenue_min: 1_000_000,
    company_revenue_max: 4_000_000,
    notes: '',
    ...over,
  }
}

// Two canonical industries that translate to DIFFERENT provider codes, found by asking the
// handler rather than by naming them. An exclusion that shares the included code is dropped
// on purpose, and a test whose exclusion was dropped upstream would pass for the wrong reason.
let distinct: [string, string] | null = null
function everyAxisOn(over: Record<string, unknown> = {}): Record<string, unknown> {
  if (!distinct) {
    const first = CANONICAL_INDUSTRIES[0]
    for (const other of CANONICAL_INDUSTRIES.slice(1)) {
      const r = buildApolloRequest(specWith({ industries: [first], industries_excluded: [other] })) as Record<string, unknown>
      if (Array.isArray(r.not_organization_naics_codes) && r.not_organization_naics_codes.length > 0) {
        distinct = [first, other]
        break
      }
    }
    if (!distinct) throw new Error('fixture: no two canonical industries map to different provider codes')
  }
  return specWith({ industries: [distinct[0]], industries_excluded: [distinct[1]], ...over })
}

const REQUEST_AXES = OMITTABLE_AXES.filter(a => OMITTED_AXIS_TARGET[a] !== 'post_filter')

describe('the fixture really exercises every switchable axis (positive control)', () => {
  it('with nothing switched off, every switchable request parameter IS sent', () => {
    const r = buildApolloRequest(everyAxisOn()) as Record<string, unknown>
    expect(REQUEST_AXES.length).toBeGreaterThan(0)
    for (const axis of REQUEST_AXES) {
      const target = OMITTED_AXIS_TARGET[axis] as string
      expect(r[target], `${axis} -> ${target} must be sent when nothing is switched off`).toBeDefined()
    }
  })

  it('the map names every switchable axis and nothing else', () => {
    expect(Object.keys(OMITTED_AXIS_TARGET).sort()).toEqual([...OMITTABLE_AXES].sort())
  })
})

describe('each switchable axis, switched off alone, removes exactly its own parameter', () => {
  it.each([...OMITTABLE_AXES])('%s', (axis) => {
    const on = buildApolloRequest(everyAxisOn()) as Record<string, unknown>
    const off = buildApolloRequest(everyAxisOn({ omitted_axes: [axis] })) as Record<string, unknown>
    const target = OMITTED_AXIS_TARGET[axis]
    if (target === 'post_filter') {
      // Applied to returned rows, never sent, so the request is untouched. Proven end to end
      // below, against rows the handler actually filters.
      expect(off).toEqual(on)
      return
    }
    expect(target in off).toBe(false)
    const { [target]: _removed, ...rest } = on
    expect(off).toEqual(rest)
  })
})

describe('from the derivation: a switch-off it records is honoured', () => {
  // The production path. deriveFilterSpec keeps the axis's values on the record AND lists the
  // axis as switched off; the handler is what must decline to send it.
  const doc: IcpDocument = {
    summary: 's',
    jtbd_statement: 'j',
    tier_1: {
      company_profile: { revenue_range: 'not stated', headcount: '5-20 people', industries: [CANONICAL_INDUSTRIES[0]] },
      buyer_profile: { title: 't', seniority: 'as the document states it' },
      disqualifiers: [],
    },
    tier_2: {
      company_profile: { revenue_range: 'not stated', headcount: '5-20 people', industries: [CANONICAL_INDUSTRIES[0]] },
      buyer_profile: { title: 't', seniority: 'as the document states it' },
      disqualifiers: [],
    },
    tier_3: { company_profile: { revenue_range: 'r', headcount: '5-20 people', industries: [] } },
  }
  const criterion = {
    status: 'derived' as const,
    accept: [{ fragment: 'a-role-fragment', rank: 'primary' as const }],
    reject: [], statement: 's', evidence: [], unsettled_reason: null, sanity: null,
    derived_at: new Date(0).toISOString(), model: 'test',
  }
  const KEYWORD_AXIS = REQUEST_AXES.find(a => OMITTED_AXIS_TARGET[a] === 'q_organization_keyword_tags')!

  it('keeps the values on the record and does not send them', () => {
    const spec = deriveFilterSpec(doc, criterion, aGeography([aTargetableCode()]), {
      ...seniorityFixture(2), omitted: [KEYWORD_AXIS],
    })
    expect(spec.keywords.length).toBeGreaterThan(0)
    expect(spec.omitted_axes).toContain(KEYWORD_AXIS)

    const r = buildApolloRequest(spec as unknown as Record<string, unknown>) as Record<string, unknown>
    expect('q_organization_keyword_tags' in r).toBe(false)
  })
})

describe('a switch-off the spec may not make is refused, never skipped', () => {
  it('refuses an axis outside the switchable list', () => {
    expect(() => buildApolloRequest(everyAxisOn({ omitted_axes: ['person_countries'] }))).toThrow(/cannot be switched off/)
  })

  it('reads a valid list back as exactly what it named', () => {
    expect([...readOmittedAxes(everyAxisOn({ omitted_axes: [...OMITTABLE_AXES] }))].sort()).toEqual([...OMITTABLE_AXES].sort())
    expect(readOmittedAxes(everyAxisOn()).size).toBe(0)
  })
})

describe('end to end: what the provider actually receives', () => {
  // Two real row shapes from the handler's own fixture, with every identifying value
  // replaced. One company name contains the excluded placeholder word, so the post-filter
  // has something to drop.
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../../../tests/fixtures/sourcing/apollo-api-search-response.json'), 'utf-8',
  ))
  const row = (id: string, companyName: string) => ({
    ...fixture.people[0], id, has_email: true,
    organization: { ...fixture.people[0].organization, name: companyName },
  })
  const DROPPABLE = 'row-with-excluded-word'
  const KEEPER = 'row-without'

  let sent: Record<string, unknown>[] = []
  const savedKey = process.env.APOLLO_API_KEY

  beforeEach(() => {
    sent = []
    process.env.APOLLO_API_KEY = savedKey ?? 'placeholder-key'
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      sent.push(body)
      // One short page, then nothing: the handler stops on a page shorter than it asked for.
      const people = body.page === 1
        ? [row(DROPPABLE, `Placeholder Company ${EXCLUDED_WORD} One`), row(KEEPER, 'Placeholder Company Two')]
        : []
      return new Response(JSON.stringify({ people, total_entries: 2 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.APOLLO_API_KEY = savedKey
  })

  const keys = (cands: { source_person_key: string }[]) => cands.map(c => c.source_person_key)

  it('CONTROL: nothing switched off, so every parameter is in the body and the matching row is dropped', async () => {
    const got = await apolloHandler.execute(everyAxisOn())
    expect(sent.length).toBeGreaterThan(0)
    for (const axis of REQUEST_AXES) {
      expect(sent[0][OMITTED_AXIS_TARGET[axis] as string], `${axis} must be sent`).toBeDefined()
    }
    expect(keys(got)).toContain(`apollo:${KEEPER}`)
    expect(keys(got)).not.toContain(`apollo:${DROPPABLE}`)
  })

  it('every switchable axis switched off: none of their parameters reaches the provider, and the post-filter is skipped', async () => {
    const got = await apolloHandler.execute(everyAxisOn({ omitted_axes: [...OMITTABLE_AXES] }))
    expect(sent.length).toBeGreaterThan(0)
    for (const body of sent) {
      for (const axis of REQUEST_AXES) {
        expect(OMITTED_AXIS_TARGET[axis] as string in body, `${axis} reached the provider`).toBe(false)
      }
    }
    // The row the excluded-word filter would have dropped is kept, because that filter is off.
    expect(keys(got)).toContain(`apollo:${DROPPABLE}`)
    expect(keys(got)).toContain(`apollo:${KEEPER}`)
  })

  it('a refused switch-off stops the run before anything is sent', async () => {
    await expect(apolloHandler.execute(everyAxisOn({ omitted_axes: ['industries'] }))).rejects.toThrow(/cannot be switched off/)
    expect(sent.length).toBe(0)
  })
})
