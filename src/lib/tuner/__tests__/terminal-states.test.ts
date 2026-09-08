// The outcomes that are ANSWERS rather than failures, and one that must never be confused
// with a verdict.

import { describe, it, expect, afterEach, vi } from 'vitest'

const webSearch = vi.fn()
vi.mock('@/lib/agents/tools/webSearch', () => ({ webSearch: (...a: unknown[]) => webSearch(...a) }))

vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: async () => ({
    criterion: null,
    vocabulary: {
      sells: 'A service described in the client\'s own words.',
      usedFor: 'Used by the people the client\'s own documents describe.',
      nameWords: ['alpha'],
    },
  }),
}))

import { installFakeProvider, forbiddenJudge, type FakeProvider } from './fake-provider'
import { runTuner } from '@/lib/tuner/run-tuner'
import { STATES_WITH_A_PLAN, TERMINAL_STATES } from '@/lib/tuner/types'
import type { JudgeFn } from '@/lib/tuner/judge'

let provider: FakeProvider | null = null
afterEach(() => { provider?.restore(); provider = null; webSearch.mockReset() })

function documentChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain,
    limit: async () => ({ data: [], error: null }),
    single: async () => ({
      data: {
        id: 'doc-1', version: '4', updated_at: '2026-09-02T23:10:26.721Z',
        content: {
          tier_1: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
          tier_2: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
          unresolved_fields: [],
          ...(overrides.content as object ?? {}),
        },
        icp_filter_spec: {
          job_titles: ['t-a'], job_titles_excluded: [], seniority_levels: ['founder'],
          person_countries: ['GB'], company_countries: ['GB'],
          company_headcount_min: 5, company_headcount_max: 20,
          industries: ['Higher Education'], industries_excluded: [],
          keywords: ['w-a'], keywords_excluded: [],
        },
      },
      error: null,
    }),
  })
  return { from: () => chain } as never
}

describe('the taxonomy holding nothing that fits is its own answer', () => {
  it('reaches no_taxonomy_bucket_fits when no other bucket does better either', async () => {
    // Everything is tiny: the client's own bucket, and every alternative the handler can
    // express. No amount of tuning the search reaches people who are not in the taxonomy.
    provider = installFakeProvider({ populationFor: () => 3 })

    const result = await runTuner({
      supabase: documentChain(), organisationId: 'org',
      judge: forbiddenJudge, throttleMs: 0,
    })

    expect(result.terminalState).toBe('no_taxonomy_bucket_fits')
    expect(result.terminalReason).toContain('No bucket in the taxonomy')
    expect(result.terminalReason).toContain('about the taxonomy, not about the search')
    expect(result.modelCalls).toBe(0)
  })

  it('reaches forbidden_change_required when a DIFFERENT bucket would fit', async () => {
    // The distinction that matters. A bucket exists that would reach this market, and the
    // tuner may not propose moving the client to it, because that is a claim about what
    // their business is and it lives in their document.
    provider = installFakeProvider({
      populationFor: req => {
        const codes = Array.isArray(req.organization_naics_codes)
          ? (req.organization_naics_codes as string[]) : []
        return codes.length === 1 && codes[0] !== '6113' ? 60_000 : 3
      },
    })

    const result = await runTuner({
      supabase: documentChain(), organisationId: 'org',
      judge: forbiddenJudge, throttleMs: 0,
    })

    expect(result.terminalState).toBe('forbidden_change_required')
    expect(result.terminalReason).toContain('the tuner may not propose it')
    expect(result.terminalReason).toContain('decision on the document')
    expect(result.modelCalls).toBe(0)
  })
})

describe('a document that does not know something the search needs', () => {
  it('stops, names the field, and quotes the document\'s own question', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })

    const result = await runTuner({
      supabase: documentChain({
        content: {
          tier_1: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
          tier_2: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
          unresolved_fields: [{
            kind: 'unestablished_field',
            field_path: 'tier_1.company_profile.industries',
            why_unresolved: 'The intake did not establish it.',
            question_to_settle_it: 'Which kinds of organisation do you actually serve today?',
          }],
        },
      }),
      organisationId: 'org', judge: forbiddenJudge, throttleMs: 0,
    })

    expect(result.terminalState).toBe('document_unresolved_fields_block_search')
    expect(result.terminalReason).toContain('Which kinds of organisation do you actually serve today?')
    expect(result.modelCalls).toBe(0)
    // It fires even on a healthy population, because measuring a population defined by an
    // unconfirmed value is work that has to be redone.
    expect(result.baselinePopulation).toBe(40_000)
  })
})

describe('a lookup that read nothing useful stays unresolved', () => {
  it('does not turn a thin page into a confident verdict', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })

    // A page with no relevant content on it.
    webSearch.mockResolvedValue({ synthesis: 'No information found.', limited: true, searchCount: 1 })

    const abstainingJudge: JudgeFn = async ({ rows }) => ({
      verdicts: rows.map(r => ({
        sourceId: r.sourceId,
        // The controls behave; the real sample is unresolved, which is what triggers lookups.
        verdict: r.sourceId.startsWith('control-wrong')
          ? ('does_not_fit' as const)
          : ('cannot_tell' as const),
        reason: 'the name says nothing',
      })),
      modelCalls: 1,
    })

    const result = await runTuner({
      supabase: documentChain(), organisationId: 'org',
      judge: abstainingJudge, throttleMs: 0, lookupCap: 5,
    })

    const adjust = result.rounds.find(r => r.kind === 'adjust')!
    expect(adjust.judged!.length).toBeGreaterThan(0)

    // EVERY row stayed unresolved. A lookup that returned nothing must not become knowledge.
    expect(adjust.judged!.every(j => j.verdict === 'cannot_tell')).toBe(true)
    expect(adjust.judged!.some(j => j.reason.includes('Still unknown'))).toBe(true)

    // And that is reported as low name signal, which is a correct outcome and not a failure.
    expect(['name_signal_too_low', 'lookup_budget_exhausted']).toContain(result.terminalState)
    expect(result.plan).toBeNull()
  })

  it('stores what the lookup read, so a human can disagree with it', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })
    webSearch.mockResolvedValue({
      synthesis: 'A long enough description of what this organisation does for the module to ' +
        'treat the lookup as having resolved something at all.',
      limited: false,
      searchCount: 2,
    })

    const judge: JudgeFn = async ({ rows }) => ({
      verdicts: rows.map(r => ({
        sourceId: r.sourceId,
        verdict: r.sourceId.startsWith('control-wrong') ? ('does_not_fit' as const) : ('cannot_tell' as const),
        reason: 'r',
      })),
      modelCalls: 1,
    })

    const result = await runTuner({
      supabase: documentChain(), organisationId: 'org',
      judge, throttleMs: 0, lookupCap: 30,
    })

    const adjust = result.rounds.find(r => r.kind === 'adjust')!
    const withLookup = adjust.judged!.find(j => j.lookupText !== null)!
    expect(withLookup.lookupText).toContain('description of what this organisation does')
    expect(withLookup.lookupBillableSearches).toBe(2)

    // The bill is reported in billable searches returned, not lookups attempted.
    expect(result.billableSearches).toBeGreaterThan(adjust.judged!.filter(j => j.lookupText).length - 1)
  })
})

describe('giving up never renders like succeeding', () => {
  it('exactly one terminal state carries a plan', () => {
    expect(Array.from(STATES_WITH_A_PLAN)).toEqual(['accepted'])
    // Every other named outcome is a conclusion without a plan. A reader checking for
    // success has one thing to check for, rather than a list to keep in step by hand.
    expect(TERMINAL_STATES.filter(s => !STATES_WITH_A_PLAN.has(s)).length)
      .toBe(TERMINAL_STATES.length - 1)
  })

  it('every terminal state is distinct and none is a substring of another', () => {
    // Otherwise a naive `reason.includes(state)` or a prefix match in a UI would render two
    // different outcomes the same way.
    const set = new Set(TERMINAL_STATES)
    expect(set.size).toBe(TERMINAL_STATES.length)
    for (const a of TERMINAL_STATES) {
      for (const b of TERMINAL_STATES) {
        if (a !== b) expect(b.includes(a)).toBe(false)
      }
    }
  })
})
