import { describe, it, expect } from 'vitest'
import {
  DOCUMENTS_FED_BY_FIELD,
  NOT_MAPPED,
  documentsAffectedBy,
  intakeStaleReason,
  isIntakeStaleReason,
  isIntakeAnswerEdit,
} from '@/lib/intake/document-staleness'
import {
  ALL_QUESTIONS,
  TYPED_VOICE_SAMPLES_FIELD_KEY,
  UNREGISTERED_FORM_FIELD_KEYS,
} from '@/lib/intake/questions'
import { selectStaleDocuments } from '@/lib/dashboard/stale-documents'

describe('the field-to-document map', () => {
  // THE GUARD. A question added to the form must be classified, or it silently never flags
  // anything and the omission looks exactly like a deliberate decision not to flag.
  it('classifies every question the form asks as mapped or explicitly excused', () => {
    const classified = new Set([
      ...Object.keys(DOCUMENTS_FED_BY_FIELD),
      ...Object.keys(NOT_MAPPED),
    ])
    const unclassified = ALL_QUESTIONS.map(q => q.fieldKey).filter(k => !classified.has(k))
    expect(
      unclassified,
      `unclassified intake questions: ${unclassified.join(', ')}. Add each to ` +
      'DOCUMENTS_FED_BY_FIELD or to NOT_MAPPED with a reason.',
    ).toEqual([])
  })

  it('found questions at all, so the check above cannot pass vacuously', () => {
    expect(ALL_QUESTIONS.length).toBeGreaterThan(10)
    expect(Object.keys(DOCUMENTS_FED_BY_FIELD).length).toBeGreaterThan(0)
  })

  it('never maps a field to the same document twice', () => {
    for (const [field, docs] of Object.entries(DOCUMENTS_FED_BY_FIELD)) {
      expect(new Set(docs).size, field).toBe(docs.length)
    }
  })

  // The client's own revenue anchors nothing in the prospect profile by design. Mapping it
  // would re-assert in code the link the prompt was corrected to deny.
  it('does not flag the prospect profile when the client edits their own revenue', () => {
    expect(documentsAffectedBy('company_revenue_range')).toEqual([])
  })

  it('returns nothing for a field it does not know', () => {
    expect(documentsAffectedBy('not_a_field')).toEqual([])
  })
})

describe('what counts as an edit', () => {
  // THE GUARD. The form saves on blur whether or not anything was typed. Replacing this
  // with `true` flags documents on every visit to every field, and trains the operator to
  // ignore the flag.
  it('does not treat a no-op re-save as an edit', () => {
    expect(isIntakeAnswerEdit('same words', 'same words')).toBe(false)
  })

  it('ignores whitespace-only differences', () => {
    expect(isIntakeAnswerEdit('same words', '  same words  ')).toBe(false)
  })

  it('does not treat a first answer as an edit', () => {
    // No document was built without it, so nothing it feeds was written on another premise.
    expect(isIntakeAnswerEdit(null, 'a brand new answer')).toBe(false)
  })

  it('treats a real change as an edit', () => {
    expect(isIntakeAnswerEdit('old answer', 'new answer')).toBe(true)
  })

  it('treats clearing an answer as an edit', () => {
    expect(isIntakeAnswerEdit('had an answer', '')).toBe(true)
  })
})

describe('stale reason provenance', () => {
  it('round-trips and is distinguishable from the document-to-document cause', () => {
    expect(isIntakeStaleReason(intakeStaleReason('clients_clone'))).toBe(true)
    expect(isIntakeStaleReason(null)).toBe(false)
    expect(isIntakeStaleReason('')).toBe(false)
  })

  it('tells the operator an ANSWER changed, not that a document did', () => {
    const [doc] = selectStaleDocuments([{
      document_type: 'icp',
      status: 'active',
      is_stale: true,
      stale_reason: intakeStaleReason('clients_clone'),
    }])
    expect(doc.reason).toContain('intake answers')
    expect(doc.reason).not.toContain('Prospect profile')
    // Never leak an internal column name to a client-facing string.
    expect(doc.reason).not.toContain('clients_clone')
  })

  it('leaves the existing document-to-document wording untouched when reason is null', () => {
    const [doc] = selectStaleDocuments([{
      document_type: 'messaging', status: 'active', is_stale: true, stale_reason: null,
    }])
    expect(doc.reason).toContain('Written before the latest')
    expect(doc.reason).not.toContain('intake')
  })

  it('behaves identically when the caller has not selected the column at all', () => {
    const [doc] = selectStaleDocuments([{
      document_type: 'messaging', status: 'active', is_stale: true,
    }])
    expect(doc.reason).toContain('Written before the latest')
  })
})

// Answers the form collects that are not questions in SECTIONS.
//
// The map's own module-load guard reads SECTIONS to decide whether a key is real. SECTIONS
// is not the whole of what the form collects, so a live field could not be mapped at all:
// adding it threw "not a question the intake form asks" at import time and took two test
// files down with it. The guard now reads the union. These tests hold both halves in place.
describe('unregistered form fields', () => {
  it('flags the voice guide when pasted writing samples change', () => {
    // Pasted samples are the guide's PRIMARY source. Before 2026-09-05 they were mapped to
    // nothing, so revising them flagged no document at all.
    expect(documentsAffectedBy(TYPED_VOICE_SAMPLES_FIELD_KEY)).toContain('tov')
  })

  it('is not a registry question, which is why the guard had to widen', () => {
    // If this ever becomes false the field is being rendered twice by IntakeForm, which
    // maps over SECTIONS to build its inputs. See the note in questions.ts.
    expect(ALL_QUESTIONS.map(q => q.fieldKey)).not.toContain(TYPED_VOICE_SAMPLES_FIELD_KEY)
    expect(UNREGISTERED_FORM_FIELD_KEYS).toContain(TYPED_VOICE_SAMPLES_FIELD_KEY)
  })

  it('still rejects a key that is neither a question nor a declared form field', () => {
    // The guard must keep catching typos. It runs at module load over the real maps, so
    // this reproduces its condition rather than re-importing the module.
    const known = new Set([
      ...ALL_QUESTIONS.map(q => q.fieldKey),
      ...UNREGISTERED_FORM_FIELD_KEYS,
    ])
    expect(known.has('voice_typed_sample')).toBe(false) // a plausible typo, one letter short
    expect(known.has(TYPED_VOICE_SAMPLES_FIELD_KEY)).toBe(true)
  })
})
