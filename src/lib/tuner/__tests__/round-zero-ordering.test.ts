// THE ACCEPTANCE TEST FOR THE LOOP'S ORDERING.
//
// The claim under test: round zero reaches a terminal state using only free measurements,
// and a client whose audience is too small to judge never costs a model call or a lookup.
//
// ─── THE NUMBERS ARE REAL ────────────────────────────────────────────────────
//
// Every figure below was MEASURED AGAINST THE PROVIDER on 2026-09-08 for one live
// organisation, and they are used here as the fake provider's answers so the test exercises
// the code path against the shape that actually occurs rather than an invented one:
//
//   as configured                     1
//   job titles relaxed               87
//   seniority relaxed               104
//   both relaxed (the ceiling)      879
//   geography and size only      97,772
//
// The organisation is not named and nothing about its market appears here. What is reused is
// the SHAPE: a search that reaches one person, whose ceiling is three orders of magnitude
// below the same query with no classification bucket applied.
//
// ─── WHY THE JUDGE IS A FUNCTION THAT THROWS ─────────────────────────────────
//
// Asserting `modelCalls === 0` proves the counter is zero. It does not prove no model call
// happened, because a call that failed to increment the counter would satisfy it. A judge
// that throws proves the stronger thing: the code path was never reached.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { installFakeProvider, forbiddenJudge, type FakeProvider } from './fake-provider'
import { runTuner } from '@/lib/tuner/run-tuner'
import { MIN_JUDGEABLE_POPULATION } from '@/lib/tuner/round-zero'

let provider: FakeProvider | null = null
afterEach(() => { provider?.restore(); provider = null; vi.restoreAllMocks() })

// ─── A stand-in for the document and spec reads ──────────────────────────────

const SPEC = {
  job_titles: ['t-a', 't-b', 't-c'],
  job_titles_excluded: [],
  seniority_levels: ['founder', 'owner', 'c_suite'],
  person_countries: ['GB'],
  company_countries: ['GB'],
  company_headcount_min: 5,
  company_headcount_max: 150,
  industries: ['Higher Education'],
  industries_excluded: [],
  keywords: ['w-a', 'w-b'],
  keywords_excluded: [],
}

const ICP_CONTENT = {
  tier_1: { company_profile: { industries: ['Higher Education'], headcount: '5-150 staff' } },
  tier_2: { company_profile: { industries: ['Higher Education'], headcount: '5-150 staff' } },
  unresolved_fields: [],
}

function supabaseReturning(doc: Record<string, unknown>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: async () => ({ data: [], error: null }),
    single: async () => ({ data: doc, error: null }),
  }
  return { from: () => chain } as never
}

/**
 * The measured shape, expressed as a function of the request.
 *
 * The fake HONOURS every constraint it is asked about. Removing the title layer widens to 87,
 * removing seniority widens to 104, removing both widens to 879, and removing the
 * classification bucket on top of that widens to 97,772. Anything narrower returns 1.
 */
function measuredPopulation(req: Record<string, unknown>): number {
  const hasTitles = Array.isArray(req.person_titles) && (req.person_titles as unknown[]).length > 0
  const hasSeniority = Array.isArray(req.person_seniorities) && (req.person_seniorities as unknown[]).length > 0
  const hasCodes = Array.isArray(req.organization_naics_codes) && (req.organization_naics_codes as unknown[]).length > 0

  if (!hasCodes) return 97_772
  if (!hasTitles && !hasSeniority) return 879
  if (!hasTitles) return 87
  if (!hasSeniority) return 104
  return 1
}

describe('round zero settles a too-small audience without spending anything', () => {
  it('reaches a terminal state with zero model calls and zero lookups', async () => {
    provider = installFakeProvider({ populationFor: measuredPopulation })

    const result = await runTuner({
      supabase: supabaseReturning({
        id: 'doc-1', version: '8', updated_at: '2026-09-08T14:01:04.704Z',
        content: ICP_CONTENT, icp_filter_spec: SPEC,
      }),
      organisationId: 'org-under-test',
      judge: forbiddenJudge, throttleMs: 0,
    })

    // THE OUTCOME, and it is a named conclusion rather than a failure.
    expect(result.terminalState).toBe('population_effectively_empty')

    // THE PROOF THE ORDERING HELD. Nothing expensive was spent.
    expect(result.modelCalls).toBe(0)
    expect(result.billableSearches).toBe(0)

    // And round zero itself records those zeros, so a reader of the stored record can check
    // the same claim without re-running anything.
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0].kind).toBe('zero')
    expect(result.rounds[0].modelCalls).toBe(0)
    expect(result.rounds[0].billableSearches).toBe(0)

    // Free calls WERE made. A run that reached a conclusion with no provider calls at all
    // would mean it concluded without measuring, which would be a different defect.
    expect(result.providerCalls).toBeGreaterThan(0)
  })

  it('reports BOTH populations, so "too tight" and "nobody there" are a measured difference', async () => {
    provider = installFakeProvider({ populationFor: measuredPopulation })

    const result = await runTuner({
      supabase: supabaseReturning({
        id: 'doc-1', version: '8', updated_at: '2026-09-08T14:01:04.704Z',
        content: ICP_CONTENT, icp_filter_spec: SPEC,
      }),
      organisationId: 'org-under-test',
      judge: forbiddenJudge, throttleMs: 0,
    })

    expect(result.baselinePopulation).toBe(1)
    expect(result.ceilingPopulation).toBe(879)

    // The reason has to carry the diagnosis, not just the number, because the number alone is
    // what an operator cannot interpret.
    expect(result.terminalReason).toContain('879')
    expect(result.terminalReason).toMatch(/reduce it|not there to find/)
    expect(result.terminalReason).toContain('No model call was made')
  })

  it('the floor it stops at is the judge\'s own, not a number invented here', () => {
    // If the judge's minimum resolved sample moved and this did not, round zero would start
    // calling a model on populations the judge cannot report on.
    expect(MIN_JUDGEABLE_POPULATION).toBe(12)
  })

  it('a healthy population does NOT stop at round zero', async () => {
    // The mirror of the first case. Without this, a round zero that stopped on everything
    // would pass every assertion above while being useless.
    provider = installFakeProvider({ populationFor: () => 40_000 })

    const result = await runTuner({
      supabase: supabaseReturning({
        id: 'doc-1', version: '8', updated_at: '2026-09-08T14:01:04.704Z',
        content: ICP_CONTENT, icp_filter_spec: SPEC,
      }),
      organisationId: 'org-under-test',
      // It should get past round zero and try to read the client's documents. That call is
      // not stubbed here, so it fails, and failing THERE is the proof it got past round zero.
      judge: forbiddenJudge, throttleMs: 0,
    })

    expect(result.terminalState).not.toBe('population_effectively_empty')
    expect(result.rounds[0].population).toBe(40_000)
  })
})

describe('a contract requirement is an input and never a default', () => {
  it('says it cannot judge sufficiency when none was supplied', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })
    const result = await runTuner({
      supabase: supabaseReturning({
        id: 'doc-1', version: '4', updated_at: '2026-09-02T23:10:26.721Z',
        content: ICP_CONTENT, icp_filter_spec: SPEC,
      }),
      organisationId: 'org-under-test',
      judge: forbiddenJudge, throttleMs: 0,
    })
    expect(result.notes.join(' ')).toContain('No contract requirement was supplied')
    expect(result.notes.join(' ')).toContain('nothing is assumed')
  })

  it('reaches the commercial conclusion when one IS supplied and the ceiling is short', async () => {
    provider = installFakeProvider({ populationFor: measuredPopulation })
    const result = await runTuner({
      supabase: supabaseReturning({
        id: 'doc-1', version: '8', updated_at: '2026-09-08T14:01:04.704Z',
        content: ICP_CONTENT, icp_filter_spec: SPEC,
      }),
      organisationId: 'org-under-test',
      contract: { monthlyProspects: 1300, months: 4 },
      judge: forbiddenJudge, throttleMs: 0,
    })

    // The commercial answer wins over "effectively empty", because it is the actionable one.
    expect(result.terminalState).toBe('population_too_small_for_contract')
    expect(result.terminalReason).toContain('5200')
    expect(result.terminalReason).toContain('879')
    expect(result.terminalReason).toContain('commercial conversation')
    expect(result.modelCalls).toBe(0)
  })
})
