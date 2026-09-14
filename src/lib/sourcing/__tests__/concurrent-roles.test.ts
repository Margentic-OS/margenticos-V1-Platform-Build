// COUNTING A SECOND JOB, FROM DATA ENRICHMENT ALREADY BOUGHT.
//
// The research synthesis call used to decide this, after the verification probe and after
// $0.13 to $0.19 of model spend, and it was shown only the three most recent positions while
// the stored array averages 7.6. These tests pin what the count does and, as importantly,
// what it refuses to decide.
//
// RULE ZERO: no job title appears below. The check is structural — it counts employers, and
// never reads what a position is called.

import { describe, it, expect } from 'vitest'
import {
  countConcurrentCurrentRoles, holdsAnotherCurrentRole, CONCURRENT_ROLES_THAT_REMOVE,
} from '../concurrent-roles'

const entry = (over: Record<string, unknown> = {}) => ({
  organization_name: 'Placeholder Employer', start_date: '2020-01-01', end_date: null,
  current: true, kind: 'employment', ...over,
})

const blob = (history: unknown[], ownOrgId: string | null = 'own-org') => ({
  organization_id: ownOrgId,
  employment_history: history,
})

describe('counting current positions at other employers', () => {
  it('counts a current position the provider attributes to another employer', () => {
    const c = countConcurrentCurrentRoles(blob([entry({ organization_id: 'own-org' }), entry({ organization_id: 'other-org' })]))
    expect(c).toEqual({ identified: 1, ambiguous: 0 })
    expect(holdsAnotherCurrentRole(blob([entry({ organization_id: 'other-org' })]))).toBe(true)
  })

  it('does not count their own employer, however many entries it has', () => {
    const c = countConcurrentCurrentRoles(blob([entry({ organization_id: 'own-org' }), entry({ organization_id: 'own-org' })]))
    expect(c).toEqual({ identified: 0, ambiguous: 0 })
  })

  it('does not count a position that has ended', () => {
    const past = entry({ organization_id: 'other-org', current: false, end_date: '2023-06-01' })
    expect(countConcurrentCurrentRoles(blob([past]))).toEqual({ identified: 0, ambiguous: 0 })
  })

  it('treats an entry with no employer id as AMBIGUOUS, never as another job', () => {
    // Measured on one client: 33 prospects had an identified second employer and 20 had an
    // entry like this. The second group is what the judge is for.
    const c = countConcurrentCurrentRoles(blob([entry({ organization_id: null })]))
    expect(c).toEqual({ identified: 0, ambiguous: 1 })
    expect(holdsAnotherCurrentRole(blob([entry({ organization_id: null })]))).toBe(false)
  })

  it('reads an open-ended position with no current flag as current', () => {
    const openEnded = { organization_id: 'other-org', start_date: '2021-01-01', end_date: null }
    expect(countConcurrentCurrentRoles(blob([openEnded])).identified).toBe(1)
  })

  it('is ambiguous about every employer when the person has no employer id of their own', () => {
    const c = countConcurrentCurrentRoles(blob([entry({ organization_id: 'other-org' })], null))
    expect(c).toEqual({ identified: 0, ambiguous: 1 })
  })

  it('counts nothing, rather than throwing, on a row whose shape is not what is expected', () => {
    for (const bad of [null, undefined, {}, { employment_history: null }, { employment_history: 'text' }, 42, 'text']) {
      expect(countConcurrentCurrentRoles(bad)).toEqual({ identified: 0, ambiguous: 0 })
      expect(holdsAnotherCurrentRole(bad)).toBe(false)
    }
    expect(countConcurrentCurrentRoles(blob([null, 'text', 7]))).toEqual({ identified: 0, ambiguous: 0 })
  })

  it('removes on one identified position, which is the stated threshold', () => {
    expect(CONCURRENT_ROLES_THAT_REMOVE).toBe(1)
    const history = Array.from({ length: CONCURRENT_ROLES_THAT_REMOVE }, () => entry({ organization_id: 'other-org' }))
    expect(holdsAnotherCurrentRole(blob(history))).toBe(true)
  })
})
