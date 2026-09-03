// RULE ZERO: every fragment, statement and label in this file is an abstract token or
// fixed product copy. Nothing here names an industry, sector, country, company or job
// title. The behaviour under test is a gate and a projection, neither of which needs a
// real title to exercise.

import { describe, it, expect } from 'vitest'
import {
  selectClientBuyerCriterion,
  selectOperatorBuyerCriterion,
  parentIsLive,
  type CriterionSourceDoc,
} from '@/lib/dashboard/buyer-criterion-view'

function criterion(over: Record<string, unknown> = {}) {
  return {
    status: 'derived',
    accept: [{ fragment: 'alpha', rank: 'primary' }, { fragment: 'beta', rank: 'secondary' }],
    reject: ['gamma'],
    statement: 'A sentence about who to contact.',
    evidence: ['Something the documents said.'],
    unsettled_reason: null,
    sanity: { checked: true, sample_size: 40, accept_rate: 0.5, note: 'Accepts 20 of 40.' },
    derived_at: '2026-09-02T00:00:00.000Z',
    model: 'test',
    ...over,
  }
}

function doc(over: Partial<CriterionSourceDoc> = {}): CriterionSourceDoc {
  return {
    status: 'active',
    icp_filter_spec: { buyer_criterion: criterion() },
    ...over,
  }
}

describe('the client view fails closed', () => {
  it('shows the criterion when the parent document is the live one', () => {
    const view = selectClientBuyerCriterion(doc())
    expect(view).not.toBeNull()
    expect(view!.statement).toBe('A sentence about who to contact.')
    expect(view!.evidence).toEqual(['Something the documents said.'])
  })

  // THE CASE THAT ACTUALLY HAPPENS. The client RLS policy admits archived rows so the
  // version history can be read, and every regeneration leaves another archived row
  // behind. A component handed one of those must render nothing rather than a criterion
  // the organisation stopped targeting by three versions ago.
  it('shows nothing for a superseded document', () => {
    expect(selectClientBuyerCriterion(doc({ status: 'archived' }))).toBeNull()
  })

  it('shows nothing for a draft', () => {
    expect(selectClientBuyerCriterion(doc({ status: 'draft' }))).toBeNull()
  })

  it.each([
    ['unsettled', 'the documents did not settle who decides'],
    ['out_of_band', 'the criterion is not applied'],
  ])('shows nothing when the criterion is %s, because it gates nothing', (status) => {
    // Showing "this is who we contact" while contacting everyone would be false in the
    // reassuring direction. Nothing is better than wrong.
    expect(
      selectClientBuyerCriterion(doc({ icp_filter_spec: { buyer_criterion: criterion({ status }) } })),
    ).toBeNull()
  })

  it.each([
    ['no spec at all', null],
    ['a spec with no criterion', { industries: [] }],
    ['a spec that is not an object', 'nonsense'],
    ['a criterion that is not an object', { buyer_criterion: 'nonsense' }],
  ])('shows nothing for %s', (_label, spec) => {
    expect(selectClientBuyerCriterion(doc({ icp_filter_spec: spec }))).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a string', { text: 'x' }],
  ])('shows nothing when the statement is %s', (_label, statement) => {
    expect(
      selectClientBuyerCriterion(doc({ icp_filter_spec: { buyer_criterion: criterion({ statement }) } })),
    ).toBeNull()
  })

  it('drops evidence entries that are not usable text rather than rendering them', () => {
    const view = selectClientBuyerCriterion(
      doc({ icp_filter_spec: { buyer_criterion: criterion({ evidence: ['keep', '', null, 42, { a: 1 }] }) } }),
    )
    expect(view!.evidence).toEqual(['keep'])
  })
})

describe('the client payload never carries the fragment list', () => {
  // Checked on the VALUE the boundary returns, not on what a component chooses to render.
  // A component that stops rendering something still received it.
  it('returns only a statement and evidence', () => {
    const view = selectClientBuyerCriterion(doc())!
    expect(Object.keys(view).sort()).toEqual(['evidence', 'statement'])
  })

  it('serialises with no accept or reject fragment anywhere in it', () => {
    const serialised = JSON.stringify(selectClientBuyerCriterion(doc()))
    for (const fragment of ['alpha', 'beta', 'gamma']) {
      expect(serialised).not.toContain(fragment)
    }
    expect(serialised).not.toContain('accept')
    expect(serialised).not.toContain('reject')
  })
})

describe('the operator view', () => {
  it('carries the fragments, which the client view does not', () => {
    const view = selectOperatorBuyerCriterion(doc())!
    expect(view.accept).toEqual([
      { fragment: 'alpha', rank: 'primary' },
      { fragment: 'beta', rank: 'secondary' },
    ])
    expect(view.reject).toEqual(['gamma'])
  })

  it('is NOT gated on liveness, because the operator reads old versions too', () => {
    const view = selectOperatorBuyerCriterion(doc({ status: 'archived' }))
    expect(view).not.toBeNull()
    expect(view!.visibleToClient).toBe(false)
  })

  it('reports visibleToClient true only when the client would actually see it', () => {
    expect(selectOperatorBuyerCriterion(doc())!.visibleToClient).toBe(true)
    expect(
      selectOperatorBuyerCriterion(
        doc({ icp_filter_spec: { buyer_criterion: criterion({ status: 'unsettled' }) } }),
      )!.visibleToClient,
    ).toBe(false)
  })

  it('drops malformed accept entries instead of handing React an object', () => {
    const view = selectOperatorBuyerCriterion(
      doc({
        icp_filter_spec: {
          buyer_criterion: criterion({
            accept: [{ fragment: 'alpha', rank: 'primary' }, { fragment: 'x' }, 'nope', null],
          }),
        },
      }),
    )!
    expect(view.accept).toEqual([{ fragment: 'alpha', rank: 'primary' }])
  })
})

describe('parentIsLive', () => {
  // Archived matters more than it used to: the client RLS policy now admits archived
  // rows so version history can be read, so this gate is the only thing keeping an old
  // version's criterion off the page.
  it.each([
    ['active', true],
    ['archived', false],
    ['draft', false],
    [null, false],
  ])('status=%s -> %s', (status, expected) => {
    expect(parentIsLive(doc({ status }))).toBe(expected)
  })
})
