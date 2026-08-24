// Tests for the Strategy nav collapse rule.
//
// The rule that matters is the negative one: this section must NEVER start collapsed
// while a document is unapproved, because assertStrategyApproved blocks the lead upload
// until all four carry client_approval_status 'approved'. Collapsing then would hide the
// blocker behind a chevron, and the client would be waiting on us while we waited on them.

import { describe, it, expect } from 'vitest'
import { deriveStrategyNavState, STRATEGY_DOC_TYPES } from './strategy-nav-state'
import type { StrategyDocRow } from './strategy-nav-state'

function allApproved(): StrategyDocRow[] {
  return STRATEGY_DOC_TYPES.map(t => ({ document_type: t, client_approval_status: 'approved' }))
}

describe('it collapses only when there is genuinely nothing to do', () => {
  it('collapses once all four are approved and nothing is pending', () => {
    const state = deriveStrategyNavState(allApproved(), [])

    expect(state.collapsedByDefault).toBe(true)
    expect(state.reason).toBe('all_approved')
    expect(state.needsAttention).toEqual([])
  })
})

describe('it NEVER collapses away a state that blocks the lead upload', () => {
  it.each([...STRATEGY_DOC_TYPES])('stays open when %s is still pending approval', (type) => {
    const docs = allApproved().map(d =>
      d.document_type === type ? { ...d, client_approval_status: 'pending' } : d
    )
    const state = deriveStrategyNavState(docs, [])

    expect(state.collapsedByDefault).toBe(false)
    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toHaveLength(1)
  })

  it('treats a MISSING document as unapproved, the same way the upload gate does', () => {
    // assertStrategyApproved pushes a pending label when the row does not exist at all.
    // A section that collapsed because a document was absent would be the worst version
    // of this bug: nothing on screen to click, and the upload silently blocked.
    const docs = allApproved().filter(d => d.document_type !== 'messaging')
    const state = deriveStrategyNavState(docs, [])

    expect(state.collapsedByDefault).toBe(false)
    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toEqual(['Messaging'])
  })

  it('stays open with no documents at all', () => {
    const state = deriveStrategyNavState([], [])
    expect(state.collapsedByDefault).toBe(false)
    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toEqual([
      'Prospect profile', 'Positioning', 'Voice guide', 'Messaging',
    ])
  })

  it('ignores a null approval status rather than reading it as approved', () => {
    const docs = allApproved().map(d =>
      d.document_type === 'icp' ? { ...d, client_approval_status: null } : d
    )
    expect(deriveStrategyNavState(docs, []).collapsedByDefault).toBe(false)
  })

  it('blocking outranks pending: a client is told about the blocker first', () => {
    const docs = allApproved().map(d =>
      d.document_type === 'tov' ? { ...d, client_approval_status: 'pending' } : d
    )
    const state = deriveStrategyNavState(docs, ['icp'])

    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toEqual(['Voice guide'])
  })
})

describe('it opens again when a new version arrives', () => {
  it('expands when a suggestion is pending, even with everything approved', () => {
    const state = deriveStrategyNavState(allApproved(), ['messaging'])

    expect(state.collapsedByDefault).toBe(false)
    expect(state.reason).toBe('pending_version')
    expect(state.needsAttention).toEqual(['Messaging'])
  })

  it('names several pending documents in document order, not arrival order', () => {
    const state = deriveStrategyNavState(allApproved(), ['messaging', 'icp'])
    expect(state.needsAttention).toEqual(['Prospect profile', 'Messaging'])
  })

  it('ignores a pending suggestion for a document type that is not in the nav', () => {
    const state = deriveStrategyNavState(allApproved(), ['something_else'])
    expect(state.collapsedByDefault).toBe(true)
  })
})

describe('the labels are the client-facing ones', () => {
  it('never says ICP or TOV', () => {
    const state = deriveStrategyNavState([], [])
    const joined = state.needsAttention.join(' ')

    expect(joined).not.toContain('ICP')
    expect(joined).not.toContain('TOV')
    expect(joined).toContain('Prospect profile')
    expect(joined).toContain('Voice guide')
  })
})
