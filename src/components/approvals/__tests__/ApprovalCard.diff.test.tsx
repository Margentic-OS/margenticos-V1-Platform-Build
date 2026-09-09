// @vitest-environment jsdom
//
// ─── Why this file exists ────────────────────────────────────────────────────
//
// The operator's before/after diff on the approval screen has NEVER rendered. Measured
// 2026-09-08: 91 document_suggestions rows, 56 of them approved, every one with
// current_value NULL, going back to 2026-04-16. Nobody has ever seen a diff.
//
// The obvious cause was that current_value is written from strategy_documents.plain_text,
// which had no writer and was NULL on all 69 rows. That was fixed by backfilling plain_text
// and is real, but IT WAS NOT THE WHOLE STORY, and these tests pin the part that remains.
//
// The side-by-side block is gated on TWO conditions:
//
//     {!isFullDocument && suggestion.current_value && ( ...Current | Suggested... )}
//
// where `isFullDocument = suggestion.field_path === 'full_document'`.
//
// Live census, 2026-09-08: **91 of 91 rows have field_path = 'full_document'**, across all
// four document types, from the first row to the most recent. There has never been a
// field-level suggestion. Per ADR-012 that is the DESIGN: an agent writes one row carrying
// a full-document replacement. So `isFullDocument` is always true, the negation is always
// false, and the diff branch is unreachable no matter what current_value holds.
//
// The UI was built for a field-level diff model the system does not use and never has.
//
// These tests are deliberately written to assert the CURRENT behaviour, including the
// behaviour that is wrong. They are a description of the trap, so that whoever builds the
// full-document diff has to change them on purpose and cannot conclude from a green suite
// that the diff works.

import React from 'react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ApprovalCard, { type PendingSuggestion } from '../ApprovalCard'

beforeAll(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
})
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PRIOR = 'THE PRIOR VERSION TEXT, which is what an operator needs to compare against.'

function suggestion(over: Partial<PendingSuggestion> = {}): PendingSuggestion {
  return {
    id: 'test-id',
    organisation_id: 'a2b621fc-4c9d-43d9-9af4-1253ff49d12d',
    document_type: 'tov',
    field_path: 'full_document',
    current_value: null,
    suggested_value: JSON.stringify({ voice_summary: 'The newly suggested summary.' }),
    suggestion_reason: null,
    revision_note: null,
    update_trigger: null,
    created_at: '2026-09-08T00:00:00Z',
    organisations: { name: 'Test Org' },
    ...over,
  }
}

const renderCard = (s: PendingSuggestion) =>
  render(<ApprovalCard suggestion={s} onResolved={vi.fn()} />)

describe('the approvals before/after diff', () => {
  it('does NOT show the side-by-side diff for a full_document suggestion, even with current_value set', () => {
    // This is the second defect, and the one the plain_text backfill does not touch.
    // Every suggestion this system has ever created is full_document.
    renderCard(suggestion({ current_value: PRIOR }))

    expect(screen.queryByText('Current')).not.toBeInTheDocument()
    expect(screen.queryByText('Suggested')).not.toBeInTheDocument()
    expect(screen.queryByText(PRIOR)).not.toBeInTheDocument()
  })

  it('DOES show the side-by-side diff for a field-level suggestion with current_value set', () => {
    // The positive control. Without it, the assertion above is equally consistent with the
    // diff being broken for every input, which would make it a much larger claim than the
    // one being made. The branch works; nothing ever reaches it.
    renderCard(suggestion({ field_path: 'voice_summary', current_value: PRIOR }))

    expect(screen.getByText('Current')).toBeInTheDocument()
    expect(screen.getByText('Suggested')).toBeInTheDocument()
    expect(screen.getByText(PRIOR)).toBeInTheDocument()
  })

  it('still hides the diff for a field-level suggestion when current_value is null', () => {
    // The half the backfill DID fix, going forward. Both conditions are required.
    renderCard(suggestion({ field_path: 'voice_summary', current_value: null }))

    expect(screen.queryByText('Current')).not.toBeInTheDocument()
  })

  it('shows "Replacing existing document" once current_value is populated', () => {
    // This label IS reachable for full_document suggestions and has also never rendered,
    // because it is gated on current_value alone. So the plain_text backfill does change
    // what the operator sees on the next suggestion, just not to a diff.
    renderCard(suggestion({ current_value: PRIOR }))

    expect(screen.getByText('Replacing existing document')).toBeInTheDocument()
  })

  it('does not show that label while current_value is null, which is every row before today', () => {
    renderCard(suggestion({ current_value: null }))

    expect(screen.queryByText('Replacing existing document')).not.toBeInTheDocument()
  })
})
