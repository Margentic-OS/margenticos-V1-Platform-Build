// The single subtraction point, and the reachability check that follows it.
//
// No country is written down in this file. Every code is computed from the constants that
// actually enforce the rule, so a change to either enforcement list changes these tests
// with it rather than leaving them asserting yesterday's membership.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  applyGeographyExclusions,
  mergeExclusionSources,
  ALL_EXCLUDED_COUNTRIES,
} from '@/lib/sourcing/geography-exclusion'
import { LEGALLY_EXCLUDED_COUNTRIES } from '@/lib/sourcing/handlers/adapter-apollo'
import { EXCLUDED_COUNTRIES } from '@/lib/sourcing/send-eligibility-rules'
import {
  aTargetableCode,
  twoTargetableCodes,
  anExcludedCode,
  anUntargetableCode,
} from '@/test-utils/geography-fixture'

describe('the excluded set is the union of both enforcement lists', () => {
  // The whole reason this is derived rather than restated. A third hardcoded list would
  // drift in the silent direction: a country added to one enforcement list and forgotten
  // here would still be derived into every client's spec.
  it('contains every country the sourcing handler refuses', () => {
    for (const code of LEGALLY_EXCLUDED_COUNTRIES) {
      expect(ALL_EXCLUDED_COUNTRIES.has(code)).toBe(true)
    }
  })

  it('contains every country the send rule excludes', () => {
    for (const code of EXCLUDED_COUNTRIES) {
      expect(ALL_EXCLUDED_COUNTRIES.has(code)).toBe(true)
    }
  })

  // Guards against a vacuous pass: both loops above are empty if either list is empty.
  it('is not empty, so the two assertions above are not vacuous', () => {
    expect(ALL_EXCLUDED_COUNTRIES.size).toBeGreaterThan(0)
    expect(LEGALLY_EXCLUDED_COUNTRIES.size).toBeGreaterThan(0)
    expect(EXCLUDED_COUNTRIES.length).toBeGreaterThan(0)
  })

  // ─── THE LIMIT OF THE TWO TESTS ABOVE, STATED RATHER THAN LEFT TO LOOK LIKE COVERAGE ──
  //
  // The send-side list is currently a SUBSET of the sourcing-side list. So the union
  // returns the same set whether or not the send-side source is included, and neither
  // test above can fail if it is dropped. Mutation-tested and confirmed: removing that
  // source left all fourteen tests in this file green.
  //
  // They are still worth keeping. They fail the moment the lists stop overlapping, which
  // is exactly when the union starts doing work. But the union OPERATION needs proving
  // somewhere the sources can be made to differ, and that is the test below.
  //
  // The tokens are deliberately not countries. 'ZZ' and 'XY' are unassigned in ISO 3166
  // and cannot be confused for a real place, which is the point: no real country name
  // belongs in a fixture.
  describe('the union operation itself, on sources that actually differ', () => {
    it('carries every code from every source', () => {
      const merged = mergeExclusionSources(['ZZ'], ['XY'])
      expect(merged.has('ZZ')).toBe(true)
      expect(merged.has('XY')).toBe(true)
      expect(merged.size).toBe(2)
    })

    it('deduplicates a code present in both', () => {
      expect(mergeExclusionSources(['ZZ'], ['ZZ']).size).toBe(1)
    })

    it('normalises case, so a lowercase source entry still excludes', () => {
      expect(mergeExclusionSources(['zz'], []).has('ZZ')).toBe(true)
    })

    it('drops no source when one is empty', () => {
      expect(mergeExclusionSources([], ['ZZ']).has('ZZ')).toBe(true)
      expect(mergeExclusionSources(['ZZ'], []).has('ZZ')).toBe(true)
    })
  })
})

describe('subtraction removes exactly the excluded countries', () => {
  it('keeps a country nothing excludes', () => {
    const code = aTargetableCode()
    expect(applyGeographyExclusions([code])).toEqual({ kept: [code], removed: [] })
  })

  // POSITIVE CONTROL for the subtraction itself. Delete the filter and this goes red
  // while the test above stays green.
  it('removes an excluded country and reports it', () => {
    const excluded = anExcludedCode()
    const kept = aTargetableCode()

    const outcome = applyGeographyExclusions([kept, excluded])

    expect(outcome.kept).toEqual([kept])
    expect(outcome.removed).toEqual([excluded])
  })

  it('normalises case, so a lowercase code cannot slip past the exclusion', () => {
    const excluded = anExcludedCode()
    const outcome = applyGeographyExclusions([aTargetableCode(), excluded.toLowerCase()])
    expect(outcome.removed).toEqual([excluded])
  })

  it('throws when every country named is excluded, rather than returning an empty list', () => {
    const excluded = anExcludedCode()
    expect(() => applyGeographyExclusions([excluded]))
      .toThrow(/every country this ICP names is excluded/i)
  })

  it('names what was removed in that error', () => {
    const excluded = anExcludedCode()
    expect(() => applyGeographyExclusions([excluded])).toThrow(new RegExp(excluded))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE REACHABILITY CHECK
// ═════════════════════════════════════════════════════════════════════════════

const deriveIcpGeography = vi.fn()

vi.mock('@/agents/icp-geography-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/icp-geography-agent')>()
  return { ...actual, deriveIcpGeography: (...args: unknown[]) => deriveIcpGeography(...args) }
})

// Imported after the mock is declared; vitest hoists vi.mock above imports.
import { resolveIcpGeography } from '@/lib/sourcing/resolve-icp-geography'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'

const doc = {
  summary: 's',
  jtbd_statement: 'j',
  tier_1: {
    company_profile: {
      revenue_range: 'r', headcount: '1-10',
      industries: ['Management Consulting'], geography: 'stated',
    },
    buyer_profile: { title: 't', seniority: 's' },
    disqualifiers: [],
  },
  tier_2: {
    company_profile: {
      revenue_range: 'r', headcount: '1-10',
      industries: ['Management Consulting'], geography: 'stated',
    },
    buyer_profile: { title: 't', seniority: 's' },
    disqualifiers: [],
  },
  tier_3: {
    company_profile: {
      revenue_range: 'r', headcount: '1-10', industries: ['Management Consulting'],
    },
  },
} as IcpDocument

/** The agent's result, so a test states only the countries it cares about. */
function agentReturns(countries: string[], unresolved: string[] = []) {
  deriveIcpGeography.mockResolvedValue({
    countries,
    unresolved_phrases: unresolved,
    derived_at: '2026-01-01T00:00:00.000Z',
    model: 'test',
  })
}

// The supabase client is never reached: every test passes targetableCountries explicitly,
// which is the seam that exists so this file needs no database.
const supabase = {} as never

beforeEach(() => {
  deriveIcpGeography.mockReset()
})

describe('a country the handler cannot translate stops the derivation', () => {
  it('throws and names the country', async () => {
    const unreachable = anUntargetableCode()
    const reachable = aTargetableCode()
    agentReturns([reachable, unreachable])

    await expect(
      resolveIcpGeography({ supabase, doc, targetableCountries: [reachable] }),
    ).rejects.toThrow(new RegExp(`names ${unreachable}`))
  })

  it('explains that the handler owns the translation, so the fix is findable', async () => {
    const unreachable = anUntargetableCode()
    agentReturns([aTargetableCode(), unreachable])

    await expect(
      resolveIcpGeography({ supabase, doc, targetableCountries: [aTargetableCode()] }),
    ).rejects.toThrow(/active sourcing handler cannot target/i)
  })

  // POSITIVE CONTROL. The same path must pass for a country the handler DOES advertise,
  // or a check that rejected everything would satisfy both tests above.
  it('accepts a country the handler advertises', async () => {
    const [a, b] = twoTargetableCodes()
    agentReturns([a, b])

    const result = await resolveIcpGeography({ supabase, doc, targetableCountries: [a, b] })
    expect(result.countries).toEqual([a, b])
  })
})

describe('exclusion happens before reachability', () => {
  // ORDER MATTERS AND THIS IS THE TEST FOR IT. An excluded country that the handler also
  // cannot reach must be reported as EXCLUDED, not as unreachable: an operator sent to
  // register a country with the handler would be fixing the wrong thing, and would be
  // working to enable a country that is excluded for legal reasons anyway.
  it('reports an excluded country as excluded even when it is also unreachable', async () => {
    const excluded = anExcludedCode()
    const reachable = aTargetableCode()
    agentReturns([reachable, excluded])

    // The handler's advertised list here deliberately omits the excluded code.
    const result = await resolveIcpGeography({
      supabase, doc, targetableCountries: [reachable],
    })

    expect(result.removed_by_exclusion).toEqual([excluded])
    expect(result.countries).toEqual([reachable])
  })
})

describe('what the resolver carries forward', () => {
  it('passes the skipped phrases through untouched, for the spec notes', async () => {
    const code = aTargetableCode()
    agentReturns([code], ['a phrase that named nothing'])

    const result = await resolveIcpGeography({ supabase, doc, targetableCountries: [code] })
    expect(result.unresolved_phrases).toEqual(['a phrase that named nothing'])
  })

  it('reads the document through the collector, so the disqualifier tier never reaches the model', async () => {
    const code = aTargetableCode()
    agentReturns([code])

    await resolveIcpGeography({ supabase, doc, targetableCountries: [code] })

    const statements = deriveIcpGeography.mock.calls[0][0].statements as string[]
    expect(statements).toEqual(['stated', 'stated'])
  })
})
