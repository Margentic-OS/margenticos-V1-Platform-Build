// The fixed rules that turn the judge's dimension readings into a grade, and the quotation check
// that decides whether a reading counts at all.
//
// The judge disagreed with itself on 8 of 20 prospects given identical input, and in 3 of those
// its readings were identical both times: the final word was the unstable part. These rules are
// that final word now, so each one is pinned here.
//
// RULE ZERO: placeholders only. No market, buyer type, figure or company appears below.

import { describe, it, expect } from 'vitest'
import {
  gradeFromDimensions, readDimensionAnswers, countedResult, quoteFound, checkFitDimensions,
  readStoredFitDimensions, formatFitDimensions, MAX_DIMENSIONS,
  type FitDimension, type DimensionReadings, type DimensionResult,
} from '../fit-dimensions'

const dim = (key: string, role: 'required' | 'supporting', establishable: boolean): FitDimension =>
  ({ key, statement: `Placeholder condition ${key}`, source: `placeholder source ${key}`, role, establishable })

const REQ    = dim('req_a', 'required', true)
const REQ_B  = dim('req_b', 'required', true)
const SUP    = dim('sup_a', 'supporting', true)
const HIDDEN = dim('hidden_a', 'required', false)
const DIMS = [REQ, REQ_B, SUP, HIDDEN]

/** Readings as the grade counts them. Only `counted` reaches gradeFromDimensions. */
const counted = (c: Record<string, DimensionResult>): DimensionReadings =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { judged: v, evidence: null, quote_found: false, counted: v }]))

const ALL_SHOWN = { req_a: 'match', req_b: 'match', sup_a: 'match', hidden_a: 'unestablished' } as const

describe('gradeFromDimensions: the fixed rules, in order', () => {
  it('weak when a required dimension is a miss, however much else is unknown', () => {
    expect(gradeFromDimensions(DIMS, counted({ req_a: 'miss', req_b: 'unknown', sup_a: 'unknown', hidden_a: 'unestablished' })).icp_fit)
      .toBe('weak')
  })

  it('weak on a miss the material did show, even on a dimension research usually cannot establish', () => {
    expect(gradeFromDimensions(DIMS, counted({ ...ALL_SHOWN, hidden_a: 'miss' })).icp_fit).toBe('weak')
  })

  it('a supporting miss is never weak', () => {
    expect(gradeFromDimensions(DIMS, counted({ ...ALL_SHOWN, sup_a: 'miss' })).icp_fit).toBe('moderate')
  })

  it('cannot_tell when a required dimension research can establish was not shown, naming that one only', () => {
    const g = gradeFromDimensions(DIMS, counted({ ...ALL_SHOWN, req_b: 'unknown' }))
    expect(g.icp_fit).toBe('cannot_tell')
    expect(g.icp_fit_missing).toContain(REQ_B.statement)
    expect(g.icp_fit_missing).not.toContain(REQ.statement)
  })

  it('a dimension research cannot establish never makes it cannot_tell', () => {
    const g = gradeFromDimensions(DIMS, counted(ALL_SHOWN))
    expect(g.icp_fit).toBe('strong')
    expect(g.icp_fit_unestablished).toEqual([HIDDEN.statement])
  })

  it('cannot_tell when nothing research can establish was shown to match', () => {
    const g = gradeFromDimensions([SUP, HIDDEN], counted({ sup_a: 'unknown', hidden_a: 'unestablished' }))
    expect(g.icp_fit).toBe('cannot_tell')
    expect(g.icp_fit_missing).toMatch(/No dimension the research can establish/)
  })

  it('strong when every dimension research can establish is a match, with nothing missing', () => {
    const g = gradeFromDimensions(DIMS, counted(ALL_SHOWN))
    expect(g.icp_fit).toBe('strong')
    expect(g.icp_fit_missing).toBeNull()
  })

  it('moderate when every required one matched and a supporting one was not shown', () => {
    expect(gradeFromDimensions(DIMS, counted({ ...ALL_SHOWN, sup_a: 'unknown' })).icp_fit).toBe('moderate')
  })

  it('a dimension with no reading at all counts as unknown', () => {
    expect(gradeFromDimensions(DIMS, counted({})).icp_fit).toBe('cannot_tell')
  })
})

describe('countedResult: the only two ways a counted result differs from the judged one', () => {
  it('a match or a miss without a quotation found in the material is unknown', () => {
    expect(countedResult(REQ, 'match', false)).toBe('unknown')
    expect(countedResult(REQ, 'miss', false)).toBe('unknown')
    expect(countedResult(REQ, 'match', true)).toBe('match')
    expect(countedResult(REQ, 'miss', true)).toBe('miss')
  })

  it('on a dimension research can establish, the judge answering unestablished is unknown', () => {
    expect(countedResult(REQ, 'unestablished', false)).toBe('unknown')
  })

  it('on one it usually cannot, silence counts as unestablished and a quoted reading still counts', () => {
    expect(countedResult(HIDDEN, 'unknown', false)).toBe('unestablished')
    expect(countedResult(HIDDEN, 'miss', true)).toBe('miss')
    expect(countedResult(HIDDEN, 'match', false)).toBe('unestablished')
  })
})

describe('quoteFound: a quotation is one continuous passage of the material', () => {
  const material = 'Role: Placeholder Title\n\nThe placeholder   company has run its own\ndelivery since the placeholder year.'

  it('finds an exact passage whatever its case, line breaks, spacing or quote marks', () => {
    expect(quoteFound('the PLACEHOLDER company has run its own delivery', material)).toBe(true)
    expect(quoteFound('“has run its own delivery since the placeholder year.”', material)).toBe(true)
  })

  it('does not find a paraphrase', () => {
    expect(quoteFound('the placeholder company runs its delivery itself', material)).toBe(false)
  })

  it('does not find two passages joined by an ellipsis', () => {
    expect(quoteFound('Role: Placeholder Title ... since the placeholder year', material)).toBe(false)
  })

  it('does not accept a quotation too short to identify a passage, or none', () => {
    expect(quoteFound('run', material)).toBe(false)
    expect(quoteFound(null, material)).toBe(false)
  })
})

describe('readDimensionAnswers: only the client\'s list is read, and only evidence counts', () => {
  const material = 'Placeholder research text: the placeholder firm states it runs its own delivery.'

  it('counts a match whose quotation is in the material', () => {
    const r = readDimensionAnswers({ req_a: { result: 'match', evidence: 'it runs its own delivery' } }, [REQ], material)
    expect(r.req_a).toEqual({ judged: 'match', evidence: 'it runs its own delivery', quote_found: true, counted: 'match' })
  })

  it('records a fabricated quotation as not found, and the reading as unknown', () => {
    const r = readDimensionAnswers({ req_a: { result: 'miss', evidence: 'words that appear nowhere in it' } }, [REQ], material)
    expect(r.req_a.quote_found).toBe(false)
    expect(r.req_a.counted).toBe('unknown')
  })

  it('reads an unanswered dimension, or an answer outside the four, as unknown', () => {
    const r = readDimensionAnswers({ req_b: { result: 'probably', evidence: null } }, [REQ, REQ_B], material)
    expect(r.req_a.judged).toBe('unknown')
    expect(r.req_b.judged).toBe('unknown')
  })

  it('ignores a dimension the judge invented', () => {
    const r = readDimensionAnswers({ invented_one: { result: 'match', evidence: 'the placeholder firm' } }, [REQ], material)
    expect(Object.keys(r)).toEqual(['req_a'])
  })
})

describe('checkFitDimensions: a list is read strictly or not at all', () => {
  const good = [REQ, SUP]

  it('accepts a well-formed list', () => {
    expect(checkFitDimensions(good)).toEqual({ ok: true, dimensions: good })
  })

  it.each([
    ['an empty list',            []],
    ['a duplicated key',         [REQ, { ...SUP, key: 'req_a' }]],
    ['a key that is not snake',  [{ ...REQ, key: 'Placeholder Key' }]],
    ['a missing statement',      [{ ...REQ, statement: ' ' }]],
    ['a missing source',         [{ ...REQ, source: '' }]],
    ['an unknown role',          [{ ...REQ, role: 'optional' }]],
    ['an unstated establishable', [{ ...REQ, establishable: 'yes' }]],
    ['no establishable dimension', [HIDDEN]],
    ['more than the maximum',    Array.from({ length: MAX_DIMENSIONS + 1 }, (_, i) => dim(`d_${i}`, 'required', true))],
  ])('refuses %s', (_label, list) => {
    expect(checkFitDimensions(list).ok).toBe(false)
  })

  it('reads nothing stored as no list and no problem, and a bad list as a problem', () => {
    expect(readStoredFitDimensions(undefined)).toEqual({ dimensions: null, problem: null })
    expect(readStoredFitDimensions({ dimensions: [HIDDEN] }).problem).toMatch(/no dimension is one the research can establish/)
    expect(readStoredFitDimensions({ dimensions: good, derived_at: 'x', model: 'y' }).dimensions).toEqual(good)
  })
})

describe('formatFitDimensions: what the judge is shown', () => {
  it('names every key and marks each required or supporting, establishable or not', () => {
    const text = formatFitDimensions([REQ, SUP, HIDDEN])
    for (const d of [REQ, SUP, HIDDEN]) expect(text).toContain(`${d.key}: ${d.statement}`)
    expect(text).toMatch(/req_a[^\n]*\n\s+Required\. The research can establish this\./)
    expect(text).toMatch(/sup_a[^\n]*\n\s+Supporting\./)
    expect(text).toMatch(/hidden_a[^\n]*\n\s+Required\. The research usually cannot establish this\./)
  })
})
