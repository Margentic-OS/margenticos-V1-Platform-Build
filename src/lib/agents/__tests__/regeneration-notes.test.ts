// Unit tests for the note block that carries a rejection into the run that replaces it.
//
// These are pure string tests. What they protect is that a note which exists is
// visibly present in the prompt, and that a run with no note behind it produces a
// prompt byte-identical to one that never had a rejection.

import { describe, it, expect } from 'vitest'
import {
  buildRegenerationNotesBlock,
  buildRegenerationNotesReason,
  type RegenerationNotes,
} from '../regeneration-notes'

const OPERATOR = 'Remove Canada, Australia and Western Europe from the geography in all three tiers.'
const CLIENT = 'Mention the onboarding guarantee in email two.'

describe('buildRegenerationNotesBlock', () => {
  it('is empty when there is no note', () => {
    expect(buildRegenerationNotesBlock(undefined)).toBe('')
    expect(buildRegenerationNotesBlock({})).toBe('')
    expect(buildRegenerationNotesBlock({ operator_note: null, client_note: null })).toBe('')
  })

  it('is empty when a note is whitespace only', () => {
    expect(buildRegenerationNotesBlock({ operator_note: '   \n  ' })).toBe('')
  })

  it('carries the operator note verbatim', () => {
    const block = buildRegenerationNotesBlock({ operator_note: OPERATOR })
    expect(block).toContain(OPERATOR)
    expect(block).toContain('NOTES ON THE VERSION YOU ARE REPLACING')
  })

  it('carries the client note verbatim', () => {
    expect(buildRegenerationNotesBlock({ client_note: CLIENT })).toContain(CLIENT)
  })

  it('carries both notes and names which one wins on conflict', () => {
    const block = buildRegenerationNotesBlock({ operator_note: OPERATOR, client_note: CLIENT })
    expect(block).toContain(OPERATOR)
    expect(block).toContain(CLIENT)
    expect(block).toContain('follow the rejection note')
  })

  it('states no precedence rule when only one note exists', () => {
    expect(buildRegenerationNotesBlock({ operator_note: OPERATOR })).not.toContain('follow the rejection note')
  })

  it('trims surrounding whitespace off a note', () => {
    expect(buildRegenerationNotesBlock({ operator_note: `  ${OPERATOR}  ` })).toContain(`\n\n${OPERATOR}`)
  })

  it('carries no em dashes or en dashes', () => {
    // The block's own prose has to obey the house style. The `---` markdown rule is
    // the section separator every other block in these prompts already uses, so it is
    // stripped before the check rather than treated as a double hyphen.
    const block = buildRegenerationNotesBlock({ operator_note: 'plain note', client_note: 'another' })
    expect(block.replace(/\n---\n/g, '\n')).not.toMatch(/[—–]|--/)
  })
})

describe('buildRegenerationNotesReason', () => {
  it('is empty when there is no note', () => {
    expect(buildRegenerationNotesReason(undefined)).toBe('')
    expect(buildRegenerationNotesReason({ operator_note: '  ' })).toBe('')
  })

  it('names the rejection note so the approval queue shows it was used', () => {
    const reason = buildRegenerationNotesReason({ operator_note: OPERATOR })
    expect(reason).toContain('rejection note')
    expect(reason).toContain(OPERATOR)
  })

  it('names both notes when both were supplied', () => {
    const notes: RegenerationNotes = { operator_note: OPERATOR, client_note: CLIENT }
    const reason = buildRegenerationNotesReason(notes)
    expect(reason).toContain(OPERATOR)
    expect(reason).toContain(CLIENT)
  })
})
