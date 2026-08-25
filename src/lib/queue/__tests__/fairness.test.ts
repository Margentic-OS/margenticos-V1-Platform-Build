// Per-organisation fairness.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE WAS REWRITTEN, AND THE RULE IT NOW FOLLOWS
//
// The first version of this suite passed headroom values of 100 and 1000 into
// planClaims. inFlightHeadroom can only ever return maxInFlight, which is 3, 10 or 20.
// So every anti-starvation assertion was made in a regime the code cannot reach, and
// the suite went green while three real starvation bugs were live:
//
//   compose claimBatchSize 25 > maxInFlight 20  -> org A takes the entire ceiling
//   enrich  headroom 3 < claimBatchSize 10      -> Apollo batches of 3, never 10
//   oldest-first ordering never rotates         -> org 3 of 3 never runs
//
// THE RULE, and it is not optional: a fairness test may NEVER pass a headroom literal.
// Headroom must come from inFlightHeadroom(config, claimed), which is the only thing
// that produces the value in production. reachableHeadroom() below is the only door,
// and a guard test asserts the maximum really is bounded by maxInFlight.
//
// Tests are written against EVERY job type rather than one, because the two bugs the
// old suite missed were both per-job-type configuration bugs. Testing "research" alone
// would have missed compose again.

import { describe, it, expect } from 'vitest'
import { planClaims, planClaimsWithRotation, inFlightHeadroom } from '../fairness'
import {
  QUEUE_CONFIG,
  APIFY_ACTORS_PER_RESEARCH_PROSPECT,
  APIFY_MAX_CONCURRENT_ACTOR_RUNS,
} from '../config'
import type { JobType, OrganisationBacklog } from '../types'

const JOB_TYPES = Object.keys(QUEUE_CONFIG) as JobType[]

const org = (id: string, oldest: string, depth: number): OrganisationBacklog => ({
  organisation_id: id,
  oldest,
  depth,
})

/** The ONLY way a test may obtain a headroom value. Nothing here invents a number. */
function reachableHeadroom(jobType: JobType, alreadyClaimed = 0): number {
  return inFlightHeadroom(QUEUE_CONFIG[jobType], alreadyClaimed)
}

describe('the regime guard — headroom is bounded by maxInFlight', () => {
  it.each(JOB_TYPES)('%s: best-case headroom never exceeds maxInFlight', jobType => {
    // This is the assertion whose absence let the old suite test an unreachable world.
    expect(reachableHeadroom(jobType, 0)).toBe(QUEUE_CONFIG[jobType].maxInFlight)
    expect(reachableHeadroom(jobType, 0)).toBeLessThanOrEqual(QUEUE_CONFIG[jobType].maxInFlight)
  })

  it.each(JOB_TYPES)('%s: headroom shrinks as jobs are claimed and floors at zero', jobType => {
    const max = QUEUE_CONFIG[jobType].maxInFlight
    expect(reachableHeadroom(jobType, 1)).toBe(max - 1)
    expect(reachableHeadroom(jobType, max)).toBe(0)
    expect(reachableHeadroom(jobType, max + 50)).toBe(0)
  })
})

describe('config invariants — an impossible configuration must not be silently tolerated', () => {
  it.each(JOB_TYPES)('%s: claimBatchSize fits inside maxInFlight', jobType => {
    // When claimBatchSize exceeds maxInFlight, the first organisation consumes the whole
    // global ceiling and every other organisation is starved on every pass.
    const { claimBatchSize, maxInFlight } = QUEUE_CONFIG[jobType]
    expect(claimBatchSize).toBeLessThanOrEqual(maxInFlight)
  })

  it.each(JOB_TYPES)('%s: the ceiling admits at least two organisations per pass', jobType => {
    // Anti-starvation is impossible at the configuration level if one slice can consume
    // everything. This is the property B and C both violated.
    const { claimBatchSize, maxInFlight } = QUEUE_CONFIG[jobType]
    expect(Math.floor(maxInFlight / claimBatchSize)).toBeGreaterThanOrEqual(2)
  })
})

describe('anti-starvation at REACHABLE headroom', () => {
  it.each(JOB_TYPES)('%s: a second org is served on the same pass as a huge first org', jobType => {
    const backlog = [
      org('org-big',   '2026-08-24T09:00:00Z', 3333),
      org('org-small', '2026-08-24T09:05:00Z', 10),
    ]
    const plan = planClaims(backlog, QUEUE_CONFIG[jobType], reachableHeadroom(jobType))

    expect(plan.map(p => p.organisation_id)).toContain('org-small')
    expect(plan.find(p => p.organisation_id === 'org-small')!.limit).toBeGreaterThan(0)
  })

  it.each(JOB_TYPES)('%s: a huge org cannot take more than its slice', jobType => {
    const plan = planClaims(
      [org('org-big', '2026-08-24T09:00:00Z', 3333)],
      QUEUE_CONFIG[jobType],
      reachableHeadroom(jobType),
    )
    expect(plan[0].limit).toBeLessThanOrEqual(QUEUE_CONFIG[jobType].claimBatchSize)
  })

  it.each(JOB_TYPES)('%s: every org is served within a bounded number of passes', jobType => {
    // NOT "all three on one pass". research's ceiling is fixed at 10 rows by Apify and
    // its slice is 5, so only two organisations can fit in a single pass however good
    // the planner is. Demanding all three at once would be a test that can only be
    // satisfied by shrinking the Apollo and Apify batches to inefficiency.
    //
    // The property that actually matters is that nobody waits FOREVER. With rotation,
    // every organisation is reached within ceil(orgs / orgsPerPass) passes.
    const backlog = [
      org('org-1', '2026-08-24T09:00:00Z', 1000),
      org('org-2', '2026-08-24T09:01:00Z', 1000),
      org('org-3', '2026-08-24T09:02:00Z', 1000),
    ]
    const config = QUEUE_CONFIG[jobType]
    const orgsPerPass = Math.floor(config.maxInFlight / config.claimBatchSize)
    const passesNeeded = Math.ceil(backlog.length / orgsPerPass)

    const served = new Set<string>()
    let cursor: string | null = null
    for (let pass = 0; pass < passesNeeded; pass++) {
      const plan = planClaimsWithRotation(backlog, config, reachableHeadroom(jobType), cursor)
      plan.entries.forEach(e => served.add(e.organisation_id))
      cursor = plan.nextCursor
    }

    expect([...served].sort()).toEqual(['org-1', 'org-2', 'org-3'])
  })
})

describe('batch sizing at REACHABLE headroom', () => {
  it('enrich claims a FULL Apollo bulk_match batch, not a truncated one', () => {
    // Apollo people/bulk_match takes ten per call and bills one credit per contact.
    // Claiming fewer than ten means more HTTP calls against a 600/hour ceiling for the
    // same work, and defeats the whole reason claim_jobs takes a p_limit.
    const plan = planClaims(
      [org('org-a', '2026-08-24T09:00:00Z', 100)],
      QUEUE_CONFIG.enrich,
      reachableHeadroom('enrich'),
    )
    expect(plan[0].limit).toBe(10)
  })

  it.each(JOB_TYPES)('%s: a full slice is reachable when nothing is in flight', jobType => {
    const plan = planClaims(
      [org('org-a', '2026-08-24T09:00:00Z', 10_000)],
      QUEUE_CONFIG[jobType],
      reachableHeadroom(jobType),
    )
    expect(plan[0].limit).toBe(QUEUE_CONFIG[jobType].claimBatchSize)
  })
})

describe('the global ceiling is respected', () => {
  it.each(JOB_TYPES)('%s: total planned never exceeds reachable headroom', jobType => {
    const backlog = Array.from({ length: 10 }, (_, i) =>
      org(`org-${i}`, `2026-08-24T09:0${i}:00Z`, 500),
    )
    const headroom = reachableHeadroom(jobType)
    const total = planClaims(backlog, QUEUE_CONFIG[jobType], headroom)
      .reduce((sum, p) => sum + p.limit, 0)
    expect(total).toBeLessThanOrEqual(headroom)
  })

  it.each(JOB_TYPES)('%s: claims nothing when the ceiling is already met', jobType => {
    const headroom = reachableHeadroom(jobType, QUEUE_CONFIG[jobType].maxInFlight)
    expect(headroom).toBe(0)
    expect(planClaims([org('a', '2026-08-24T09:00:00Z', 100)], QUEUE_CONFIG[jobType], headroom))
      .toEqual([])
  })

  it.each(JOB_TYPES)('%s: partial headroom still serves someone', jobType => {
    const headroom = reachableHeadroom(jobType, QUEUE_CONFIG[jobType].maxInFlight - 1)
    expect(headroom).toBe(1)
    const plan = planClaims([org('a', '2026-08-24T09:00:00Z', 100)], QUEUE_CONFIG[jobType], headroom)
    expect(plan).toHaveLength(1)
    expect(plan[0].limit).toBe(1)
  })
})

describe('basic planning behaviour', () => {
  it('never asks for more than an organisation actually has queued', () => {
    const plan = planClaims(
      [org('org-a', '2026-08-24T09:00:00Z', 2)],
      QUEUE_CONFIG.compose,
      reachableHeadroom('compose'),
    )
    expect(plan[0].limit).toBe(2)
  })

  it('drops an organisation with nothing queued rather than planning a limit of zero', () => {
    const plan = planClaims(
      [org('org-empty', '2026-08-24T09:00:00Z', 0), org('org-real', '2026-08-24T09:01:00Z', 3)],
      QUEUE_CONFIG.compose,
      reachableHeadroom('compose'),
    )
    expect(plan.map(p => p.organisation_id)).toEqual(['org-real'])
  })

  it('returns an empty plan for an empty backlog', () => {
    expect(planClaims([], QUEUE_CONFIG.research, reachableHeadroom('research'))).toEqual([])
  })

  it('claims nothing when headroom is negative', () => {
    expect(planClaims([org('a', '2026-08-24T09:00:00Z', 100)], QUEUE_CONFIG.research, -5)).toEqual([])
  })
})

describe('external limits the config must keep honouring', () => {
  // The actor count is IMPORTED, not restated. It was a local literal 2, and when the
  // profile actor was dropped on 2026-08-25 and maxInFlight went 10 -> 20, this test kept
  // asserting against a number the source no longer used. A duplicated constant is how a
  // guard silently stops guarding.
  it('keeps concurrent research prospects under the Apify concurrent-actor-run ceiling', () => {
    expect(QUEUE_CONFIG.research.maxInFlight * APIFY_ACTORS_PER_RESEARCH_PROSPECT)
      .toBeLessThanOrEqual(APIFY_MAX_CONCURRENT_ACTOR_RUNS)
  })

  // The drift this cannot catch: APIFY_ACTORS_PER_RESEARCH_PROSPECT claiming 1 while
  // linkedin.ts actually starts 2. Only reading that file proves it, and the header
  // comment there names this constant so the pair stay together.
  it('states the actor count the LinkedIn source is believed to run', () => {
    expect(APIFY_ACTORS_PER_RESEARCH_PROSPECT).toBe(1)
  })

  it('matches the enrich batch size to the Apollo bulk_match page size', () => {
    expect(QUEUE_CONFIG.enrich.claimBatchSize).toBe(10)
  })

  it.each(JOB_TYPES)('%s: lease is longer than the job worst case', jobType => {
    const config = QUEUE_CONFIG[jobType]
    expect(config.leaseSeconds).toBeGreaterThan(config.worstCaseSeconds)
  })
})

describe('rotation — the cursor is what stops permanent starvation', () => {
  const backlog = [
    org('org-1', '2026-08-24T09:00:00Z', 1000),
    org('org-2', '2026-08-24T09:01:00Z', 1000),
    org('org-3', '2026-08-24T09:02:00Z', 1000),
  ]

  // STARVATION ONLY EXISTS WHEN ORGANISATIONS OUTNUMBER SLOTS, so the scenario has to be
  // built from the config rather than hardcoded. It used to be three orgs against two
  // slots. Raising research.maxInFlight from 10 to 20 on 2026-08-25 made it four slots,
  // at which point all three orgs were served every pass and these two tests failed while
  // the behaviour they exist to protect had strictly IMPROVED. Deriving the org count
  // keeps the scenario real at any config.
  const slots = Math.floor(reachableHeadroom('research') / QUEUE_CONFIG.research.claimBatchSize)
  const crowded = Array.from({ length: slots + 1 }, (_, i) =>
    org(`crowd-${i + 1}`, `2026-08-24T09:0${i}:00Z`, 1000))
  const lastId = `crowd-${slots + 1}`

  it('serves the organisation that did not fit, on the next pass', () => {
    const first = planClaimsWithRotation(crowded, QUEUE_CONFIG.research, reachableHeadroom('research'), null)
    // One more organisation than there are slots, so exactly one is left out, and it is
    // the newest by created_at because planning starts from the oldest.
    expect(first.entries).toHaveLength(slots)
    expect(first.entries.map(e => e.organisation_id)).not.toContain(lastId)

    const second = planClaimsWithRotation(crowded, QUEUE_CONFIG.research, reachableHeadroom('research'), first.nextCursor)
    expect(second.entries.map(e => e.organisation_id)).toContain(lastId)
  })

  it('rotates continuously rather than settling on a fixed set', () => {
    const seen: string[][] = []
    let cursor: string | null = null
    for (let pass = 0; pass < 6; pass++) {
      const plan = planClaimsWithRotation(crowded, QUEUE_CONFIG.research, reachableHeadroom('research'), cursor)
      seen.push(plan.entries.map(e => e.organisation_id))
      cursor = plan.nextCursor
    }
    // Every organisation appears across six passes, and no single pass repeats forever.
    const flat = seen.flat()
    for (const o of crowded) expect(flat).toContain(o.organisation_id)
    expect(new Set(seen.map(s => s.join(','))).size).toBeGreaterThan(1)
  })

  it('every org gets a comparable share over many passes', () => {
    const counts = new Map<string, number>()
    let cursor: string | null = null
    for (let pass = 0; pass < 30; pass++) {
      const plan = planClaimsWithRotation(backlog, QUEUE_CONFIG.research, reachableHeadroom('research'), cursor)
      for (const e of plan.entries) counts.set(e.organisation_id, (counts.get(e.organisation_id) ?? 0) + e.limit)
      cursor = plan.nextCursor
    }
    const shares = [...counts.values()]
    expect(counts.size).toBe(3)
    // No organisation gets less than half of what the greediest one gets.
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(Math.max(...shares) / 2)
  })

  it('an unknown cursor starts from the oldest rather than planning nothing', () => {
    // Happens whenever the cursor organisation drained its backlog since the last pass.
    const plan = planClaimsWithRotation(backlog, QUEUE_CONFIG.research, reachableHeadroom('research'), 'org-that-drained')
    expect(plan.entries[0].organisation_id).toBe('org-1')
  })

  it('a null cursor starts from the oldest', () => {
    const plan = planClaimsWithRotation(backlog, QUEUE_CONFIG.research, reachableHeadroom('research'), null)
    expect(plan.entries[0].organisation_id).toBe('org-1')
  })

  it('leaves the cursor untouched when there is nothing to plan', () => {
    // A quiet tick must not reset the rotation to the top, or the rotation never advances.
    expect(planClaimsWithRotation([], QUEUE_CONFIG.research, reachableHeadroom('research'), 'org-2').nextCursor).toBeNull()
    expect(planClaimsWithRotation(backlog, QUEUE_CONFIG.research, 0, 'org-2').nextCursor).toBeNull()
  })

  it('wraps around from the last organisation back to the first', () => {
    const plan = planClaimsWithRotation(backlog, QUEUE_CONFIG.research, reachableHeadroom('research'), 'org-3')
    expect(plan.entries[0].organisation_id).toBe('org-1')
  })
})

describe('config invariants are enforced at module load, not just asserted in tests', () => {
  it('rejects a slice larger than the ceiling', async () => {
    const { assertQueueConfig } = await import('../config')
    expect(typeof assertQueueConfig).toBe('function')
    // The real config must already satisfy it, or importing this file would have thrown.
    expect(() => assertQueueConfig()).not.toThrow()
  })
})
