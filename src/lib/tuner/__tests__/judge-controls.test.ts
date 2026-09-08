// BOTH NEGATIVE CONTROLS, PROVEN BY SUPPLYING A JUDGE THAT ALWAYS APPROVES.
//
// A control that has never been seen to fire is not a control. So the proof here is not that
// a good judge passes — that proves nothing — but that a judge which approves everything is
// reported as unreliable, and that its verdicts are then not used.

import { describe, it, expect, afterEach, vi } from 'vitest'

// The ONE model call the run makes before any judging. Stubbed so this file can reach the
// judge at all; without it the run stops at the document read and the always-approving judge
// is never exercised, which would make the assertions below vacuous.
vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: async () => ({
    criterion: null,
    vocabulary: {
      sells: 'A service described in the client\'s own words.',
      usedFor: 'Used by the people the client\'s documents describe.',
      nameWords: ['alpha', 'beta'],
    },
  }),
}))
import { installFakeProvider, type FakeProvider } from './fake-provider'
import { runTuner } from '@/lib/tuner/run-tuner'
import {
  assessControls, assessSample, buildUnknowableControl, unknowableEmployerToken,
  parseVerdicts, MIN_RESOLVED_SAMPLE, MAX_WRONG_SEARCH_APPROVAL, MAX_UNKNOWABLE_GUESS,
  type RawVerdict, type JudgeFn,
} from '@/lib/tuner/judge'
import type { JudgedRow } from '@/lib/tuner/types'

let provider: FakeProvider | null = null
afterEach(() => { provider?.restore(); provider = null; vi.restoreAllMocks() })

function supabaseWithDocument() {
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

const rows = (n: number, prefix: string, verdict: RawVerdict['verdict']): RawVerdict[] =>
  Array.from({ length: n }, (_, i) => ({ sourceId: `${prefix}-${i}`, verdict, reason: 'r' }))

describe('the wrong-search control', () => {
  it('reports unreliable when the judge approves a wrong-search sample', () => {
    const outcome = assessControls(rows(8, 'w', 'fits'), rows(8, 'u', 'cannot_tell'))
    expect(outcome.reliable).toBe(false)
    expect(outcome.reason).toContain('deliberately wrong search')
    expect(outcome.wrongSearchApproved).toBe(8)
  })

  it('tolerates the occasional true positive, because a business can sit under more than one bucket', () => {
    const wrong = [...rows(1, 'w', 'fits'), ...rows(7, 'wn', 'does_not_fit')]
    const outcome = assessControls(wrong, rows(8, 'u', 'cannot_tell'))
    expect(1 / 8).toBeLessThanOrEqual(MAX_WRONG_SEARCH_APPROVAL)
    expect(outcome.reliable).toBe(true)
  })
})

describe('the unknowable control', () => {
  it('reports unreliable when the judge answers rows it cannot possibly know', () => {
    const outcome = assessControls(rows(8, 'w', 'does_not_fit'), rows(8, 'u', 'fits'))
    expect(outcome.reliable).toBe(false)
    expect(outcome.reason).toContain('carries no meaning')
    expect(outcome.unknowableGuessed).toBe(8)
  })

  it('passes when it abstains', () => {
    const outcome = assessControls(rows(8, 'w', 'does_not_fit'), rows(8, 'u', 'cannot_tell'))
    expect(outcome.reliable).toBe(true)
    expect(outcome.reason).toContain('abstained')
  })

  it('allows a small number of answers, because a title alone can occasionally settle it', () => {
    const unknowable = [...rows(1, 'u', 'fits'), ...rows(7, 'un', 'cannot_tell')]
    expect(1 / 8).toBeLessThanOrEqual(MAX_UNKNOWABLE_GUESS)
    expect(assessControls(rows(8, 'w', 'does_not_fit'), unknowable).reliable).toBe(true)
  })

  it('builds employer tokens that carry no meaning and name nothing', () => {
    const control = buildUnknowableControl(4, ['Title-A'])
    expect(control).toHaveLength(4)
    for (const row of control) {
      // Synthesised from a consonant stem and an index. Obviously not a real organisation,
      // and reproducible, so a failure can be repeated.
      expect(row.companyName).toMatch(/^[A-Z][a-z]{2}-\d+$/)
    }
    expect(unknowableEmployerToken(0)).toBe(unknowableEmployerToken(0))
    expect(unknowableEmployerToken(0)).not.toBe(unknowableEmployerToken(1))
  })
})

describe('a control that never ran is unreliable, not passed', () => {
  it('refuses to certify a judge on an empty control', () => {
    // THE VACUOUS-PASS CASE. Every rate is zero when there are no rows, so a naive
    // implementation reports both thresholds satisfied and calls the judge reliable.
    expect(assessControls([], rows(8, 'u', 'cannot_tell')).reliable).toBe(false)
    expect(assessControls(rows(8, 'w', 'does_not_fit'), []).reliable).toBe(false)
    expect(assessControls([], []).reason).toContain('nothing was proven')
  })
})

describe('an always-approving judge stops the whole run', () => {
  it('reaches judge_unreliable, proposes nothing, and says which control it failed', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })

    // The judge under test: it approves everything it is shown, including the deliberately
    // wrong search and the employer names that carry no meaning.
    const alwaysApproves: JudgeFn = async ({ rows: given }) => ({
      verdicts: given.map(r => ({ sourceId: r.sourceId, verdict: 'fits' as const, reason: 'looks fine' })),
      modelCalls: 1,
    })

    const result = await runTuner({
      supabase: supabaseWithDocument(),
      organisationId: 'org-under-test',
      judge: alwaysApproves,
      throttleMs: 0,
    })

    expect(result.terminalState).toBe('judge_unreliable')
    expect(result.plan).toBeNull()

    // BOTH controls fired, and the reason names both rather than stopping at the first.
    expect(result.terminalReason).toContain('deliberately wrong search')
    expect(result.terminalReason).toContain('carries no meaning')
    expect(result.terminalReason).toContain('not used')

    // The round recorded the failure rather than quietly discarding it.
    const adjust = result.rounds.find(r => r.kind === 'adjust')!
    expect(adjust.judgeReliable).toBe(false)
  })

  it('a judge that behaves correctly is NOT reported unreliable', async () => {
    // The mirror. Without it, an implementation that reported every judge unreliable would
    // pass the test above and be useless.
    provider = installFakeProvider({ populationFor: () => 40_000 })

    const wellBehaved: JudgeFn = async ({ rows: given }) => ({
      verdicts: given.map(r => ({
        sourceId: r.sourceId,
        verdict: r.sourceId.startsWith('control-wrong')
          ? ('does_not_fit' as const)
          : r.sourceId.startsWith('control-unknowable')
            ? ('cannot_tell' as const)
            : ('fits' as const),
        reason: 'r',
      })),
      modelCalls: 1,
    })

    const result = await runTuner({
      supabase: supabaseWithDocument(),
      organisationId: 'org-under-test',
      judge: wellBehaved,
      throttleMs: 0,
    })

    expect(result.terminalState).not.toBe('judge_unreliable')
    const adjust = result.rounds.find(r => r.kind === 'adjust')
    expect(adjust?.judgeReliable).toBe(true)
  })
})

describe('no agreement figure is reported on a small resolved sample', () => {
  const judged = (n: number, verdict: JudgedRow['verdict']): JudgedRow[] =>
    Array.from({ length: n }, (_, i) => ({
      sourceId: `s-${i}`, jobTitle: 'T', companyName: 'C',
      verdict, reason: '', lookupText: null, lookupBillableSearches: 0,
    }))

  it('returns null rather than a number below the floor', () => {
    const a = assessSample([...judged(3, 'fits'), ...judged(2, 'does_not_fit')])
    expect(a.resolved).toBe(5)
    expect(a.agreement).toBeNull()
    expect(a.note).toContain('No agreement figure')
    // NULL IS "NOT MEASURED", NEVER ZERO. A caller reading 0 would conclude the judge
    // rejected everything, which is the opposite of what happened.
    expect(a.agreement).not.toBe(0)
  })

  it('reports one at or above the floor', () => {
    const a = assessSample([...judged(9, 'fits'), ...judged(3, 'does_not_fit')])
    expect(a.resolved).toBe(MIN_RESOLVED_SAMPLE)
    expect(a.agreement).toBeCloseTo(0.75)
  })

  it('counts only RESOLVED answers towards the floor', () => {
    // Twenty rows of which three resolved is a sample of three, not of twenty.
    const a = assessSample([...judged(3, 'fits'), ...judged(17, 'cannot_tell')])
    expect(a.resolved).toBe(3)
    expect(a.agreement).toBeNull()
  })

  it('reports low name signal when most rows stay unresolved, as a correct outcome', () => {
    const a = assessSample([...judged(6, 'fits'), ...judged(14, 'cannot_tell')])
    expect(a.lowNameSignal).toBe(true)
    expect(a.cannotTell).toBe(14)
  })
})

describe('a row the judge did not answer for becomes cannot_tell, not a dropped row', () => {
  it('keeps the denominator honest', () => {
    const sampleRows = [
      { sourceId: 'a', firstName: null, jobTitle: 'T', companyName: 'C' },
      { sourceId: 'b', firstName: null, jobTitle: 'T', companyName: 'C' },
    ]
    const parsed = parseVerdicts('{"verdicts":[{"id":"a","verdict":"fits","reason":"x"}]}', sampleRows)
    expect(parsed).toHaveLength(2)
    expect(parsed[1].verdict).toBe('cannot_tell')
    // Dropping it would shrink the denominator, making a judge that answers fewer rows look
    // better the more it fails to answer.
    expect(parsed[1].reason).toContain('no answer')
  })

  it('survives a response that is not JSON at all', () => {
    const sampleRows = [{ sourceId: 'a', firstName: null, jobTitle: 'T', companyName: 'C' }]
    const parsed = parseVerdicts('I am afraid I cannot help with that.', sampleRows)
    expect(parsed[0].verdict).toBe('cannot_tell')
  })
})
