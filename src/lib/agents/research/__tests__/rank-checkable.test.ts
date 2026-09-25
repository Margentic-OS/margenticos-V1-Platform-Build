// A candidate a reader cannot verify never outranks one they can.
//
// THE CASE THIS WAS WRITTEN FOR, measured 2026-09-25. One prospect's selected hook was a
// web-search snippet with no URL, dated "approximately August 2026". The year-precision parse
// resolved that to January and scored it 267 days old. It beat a three-day-old LinkedIn post
// carrying a profile URL.
//
// AND IT DID NOT WIN ON TRIGGER RANK, which is what the recorded selection_reason claimed. It
// won because the snippet was an own post and the LinkedIn item was a reshare, and own_post is
// read before recency. That is why the new step sits ABOVE own_post: a rule placed below it
// would have left the outcome unchanged while appearing to fix it.
//
// RULE ZERO. The fixtures are shaped like the real case and carry no real identity.

import { describe, it, expect } from 'vitest'
import { rankCandidates, isLocatable, datePrecision } from '../rank-candidates'

const NOW = new Date('2026-09-25T00:00:00Z')

/** The undated, unsourced snippet: best trigger position, own post, nothing checkable. */
const SNIPPET = {
  id: 'snippet',
  date: 'approximately August 2026',
  source: 'web_search',
  provenance: "Web search result: 'the firm posted a hiring announcement approximately one month prior'",
  matched_trigger: 1,
  is_reshare: false,
  scores: { specific: true, verifiable: true, relevant: true, useful: true },
}

/** The dated, sourced reshare: worse trigger position, a reshare, fully checkable. */
const DATED_RESHARE = {
  id: 'dated',
  date: '2026-09-22',
  source: 'linkedin',
  provenance: 'LinkedIn reshare dated 2026-09-22, http://www.linkedin.com/in/example',
  matched_trigger: 6,
  is_reshare: true,
  scores: { specific: true, verifiable: true, relevant: true, useful: true },
}

const order = (cs: Parameters<typeof rankCandidates>[0]) =>
  rankCandidates(cs, NOW).map(c => c.id)

describe('checkable outranks uncheckable', () => {
  it('THE CONTROL: the dated, sourced candidate wins over the undated snippet', () => {
    expect(order([SNIPPET, DATED_RESHARE])[0]).toBe('dated')
  })

  it('wins from either input order, so it is the sort and not the input', () => {
    expect(order([DATED_RESHARE, SNIPPET])[0]).toBe('dated')
  })

  it('wins DESPITE a better trigger position on the snippet', () => {
    const r = rankCandidates([SNIPPET, DATED_RESHARE], NOW)
    expect(r[0].id).toBe('dated')
    expect(r[0].rank_basis.trigger_position).toBe(6)
    expect(r[1].rank_basis.trigger_position).toBe(1)
  })

  it('wins DESPITE being a reshare against an own post', () => {
    const r = rankCandidates([SNIPPET, DATED_RESHARE], NOW)
    expect(r[0].rank_basis.own_post).toBe(false)
    expect(r[1].rank_basis.own_post).toBe(true)
  })

  it('records why, so the ordering can be checked rather than trusted', () => {
    const r = rankCandidates([SNIPPET, DATED_RESHARE], NOW)
    expect(r.find(c => c.id === 'dated')!.rank_basis.checkable).toBe(true)
    expect(r.find(c => c.id === 'snippet')!.rank_basis.checkable).toBe(false)
  })

  // ─── THE OTHER DIRECTION. Without these the step could be inverting the whole sort. ───

  it('CONTROL: between two CHECKABLE candidates the existing order still decides', () => {
    // Both checkable, so the new step is a tie and own_post decides as it always did.
    const ownPost = { ...DATED_RESHARE, id: 'own', is_reshare: false }
    const reshare = { ...DATED_RESHARE, id: 'resh', is_reshare: true }
    expect(order([reshare, ownPost])[0]).toBe('own')
  })

  it('CONTROL: between two UNCHECKABLE candidates the existing order still decides', () => {
    const a = { ...SNIPPET, id: 'a', is_reshare: true }
    const b = { ...SNIPPET, id: 'b', is_reshare: false }
    expect(order([a, b])[0]).toBe('b')
  })

  it('CONTROL: a trigger match still outranks everything, checkable or not', () => {
    const unmatchedButCheckable = { ...DATED_RESHARE, id: 'nomatch', matched_trigger: null }
    expect(order([unmatchedButCheckable, SNIPPET])[0]).toBe('snippet')
  })
})

describe('what counts as locatable', () => {
  it('a bare domain counts, because that is how website provenance is recorded', () => {
    expect(isLocatable('example-firm.com/resources/blog, post dated July 8, 2026')).toBe(true)
  })

  it('a full URL counts', () => {
    expect(isLocatable('LinkedIn post dated 2026-09-22, http://www.linkedin.com/in/example')).toBe(true)
  })

  it('an enrichment record does not', () => {
    expect(isLocatable('Apollo employment_history: Founder & CEO, since 2018-04-01, present')).toBe(false)
  })

  it('a quoted search snippet does not', () => {
    expect(isLocatable("Web search result: 'the firm is a small business'")).toBe(false)
  })

  it('null and empty do not', () => {
    expect(isLocatable(null)).toBe(false)
    expect(isLocatable('')).toBe(false)
  })
})

describe('an approximate date is not day-precise', () => {
  it('"approximately August 2026" reads as year precision, not day', () => {
    expect(datePrecision('approximately August 2026')).toBe('year')
  })
  it('CONTROL: an ISO date is day precision', () => {
    expect(datePrecision('2026-09-22')).toBe('day')
  })
})
