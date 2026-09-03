// RULE ZERO: every label and sentence asserted here is fixed product copy. Nothing names
// an industry, sector, country, company or job title.

import { describe, it, expect } from 'vitest'
import { selectStaleDocuments, type StaleDocRow } from '../stale-documents'

function row(over: Partial<StaleDocRow> = {}): StaleDocRow {
  return { document_type: 'messaging', status: 'active', is_stale: true, ...over }
}

describe('only the live document can be stale', () => {
  it('includes an active document marked stale', () => {
    expect(selectStaleDocuments([row()]).map(d => d.docType)).toEqual(['messaging'])
  })

  it('ignores an archived row that still carries the flag', () => {
    // This is the case that actually occurs. A document is flagged, then regenerated;
    // the flagged row is archived with is_stale still true, because clearing it would
    // rewrite history. Reading archived rows would show a permanent stale warning that
    // no amount of regenerating could clear.
    expect(selectStaleDocuments([row({ status: 'archived' })])).toEqual([])
  })

  it('ignores a live document that is not stale', () => {
    expect(selectStaleDocuments([row({ is_stale: false })])).toEqual([])
  })

  it('treats a null flag as not stale', () => {
    expect(selectStaleDocuments([row({ is_stale: null })])).toEqual([])
  })

  it('ignores a document type it does not know', () => {
    expect(selectStaleDocuments([row({ document_type: 'something_else' })])).toEqual([])
  })
})

describe('the list reads the same every time', () => {
  it('uses fixed document order rather than arrival order', () => {
    const docs = [
      row({ document_type: 'messaging' }),
      row({ document_type: 'positioning' }),
    ]
    expect(selectStaleDocuments(docs).map(d => d.docType)).toEqual(['positioning', 'messaging'])
  })

  it('names one document once even when several segments flagged it', () => {
    const docs = [row({ document_type: 'messaging' }), row({ document_type: 'messaging' })]
    expect(selectStaleDocuments(docs)).toHaveLength(1)
  })
})

describe('what it says about a stale document', () => {
  it('names the client-facing labels of what it is built from', () => {
    const [messaging] = selectStaleDocuments([row({ document_type: 'messaging' })])
    expect(messaging.reason).toContain('Prospect profile')
    expect(messaging.reason).toContain('Positioning')
    expect(messaging.reason).toContain('Voice guide')
  })

  it('never says ICP or TOV', () => {
    const all = selectStaleDocuments([
      row({ document_type: 'messaging' }),
      row({ document_type: 'positioning' }),
    ])
    for (const d of all) {
      expect(d.reason).not.toContain('ICP')
      expect(d.reason).not.toContain('TOV')
      expect(d.label).not.toContain('ICP')
      expect(d.label).not.toContain('TOV')
    }
  })

  it('states a fact and never a verdict that the document is wrong', () => {
    // The flag cannot know whether the upstream change was relevant. Copy that said the
    // document was out of date would be asserting something nothing has checked.
    const [messaging] = selectStaleDocuments([row({ document_type: 'messaging' })])
    expect(messaging.reason).toContain('It may still be right.')
    for (const forbidden of ['out of date', 'wrong', 'invalid', 'broken']) {
      expect(messaging.reason.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('gives positioning a reason naming only what positioning is built from', () => {
    const [positioning] = selectStaleDocuments([row({ document_type: 'positioning' })])
    expect(positioning.reason).toContain('Prospect profile')
    expect(positioning.reason).not.toContain('Voice guide')
  })
})
