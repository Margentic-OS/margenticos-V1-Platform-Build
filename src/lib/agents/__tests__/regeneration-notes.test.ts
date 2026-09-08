// Unit tests for the note block that carries a note into the run that replaces a version.
//
// These are pure string tests. What they protect is that a note which exists is
// visibly present in the prompt, that a run with no note behind it produces a
// prompt byte-identical to one that never had a note, and that a note NEVER travels
// without the version it is about.
//
// THE PRIOR VERSION IS A REQUIRED ARGUMENT, NOT AN OPTION. Passing it is how a caller
// states that it actually holds the document. Before 2026-09-08 the block asserted that
// the previous version had been rejected and that the notes were instructions "about this
// specific document", on a path where nothing was rejected and no document was supplied.

import { describe, it, expect } from 'vitest'
import {
  buildRegenerationNotesBlock,
  buildRegenerationNotesReason,
  noteForVersionHistory,
  type RegenerationNotes,
} from '../regeneration-notes'

const OPERATOR = 'Remove Canada, Australia and Western Europe from the geography in all three tiers.'
const CLIENT = 'Mention the onboarding guarantee in email two.'

/** The version the notes are about. Held by the caller, so it can be named in the block. */
const PRIOR = { version: 4 }

describe('buildRegenerationNotesBlock', () => {
  it('is empty when there is no note', () => {
    expect(buildRegenerationNotesBlock(undefined, PRIOR)).toBe('')
    expect(buildRegenerationNotesBlock({}, PRIOR)).toBe('')
    expect(buildRegenerationNotesBlock({ operator_note: null, client_note: null }, PRIOR)).toBe('')
  })

  it('is empty when a note is whitespace only', () => {
    expect(buildRegenerationNotesBlock({ operator_note: '   \n  ' }, PRIOR)).toBe('')
  })

  it('carries the operator note verbatim', () => {
    const block = buildRegenerationNotesBlock({ operator_note: OPERATOR }, PRIOR)
    expect(block).toContain(OPERATOR)
    expect(block).toContain('NOTES ON VERSION 4, WHICH THIS RUN REPLACES')
  })

  it('carries the client note verbatim', () => {
    expect(buildRegenerationNotesBlock({ client_note: CLIENT }, PRIOR)).toContain(CLIENT)
  })

  it('carries both notes and names which one wins on conflict', () => {
    const block = buildRegenerationNotesBlock({ operator_note: OPERATOR, client_note: CLIENT }, PRIOR)
    expect(block).toContain(OPERATOR)
    expect(block).toContain(CLIENT)
    expect(block).toContain('follow the operator note')
  })

  it('states no precedence rule when only one note exists', () => {
    expect(buildRegenerationNotesBlock({ operator_note: OPERATOR }, PRIOR)).not.toContain('follow the operator note')
  })

  it('trims surrounding whitespace off a note', () => {
    expect(buildRegenerationNotesBlock({ operator_note: `  ${OPERATOR}  ` }, PRIOR)).toContain(`\n\n${OPERATOR}`)
  })

  it('carries no em dashes or en dashes', () => {
    // The block's own prose has to obey the house style. The `---` markdown rule is
    // the section separator every other block in these prompts already uses, so it is
    // stripped before the check rather than treated as a double hyphen.
    const block = buildRegenerationNotesBlock({ operator_note: 'plain note', client_note: 'another' }, PRIOR)
    expect(block.replace(/\n---\n/g, '\n')).not.toMatch(/[—–]|--/)
  })
})

describe('buildRegenerationNotesReason', () => {
  it('is empty when there is no note', () => {
    expect(buildRegenerationNotesReason(undefined, PRIOR)).toBe('')
    expect(buildRegenerationNotesReason({ operator_note: '  ' }, PRIOR)).toBe('')
  })

  it('names the operator note so the approval queue shows it was used', () => {
    const reason = buildRegenerationNotesReason({ operator_note: OPERATOR }, PRIOR)
    expect(reason).toContain('operator note')
    expect(reason).toContain(OPERATOR)
    // The version is named, so an operator can tell WHICH document the run was given.
    expect(reason).toContain('version 4')
  })

  it('names both notes when both were supplied', () => {
    const notes: RegenerationNotes = { operator_note: OPERATOR, client_note: CLIENT }
    const reason = buildRegenerationNotesReason(notes, PRIOR)
    expect(reason).toContain(OPERATOR)
    expect(reason).toContain(CLIENT)
  })
})

describe('noteForVersionHistory', () => {
  it('is null when there is no note, so the version falls back to what produced it', () => {
    expect(noteForVersionHistory(undefined)).toBeNull()
    expect(noteForVersionHistory({})).toBeNull()
    expect(noteForVersionHistory({ operator_note: '   ', client_note: null })).toBeNull()
  })

  it('prefers the operator note, which is the later judgement', () => {
    expect(noteForVersionHistory({ operator_note: OPERATOR, client_note: CLIENT })).toBe(OPERATOR)
  })

  it('falls back to the client note, so a staged revision still records why', () => {
    expect(noteForVersionHistory({ client_note: CLIENT })).toBe(CLIENT)
  })

  it('trims, because the stored value is rendered verbatim in the history', () => {
    expect(noteForVersionHistory({ operator_note: `  ${OPERATOR}  ` })).toBe(OPERATOR)
  })
})

// ─── A NOTE MAY NOT TRAVEL WITHOUT THE VERSION IT IS ABOUT ────────────────────
//
// MUTATION PROOF. Make buildRegenerationNotesBlock ignore its priorVersion argument and
// return the block regardless, and the first test here goes red. That mutation is exactly
// the defect these tests were written for: on the operator's Regenerate path the note
// reached the model while the document did not, so "keep the opening, soften the rest" was
// an instruction to edit text the model had never seen.

describe('a note never travels without the version it refers to', () => {
  it('drops the note entirely when no prior version exists', () => {
    expect(buildRegenerationNotesBlock({ operator_note: OPERATOR }, null)).toBe('')
    expect(buildRegenerationNotesBlock({ client_note: CLIENT }, null)).toBe('')
    expect(buildRegenerationNotesBlock({ operator_note: OPERATOR, client_note: CLIENT }, null)).toBe('')
  })

  it('leaks no fragment of the note, not just no heading', () => {
    // A partial block would be worse than none: the model would see the instruction and
    // still not the document. Assert on the note text itself, not on the wording around it.
    const block = buildRegenerationNotesBlock({ operator_note: OPERATOR, client_note: CLIENT }, null)
    expect(block).not.toContain(OPERATOR)
    expect(block).not.toContain(CLIENT)
    expect(block).not.toContain('REPLACES')
  })

  it('the same notes DO produce a block when the version is supplied, so the test above is not vacuous', () => {
    // Without this, a builder that returned '' unconditionally would pass everything above.
    const block = buildRegenerationNotesBlock({ operator_note: OPERATOR, client_note: CLIENT }, PRIOR)
    expect(block).toContain(OPERATOR)
    expect(block).toContain(CLIENT)
  })

  it('says out loud in suggestion_reason that the note was not applied', () => {
    // A silently dropped note is ADR-038 again. The operator wrote an instruction and the
    // run could not use it, which is the one outcome they most need told about.
    const reason = buildRegenerationNotesReason({ operator_note: OPERATOR }, null)
    expect(reason).toContain('no prior version')
    expect(reason).toContain('not given to the agent')
    expect(reason).not.toContain(OPERATOR)
  })

  it('still records the request in the version history, which is a different question', () => {
    // noteForVersionHistory records what a human ASKED FOR. That stays true whether or not
    // the run could act on it, so it deliberately takes no prior version.
    expect(noteForVersionHistory({ operator_note: OPERATOR })).toBe(OPERATOR)
  })
})
