import { describe, it, expect } from 'vitest'
import { findDrivingRejectionNotes } from '../driving-rejection-note'

// The operator's rejection note reaches the generation agents (ADR-038) and was displayed
// nowhere, because it lives on the row that was REPLACED rather than on the pending row an
// operator is looking at. These tests pin the pairing, and in particular the ordering
// condition, which is the difference between showing a note and showing a plausible one.

const pending = (over: Partial<Parameters<typeof findDrivingRejectionNotes>[0][number]> = {}) => ({
  id: 'pending-1',
  organisation_id: 'org-a',
  document_type: 'icp',
  created_at: '2026-08-27T20:59:15.000Z',
  ...over,
})

const rejected = (over: Partial<Parameters<typeof findDrivingRejectionNotes>[1][number]> = {}) => ({
  organisation_id: 'org-a',
  document_type: 'icp',
  rejection_reason: 'Remove Canada, Australia and Western Europe from the geography in all three tiers.',
  reviewed_at: '2026-08-27T20:57:02.000Z',
  ...over,
})

describe('findDrivingRejectionNotes', () => {
  it('pairs a pending suggestion with the rejection that preceded it', () => {
    const found = findDrivingRejectionNotes([pending()], [rejected()])
    expect(found.get('pending-1')?.note).toContain('Remove Canada')
    expect(found.get('pending-1')?.rejected_at).toBe('2026-08-27T20:57:02.000Z')
  })

  // THE CONDITION THAT STOPS IT LYING. A rejection nobody regenerated from would otherwise
  // attach itself to whatever suggestion turned up next, however much later.
  it('ignores a rejection that happened AFTER the pending suggestion was created', () => {
    const found = findDrivingRejectionNotes(
      [pending({ created_at: '2026-08-27T20:00:00.000Z' })],
      [rejected({ reviewed_at: '2026-08-27T20:57:02.000Z' })],
    )
    expect(found.has('pending-1')).toBe(false)
  })

  it('takes the most recent qualifying rejection when there are several', () => {
    const found = findDrivingRejectionNotes([pending()], [
      rejected({ reviewed_at: '2026-08-20T09:00:00.000Z', rejection_reason: 'older note' }),
      rejected({ reviewed_at: '2026-08-27T20:57:02.000Z', rejection_reason: 'newest note' }),
      rejected({ reviewed_at: '2026-08-25T11:00:00.000Z', rejection_reason: 'middle note' }),
    ])
    expect(found.get('pending-1')?.note).toBe('newest note')
  })

  it('does not cross organisations', () => {
    const found = findDrivingRejectionNotes([pending()], [rejected({ organisation_id: 'org-b' })])
    expect(found.has('pending-1')).toBe(false)
  })

  it('does not cross document types', () => {
    const found = findDrivingRejectionNotes([pending()], [rejected({ document_type: 'positioning' })])
    expect(found.has('pending-1')).toBe(false)
  })

  it('ignores an empty or whitespace-only note, which is a rejection with no instruction', () => {
    expect(findDrivingRejectionNotes([pending()], [rejected({ rejection_reason: '   ' })]).size).toBe(0)
    expect(findDrivingRejectionNotes([pending()], [rejected({ rejection_reason: null })]).size).toBe(0)
  })

  it('returns nothing rather than guessing when either timestamp is missing', () => {
    expect(findDrivingRejectionNotes([pending({ created_at: null })], [rejected()]).size).toBe(0)
    expect(findDrivingRejectionNotes([pending()], [rejected({ reviewed_at: null })]).size).toBe(0)
  })

  it('handles several pending rows independently', () => {
    const found = findDrivingRejectionNotes(
      [pending(), pending({ id: 'pending-2', document_type: 'tov' })],
      [rejected(), rejected({ document_type: 'tov', rejection_reason: 'warmer, less formal' })],
    )
    expect(found.get('pending-1')?.note).toContain('Remove Canada')
    expect(found.get('pending-2')?.note).toBe('warmer, less formal')
  })
})
