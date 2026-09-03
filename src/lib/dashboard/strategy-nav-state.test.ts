// Tests for the Strategy nav collapse rule.
//
// The rule that matters is the negative one: this section must NEVER start collapsed
// while a document is missing, because assertStrategyApproved blocks the lead upload
// until all four exist. Collapsing then would hide the blocker behind a chevron, and the
// client would be waiting on us while we waited on them.
//
// Until 2026-09-03 the blocking case was "a document is not APPROVED". Client approval on
// strategy documents is removed (ADR-047), so it is now "a document does not exist".

import { describe, it, expect } from 'vitest'
import { deriveStrategyNavState, STRATEGY_DOC_TYPES } from './strategy-nav-state'
import type { StrategyDocRow } from './strategy-nav-state'

function allPresent(): StrategyDocRow[] {
  return STRATEGY_DOC_TYPES.map(t => ({ document_type: t }))
}

describe('it collapses only when there is genuinely nothing to do', () => {
  it('collapses once all four exist and nothing is pending', () => {
    const state = deriveStrategyNavState(allPresent(), [])

    expect(state.collapsedByDefault).toBe(true)
    expect(state.reason).toBe('all_present')
    expect(state.needsAttention).toEqual([])
  })
})

describe('it NEVER collapses away a state that blocks the lead upload', () => {
  it.each([...STRATEGY_DOC_TYPES])('stays open when %s does not exist', (type) => {
    const docs = allPresent().filter(d => d.document_type !== type)
    const state = deriveStrategyNavState(docs, [])

    expect(state.collapsedByDefault).toBe(false)
    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toHaveLength(1)
  })

  it('names the missing document the same way the upload gate does', () => {
    // assertStrategyApproved pushes a label when the row does not exist at all. A section
    // that collapsed because a document was absent would be the worst version of this
    // bug: nothing on screen to click, and the upload silently blocked.
    const docs = allPresent().filter(d => d.document_type !== 'messaging')
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

  it('blocking outranks pending: a client is told about the blocker first', () => {
    const docs = allPresent().filter(d => d.document_type !== 'tov')
    const state = deriveStrategyNavState(docs, ['icp'])

    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toEqual(['Voice guide'])
  })
})

describe('it opens again when a new version is in flight', () => {
  it('expands when a suggestion is pending, even with all four present', () => {
    const state = deriveStrategyNavState(allPresent(), ['messaging'])

    expect(state.collapsedByDefault).toBe(false)
    expect(state.reason).toBe('pending_version')
    expect(state.needsAttention).toEqual(['Messaging'])
  })

  it('names several pending documents in document order, not arrival order', () => {
    const state = deriveStrategyNavState(allPresent(), ['messaging', 'icp'])
    expect(state.needsAttention).toEqual(['Prospect profile', 'Messaging'])
  })

  it('ignores a pending suggestion for a document type that is not in the nav', () => {
    const state = deriveStrategyNavState(allPresent(), ['something_else'])
    expect(state.collapsedByDefault).toBe(true)
  })

  it('counts a duplicated document type once, so archived rows cannot fake presence', () => {
    // The caller filters to active rows. If that filter is ever dropped, the archived
    // history for one type must not be able to stand in for a type that is missing.
    const docs: StrategyDocRow[] = [
      { document_type: 'icp' }, { document_type: 'icp' }, { document_type: 'icp' },
      { document_type: 'positioning' }, { document_type: 'tov' },
    ]
    const state = deriveStrategyNavState(docs, [])
    expect(state.reason).toBe('blocking_upload')
    expect(state.needsAttention).toEqual(['Messaging'])
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
