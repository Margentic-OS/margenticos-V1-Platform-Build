// RULE ZERO: every fragment and every "job title" in this file is an abstract token.
// None is a real job title, in any market. The behaviour under test is substring
// matching and threshold arithmetic, neither of which needs a real title to exercise,
// and a real title in a fixture is one copy-paste away from a real title in a prompt.

import { describe, it, expect } from 'vitest'
import {
  evaluateBuyerCriterion,
  checkSanityBand,
  seniorityScoreFor,
  tokeniseJobTitle,
  MIN_SANITY_SAMPLE,
  MIN_ACCEPT_RATE,
  MAX_ACCEPT_RATE,
  SENIORITY_SCORE_PRIMARY,
  SENIORITY_SCORE_SECONDARY,
  type BuyerCriterion,
} from '@/lib/sourcing/buyer-criterion'

function criterion(over: Partial<BuyerCriterion> = {}): BuyerCriterion {
  return {
    status: 'derived',
    accept: [{ fragment: 'alpha', rank: 'primary' }],
    reject: [],
    statement: 'Fixture.',
    evidence: [],
    unsettled_reason: null,
    sanity: null,
    derived_at: '2026-09-02T00:00:00.000Z',
    model: 'test',
    ...over,
  }
}

describe('evaluateBuyerCriterion', () => {
  it('accepts a title containing a primary fragment', () => {
    expect(evaluateBuyerCriterion(criterion(), 'alpha')).toEqual({ decision: 'accept', rank: 'primary' })
  })

  it('rejects a title containing no accepting fragment', () => {
    expect(evaluateBuyerCriterion(criterion(), 'omega')).toEqual({ decision: 'reject' })
  })

  it('is case-insensitive', () => {
    expect(evaluateBuyerCriterion(criterion(), 'ALPHA').decision).toBe('accept')
  })

  it('matches inside one part of a compound title', () => {
    for (const joined of ['omega & alpha', 'omega / alpha', 'omega | alpha', 'omega + alpha', 'omega and alpha', 'omega, alpha']) {
      expect(evaluateBuyerCriterion(criterion(), joined).decision).toBe('accept')
    }
  })

  it('prefers primary over secondary when both match', () => {
    const c = criterion({
      accept: [{ fragment: 'beta', rank: 'secondary' }, { fragment: 'alpha', rank: 'primary' }],
    })
    expect(evaluateBuyerCriterion(c, 'beta alpha')).toEqual({ decision: 'accept', rank: 'primary' })
  })

  it('returns secondary when only a secondary fragment matches', () => {
    const c = criterion({ accept: [{ fragment: 'beta', rank: 'secondary' }] })
    expect(evaluateBuyerCriterion(c, 'beta')).toEqual({ decision: 'accept', rank: 'secondary' })
  })

  it('lets a reject fragment beat an accept fragment', () => {
    // This is what stops a proxy role passing. Such a role is named after the role it
    // supports, so it contains an accepting fragment by construction.
    const c = criterion({ reject: ['gamma'] })
    expect(evaluateBuyerCriterion(c, 'gamma to the alpha')).toEqual({ decision: 'reject' })
  })

  describe('does not decide, and says so, rather than accepting by default', () => {
    // Each of these must be distinguishable from `accept`. "We checked and this person
    // qualifies" and "we never checked" have to look different downstream, because the
    // caller fails open on the second and must warn when it does.
    it('when there is no criterion at all', () => {
      expect(evaluateBuyerCriterion(null, 'alpha')).toEqual({ decision: 'no_criterion', why: 'absent' })
    })

    it('when the documents did not settle who decides', () => {
      expect(evaluateBuyerCriterion(criterion({ status: 'unsettled' }), 'alpha'))
        .toEqual({ decision: 'no_criterion', why: 'unsettled' })
    })

    it('when the criterion failed the sanity band', () => {
      expect(evaluateBuyerCriterion(criterion({ status: 'out_of_band' }), 'alpha'))
        .toEqual({ decision: 'no_criterion', why: 'out_of_band' })
    })

    it('when the criterion accepts nothing, which would otherwise reject everyone', () => {
      expect(evaluateBuyerCriterion(criterion({ accept: [] }), 'alpha'))
        .toEqual({ decision: 'no_criterion', why: 'absent' })
    })
  })

  it('does not judge a missing title', () => {
    for (const empty of [null, '', '   ']) {
      expect(evaluateBuyerCriterion(criterion(), empty).decision).toBe('no_title')
    }
  })
})

describe('tokeniseJobTitle', () => {
  it('drops empty parts rather than matching on them', () => {
    expect(tokeniseJobTitle('alpha //  & beta')).toEqual(['alpha', 'beta'])
  })
})

describe('seniorityScoreFor', () => {
  it('scores an accepted prospect by rank and everything else zero', () => {
    expect(seniorityScoreFor({ decision: 'accept', rank: 'primary' })).toBe(SENIORITY_SCORE_PRIMARY)
    expect(seniorityScoreFor({ decision: 'accept', rank: 'secondary' })).toBe(SENIORITY_SCORE_SECONDARY)
    expect(seniorityScoreFor({ decision: 'reject' })).toBe(0)
    expect(seniorityScoreFor({ decision: 'no_title' })).toBe(0)
    expect(seniorityScoreFor({ decision: 'no_criterion', why: 'absent' })).toBe(0)
  })
})

describe('the sanity band', () => {
  // Constructed inputs, because the band is arithmetic on an acceptance rate and the
  // point is to drive it past each threshold deliberately.
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)

  it('does not measure a sample too small to mean anything', () => {
    const result = checkSanityBand(criterion(), many(MIN_SANITY_SAMPLE - 1, 'alpha'))
    expect(result.sanity.checked).toBe(false)
    expect(result.sanity.accept_rate).toBeNull()
    expect(result.status).toBe('derived')
    expect(result.sanity.note).toContain('Not checked')
  })

  it('counts DISTINCT titles, so one title repeated is not a sample', () => {
    const repeated = Array.from({ length: MIN_SANITY_SAMPLE * 4 }, () => 'alpha')
    expect(checkSanityBand(criterion(), repeated).sanity.checked).toBe(false)
  })

  it('FIRES when the criterion would reject almost everything', () => {
    // The failure this exists to catch: a criterion that rejects the whole batch is
    // indistinguishable, on the operator's screen, from a client with no prospects.
    const sample = [...many(MIN_SANITY_SAMPLE * 2, 'omega'), 'alpha']
    const result = checkSanityBand(criterion(), sample)
    expect(result.status).toBe('out_of_band')
    expect(result.sanity.accept_rate!).toBeLessThan(MIN_ACCEPT_RATE)
    expect(result.sanity.note).toContain('Not applied')
  })

  it('FIRES when the criterion would accept almost everything', () => {
    const sample = [...many(MIN_SANITY_SAMPLE * 2, 'alpha'), 'omega']
    const result = checkSanityBand(criterion(), sample)
    expect(result.status).toBe('out_of_band')
    expect(result.sanity.accept_rate!).toBeGreaterThan(MAX_ACCEPT_RATE)
  })

  it('an out-of-band criterion does not gate, so the batch is not silently destroyed', () => {
    const sample = [...many(MIN_SANITY_SAMPLE * 2, 'omega'), 'alpha']
    const { status } = checkSanityBand(criterion(), sample)
    expect(evaluateBuyerCriterion(criterion({ status }), 'omega').decision).toBe('no_criterion')
  })

  it('passes a criterion that lands inside the band', () => {
    const sample = [...many(20, 'alpha'), ...many(30, 'omega')]
    const result = checkSanityBand(criterion(), sample)
    expect(result.status).toBe('derived')
    expect(result.sanity.accept_rate).toBeCloseTo(0.4)
  })

  it('measures the criterion itself, not the status it arrived with', () => {
    // An unsettled criterion is still measured, so its rate is on record when an
    // operator comes to resolve it.
    const sample = [...many(20, 'alpha'), ...many(30, 'omega')]
    const result = checkSanityBand(criterion({ status: 'unsettled' }), sample)
    expect(result.sanity.accept_rate).toBeCloseTo(0.4)
    expect(result.status).toBe('unsettled')
  })
})
