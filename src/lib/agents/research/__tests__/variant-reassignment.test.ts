// The record of research moving a prospect off a variant the document no longer has.
// Without it MON-033 reads OK while prospects are being moved.

import { describe, it, expect } from 'vitest'
import { reassignedFromMissingVariant, reassignmentColumns } from '../variant-reassignment'

const DOC = { variants: { A: {}, B: {}, C: {} } }

describe('reassignedFromMissingVariant', () => {
  it('names the variant a prospect leaves because the document dropped it', () => {
    expect(reassignedFromMissingVariant('D', 'B', DOC)).toBe('D')
  })
  it('records nothing for a move between two variants the document still has', () => {
    // The offer-line selector choosing a better line is not a missing variant.
    expect(reassignedFromMissingVariant('A', 'B', DOC)).toBeNull()
  })
  it.each([
    ['no previous variant', null, 'B'],
    ['no new choice', 'D', null],
    ['the same variant', 'D', 'D'],
  ])('records nothing with %s', (_name, previous, chosen) => {
    expect(reassignedFromMissingVariant(previous, chosen, DOC)).toBeNull()
  })
  it('records nothing when the document cannot be read (never guesses a missing variant)', () => {
    expect(reassignedFromMissingVariant('D', 'B', null)).toBeNull()
    expect(reassignedFromMissingVariant('D', 'B', {})).toBeNull()
  })
})

describe('reassignmentColumns', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  it('writes both columns together', () => {
    expect(reassignmentColumns('D', now)).toEqual({ variant_reassigned_from: 'D', variant_reassigned_at: '2026-10-01T12:00:00.000Z' })
  })
  it('writes neither when there is nothing to record', () => {
    expect(reassignmentColumns(null, now)).toEqual({})
    expect(reassignmentColumns(undefined, now)).toEqual({})
  })
})
