// Per-organisation fairness: the property that a large batch cannot starve a small one.
//
// planClaims is pure, so the anti-starvation property is asserted directly rather than
// inferred from watching a live queue drain.

import { describe, it, expect } from 'vitest'
import { planClaims, inFlightHeadroom } from '../fairness'
import { QUEUE_CONFIG } from '../config'
import type { OrganisationBacklog } from '../types'

const org = (id: string, oldest: string, depth: number): OrganisationBacklog => ({
  organisation_id: id,
  oldest,
  depth,
})

describe('planClaims — org A does not starve org B', () => {
  it('gives org B a slice even when org A has a 3,333-job backlog', () => {
    const backlog = [
      org('org-a', '2026-08-24T09:00:00Z', 3333),
      org('org-b', '2026-08-24T09:05:00Z', 10),
    ]
    const plan = planClaims(backlog, QUEUE_CONFIG.research, 100)

    expect(plan.map(p => p.organisation_id)).toEqual(['org-a', 'org-b'])
    // The whole point: org A is capped at its SLICE, not at its depth. Its 3,333 queued
    // jobs buy it exactly the same 5 as anyone else on this pass.
    expect(plan[0].limit).toBe(QUEUE_CONFIG.research.claimBatchSize)
    // org B is capped by the same slice, not by its depth of 10. It gets served on this
    // very pass rather than waiting behind 3,333 jobs, which is the property that matters.
    expect(plan[1].limit).toBe(QUEUE_CONFIG.research.claimBatchSize)
    expect(plan[0].limit).toBe(plan[1].limit)
  })

  it('caps every organisation at claimBatchSize regardless of depth', () => {
    const backlog = [
      org('org-a', '2026-08-24T09:00:00Z', 5000),
      org('org-b', '2026-08-24T09:01:00Z', 5000),
      org('org-c', '2026-08-24T09:02:00Z', 5000),
    ]
    const plan = planClaims(backlog, QUEUE_CONFIG.research, 1000)

    for (const entry of plan) {
      expect(entry.limit).toBeLessThanOrEqual(QUEUE_CONFIG.research.claimBatchSize)
    }
    expect(plan).toHaveLength(3)
  })

  it('drains a deep backlog over repeated passes rather than in one gulp', () => {
    // Ten passes of a five-job slice is fifty jobs, not the whole 3,333. That bounded
    // rate is what leaves room for the next organisation on every tick.
    let remainingDepth = 3333
    let claimed = 0
    for (let pass = 0; pass < 10; pass++) {
      const plan = planClaims(
        [org('org-a', '2026-08-24T09:00:00Z', remainingDepth)],
        QUEUE_CONFIG.research,
        100,
      )
      claimed += plan[0].limit
      remainingDepth -= plan[0].limit
    }
    expect(claimed).toBe(QUEUE_CONFIG.research.claimBatchSize * 10)
    expect(remainingDepth).toBeGreaterThan(3000)
  })
})

describe('planClaims — ordering', () => {
  it('visits the organisation that has been waiting longest first', () => {
    const backlog = [
      org('org-new', '2026-08-24T12:00:00Z', 5),
      org('org-old', '2026-08-24T08:00:00Z', 5),
      org('org-mid', '2026-08-24T10:00:00Z', 5),
    ]
    const plan = planClaims(backlog, QUEUE_CONFIG.research, 100)
    expect(plan.map(p => p.organisation_id)).toEqual(['org-old', 'org-mid', 'org-new'])
  })

  it('sorts even when handed an unordered list', () => {
    // The SQL already orders by oldest, but this function is pure and must hold the
    // property on its own.
    const backlog = [
      org('b', '2026-08-24T11:00:00Z', 1),
      org('a', '2026-08-24T09:00:00Z', 1),
    ]
    expect(planClaims(backlog, QUEUE_CONFIG.research, 10)[0].organisation_id).toBe('a')
  })
})

describe('planClaims — the global in-flight ceiling', () => {
  it('claims nothing when there is no headroom', () => {
    const backlog = [org('org-a', '2026-08-24T09:00:00Z', 100)]
    expect(planClaims(backlog, QUEUE_CONFIG.research, 0)).toEqual([])
  })

  it('claims nothing when headroom is negative', () => {
    // Real case: the ceiling is lowered in config while jobs are already running.
    // Without the clamp, Math.min would produce a NEGATIVE claim limit.
    const backlog = [org('org-a', '2026-08-24T09:00:00Z', 100)]
    expect(planClaims(backlog, QUEUE_CONFIG.research, -5)).toEqual([])
  })

  it('never plans more than the headroom in total', () => {
    const backlog = [
      org('org-a', '2026-08-24T09:00:00Z', 100),
      org('org-b', '2026-08-24T09:01:00Z', 100),
      org('org-c', '2026-08-24T09:02:00Z', 100),
    ]
    const headroom = 7
    const plan = planClaims(backlog, QUEUE_CONFIG.research, headroom)
    expect(plan.reduce((sum, p) => sum + p.limit, 0)).toBeLessThanOrEqual(headroom)
  })

  it('stops planning once headroom runs out mid-list', () => {
    const backlog = [
      org('org-a', '2026-08-24T09:00:00Z', 100),
      org('org-b', '2026-08-24T09:01:00Z', 100),
    ]
    const plan = planClaims(backlog, QUEUE_CONFIG.research, 5)
    expect(plan).toHaveLength(1)
    expect(plan[0].limit).toBe(5)
  })

  it('never asks for more than an organisation actually has queued', () => {
    const backlog = [org('org-a', '2026-08-24T09:00:00Z', 2)]
    expect(planClaims(backlog, QUEUE_CONFIG.compose, 100)[0].limit).toBe(2)
  })

  it('drops an organisation with nothing queued rather than planning a limit of zero', () => {
    const backlog = [
      org('org-empty', '2026-08-24T09:00:00Z', 0),
      org('org-real', '2026-08-24T09:01:00Z', 3),
    ]
    const plan = planClaims(backlog, QUEUE_CONFIG.compose, 100)
    expect(plan.map(p => p.organisation_id)).toEqual(['org-real'])
  })

  it('returns an empty plan for an empty backlog', () => {
    expect(planClaims([], QUEUE_CONFIG.research, 100)).toEqual([])
  })
})

describe('inFlightHeadroom', () => {
  it('is the ceiling minus what is already running', () => {
    expect(inFlightHeadroom(QUEUE_CONFIG.research, 4)).toBe(QUEUE_CONFIG.research.maxInFlight - 4)
  })

  it('is zero, never negative, when in-flight exceeds the ceiling', () => {
    expect(inFlightHeadroom(QUEUE_CONFIG.research, 999)).toBe(0)
  })
})

describe('config sizing — the Apify ceiling is respected', () => {
  it('keeps concurrent research prospects under Apify 25-actor-run limit', () => {
    // The LinkedIn source runs TWO actors per prospect. Measured 2026-08-24:
    // maxConcurrentActorJobs = 25. If someone raises maxInFlight without raising the
    // Apify plan, this fails and says why rather than producing actor-run rejections.
    const ACTORS_PER_PROSPECT = 2
    const APIFY_MAX_CONCURRENT_ACTOR_RUNS = 25
    expect(QUEUE_CONFIG.research.maxInFlight * ACTORS_PER_PROSPECT)
      .toBeLessThanOrEqual(APIFY_MAX_CONCURRENT_ACTOR_RUNS)
  })

  it('matches the enrich batch size to Apollo bulk_match page size', () => {
    // Apollo's people/bulk_match takes ten details[] per call. A different number here
    // means either wasted calls or a silently truncated batch.
    expect(QUEUE_CONFIG.enrich.claimBatchSize).toBe(10)
  })

  it('gives every job type a lease longer than its own worst case', () => {
    // A lease shorter than the work steals a live worker's job, which double-spends.
    for (const [type, config] of Object.entries(QUEUE_CONFIG)) {
      expect(config.leaseSeconds, `${type} lease must exceed its worst case`)
        .toBeGreaterThan(config.worstCaseSeconds)
    }
  })
})
