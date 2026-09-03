// RULE ZERO: every fragment, statement and label in this file is an abstract token or
// fixed product copy. Nothing here names an industry, sector, country, company or job
// title. The behaviour under test is a gate and a projection, neither of which needs a
// real title to exercise.

import { describe, it, expect } from 'vitest'
import {
  selectClientBuyerCriterion,
  selectOperatorBuyerCriterion,
  parentIsClientApproved,
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
    client_approval_status: 'approved',
    icp_filter_spec: { buyer_criterion: criterion() },
    ...over,
  }
}

describe('the client view fails closed', () => {
  it('shows the criterion when the parent document is active and client-approved', () => {
    const view = selectClientBuyerCriterion(doc())
    expect(view).not.toBeNull()
    expect(view!.statement).toBe('A sentence about who to contact.')
    expect(view!.evidence).toEqual(['Something the documents said.'])
  })

  // THE CASE THAT ACTUALLY HAPPENS. promote_strategy_doc_version inserts every new
  // version active-and-pending, and persistIcpFilterSpec writes the criterion into that
  // same row moments later. Without this check a client would see a criterion from a
  // document they had not approved, for up to the three days before auto-approval.
  it('shows NOTHING while the parent document is pending client approval', () => {
    expect(selectClientBuyerCriterion(doc({ client_approval_status: 'pending' }))).toBeNull()
  })

  it('shows nothing for a superseded document, even one the client once approved', () => {
    expect(selectClientBuyerCriterion(doc({ status: 'archived' }))).toBeNull()
  })

  it('shows nothing when the parent document is archived AND pending', () => {
    expect(
      selectClientBuyerCriterion(doc({ status: 'archived', client_approval_status: 'pending' })),
    ).toBeNull()
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

  it('is NOT gated on approval, because the operator reads it before the client does', () => {
    const view = selectOperatorBuyerCriterion(doc({ client_approval_status: 'pending' }))
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

describe('parentIsClientApproved', () => {
  it.each([
    ['active', 'approved', true],
    ['active', 'pending', false],
    ['archived', 'approved', false],
    [null, null, false],
  ])('status=%s approval=%s -> %s', (status, approval, expected) => {
    expect(parentIsClientApproved(doc({ status, client_approval_status: approval }))).toBe(expected)
  })
})
