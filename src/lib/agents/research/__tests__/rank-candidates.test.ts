// POSITIVE CONTROLS for candidate ranking.
//
// Each block isolates ONE step of the order by making every step above it equal, which is
// the only way to prove a step is doing work rather than being carried by the one before.

import { describe, it, expect } from 'vitest'
import { rankCandidates, byTriggerPositionOnly, ageInDays } from '../rank-candidates'

const NOW = new Date('2026-09-23T12:00:00Z')
const ALL = { specific: true, verifiable: true, relevant: true, useful: true, inferential: true, non_judgemental: true }
const c = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, date: '2026-09-01', scores: { ...ALL }, matched_trigger: 1, is_reshare: false, ...over }) as never

const order = (list: unknown[]) => rankCandidates(list as never, NOW).map(x => x.id)

describe('a matched trigger outranks an unmatched one', () => {
  it('however good the unmatched candidate is', () => {
    // The client's list decides what counts at all. An unmatched candidate can be newer,
    // more specific and stronger and still lose, because it is not a thing they asked for.
    expect(order([
      c('unmatched', { matched_trigger: null, date: '2026-09-22' }),
      c('matched', { matched_trigger: 11, date: '2026-01-01' }),
    ])).toEqual(['matched', 'unmatched'])
  })

  it('and unmatched candidates are still sorted among themselves', () => {
    // A client with no triggers has nothing matched, and still needs an order.
    expect(order([
      c('old', { matched_trigger: null, date: '2026-01-01' }),
      c('new', { matched_trigger: null, date: '2026-09-20' }),
    ])).toEqual(['new', 'old'])
  })
})

describe('their own post outranks a reshare', () => {
  it('even when the reshare is newer and matched a stronger trigger', () => {
    // A reshare is not their event. 2 of Jason Shapiro's 5 posts were reshares on
    // 2026-09-23 and synthesis built candidates from both, crediting him with writing them.
    expect(order([
      c('reshare', { is_reshare: true, date: '2026-09-22', matched_trigger: 1 }),
      c('own', { is_reshare: false, date: '2026-03-01', matched_trigger: 9 }),
    ])).toEqual(['own', 'reshare'])
  })

  it('but a reshare still wins when nothing of their own qualifies', () => {
    // Kept in the list rather than dropped: what someone amplifies is a fact about them.
    expect(order([
      c('reshare', { is_reshare: true }),
      c('own_unmatched', { is_reshare: false, matched_trigger: null }),
    ])).toEqual(['reshare', 'own_unmatched'])
  })
})

describe('recency, once matching and ownership are equal', () => {
  it('newer wins', () => {
    expect(order([c('older', { date: '2026-02-01' }), c('newer', { date: '2026-09-10' })]))
      .toEqual(['newer', 'older'])
  })

  it('RECENCY BEATS TRIGGER POSITION, which is the whole point of this change', () => {
    // A nine-month-old instance of trigger 1 is worse copy than last week's instance of
    // trigger 6, and ranking by position alone cannot see that.
    expect(order([
      c('old_strong_trigger', { matched_trigger: 1, date: '2026-01-05' }),
      c('recent_weak_trigger', { matched_trigger: 6, date: '2026-09-18' }),
    ])).toEqual(['recent_weak_trigger', 'old_strong_trigger'])
  })

  it('an undated candidate sorts below every dated one', () => {
    // "We could not tell when" is not "it was recent", and only one is worth writing.
    expect(order([
      c('undated', { date: null }),
      c('ancient', { date: '2025-01-01' }),
    ])).toEqual(['ancient', 'undated'])
  })
})

describe('specificity, then reason strength, then position', () => {
  it('specificity breaks a recency tie, from specific and verifiable', () => {
    expect(order([
      c('vague', { scores: { ...ALL, specific: false, verifiable: false } }),
      c('specific', { scores: { ...ALL } }),
    ])).toEqual(['specific', 'vague'])
  })

  it('reason strength breaks a specificity tie, from relevant and useful', () => {
    const base = { specific: true, verifiable: true, inferential: true, non_judgemental: true }
    expect(order([
      c('weak_reason', { scores: { ...base, relevant: false, useful: false } }),
      c('strong_reason', { scores: { ...base, relevant: true, useful: true } }),
    ])).toEqual(['strong_reason', 'weak_reason'])
  })

  it('trigger position is the LAST word, not the first', () => {
    // Everything above equal: now the client's own ordering is the best signal left.
    expect(order([c('pos9', { matched_trigger: 9 }), c('pos2', { matched_trigger: 2 })]))
      .toEqual(['pos2', 'pos9'])
  })

  it('the sort is total, so a run is reproducible', () => {
    const twice = [order([c('b'), c('a')]), order([c('a'), c('b')])]
    expect(twice[0]).toEqual(twice[1])
  })
})

describe('ageInDays', () => {
  it('reads day, month and year precision', () => {
    expect(ageInDays('2026-09-13', NOW)).toBe(10)
    expect(ageInDays('2026-08', NOW)).toBeGreaterThan(30)
    expect(ageInDays('2025', NOW)).toBeGreaterThan(300)
  })

  it('returns null rather than a wrong number for unparseable text', () => {
    expect(ageInDays(null, NOW)).toBeNull()
    expect(ageInDays('approximate: some time ago', NOW)).toBeNull()
  })
})

describe('byTriggerPositionOnly is the comparison, never the selector', () => {
  it('picks purely by list position, which is what this change moved away from', () => {
    const list = [c('recent_pos6', { matched_trigger: 6, date: '2026-09-20' }),
                  c('old_pos1', { matched_trigger: 1, date: '2026-01-01' })]
    expect(byTriggerPositionOnly(list as never).map(x => x.id)[0]).toBe('old_pos1')
    expect(order(list)[0]).toBe('recent_pos6')
  })

  it('ignores unmatched candidates entirely', () => {
    expect(byTriggerPositionOnly([c('x', { matched_trigger: null })] as never)).toEqual([])
  })
})
