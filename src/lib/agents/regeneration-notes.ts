// Notes attached to a document suggestion that was rejected, carried into the
// generation run that replaces it.
//
// Two controls produce a note, and before this module existed only one of them
// reached an agent:
//
//   client   "Request changes" on a live document  -> document_suggestions.revision_note
//   operator "Reject and regenerate" in the queue  -> document_suggestions.rejection_reason
//
// The client note was passed to the revision agent. The operator note was
// written to the column and never read again, so the regenerated document did
// not honour it and nothing said so. See ADR-038.
//
// Both notes are supplied to the agent when both exist. They are not competing
// instructions for the same thing: the client note is the REQUEST, the operator
// note is the CORRECTION to the attempt that answered it. Dropping the client
// note loses the reason the document was being changed at all; dropping the
// operator note is the original defect. Where they genuinely conflict the
// operator note wins, because it is the later judgement and it was made against
// the version that was actually produced.

export interface RegenerationNotes {
  /** The operator's note when they rejected the previous suggestion. */
  operator_note?: string | null
  /** The client's original change request, when the rejected suggestion was a client revision. */
  client_note?: string | null
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The prompt block naming what to change in this regeneration.
 * Returns '' when there is no note, so the prompt is byte-identical to a run
 * with no rejection behind it.
 */
export function buildRegenerationNotesBlock(notes: RegenerationNotes | undefined): string {
  const operatorNote = clean(notes?.operator_note)
  const clientNote = clean(notes?.client_note)
  if (!operatorNote && !clientNote) return ''

  const clientSection = clientNote
    ? `\n\n### What the client asked for\n\n${clientNote}`
    : ''

  const operatorSection = operatorNote
    ? `\n\n### Why the previous version was rejected\n\n${operatorNote}`
    : ''

  const conflictRule = operatorNote && clientNote
    ? '\n\nBoth notes apply. Where they conflict, follow the rejection note. It is the later ' +
      'judgement and it was made against the version that was actually produced.'
    : ''

  return (
    '\n\n---\n\n## NOTES ON THE VERSION YOU ARE REPLACING\n\n' +
    'The previous version of this document was rejected. The notes below are instructions ' +
    'about this specific document, not general guidance. Apply them.' +
    clientSection +
    operatorSection +
    conflictRule +
    '\n\nDo not silently ignore any part of a note. If part of one conflicts with the intake ' +
    'data or with a rule in your system prompt, produce the closest version that respects the ' +
    'rule and carry out the rest of the note in full.'
  )
}

/**
 * The sentence appended to suggestion_reason so the approval queue shows that
 * the note was carried into the run. Without this an operator cannot tell a
 * regeneration that honoured their note from one that ignored it.
 */
export function buildRegenerationNotesReason(notes: RegenerationNotes | undefined): string {
  const operatorNote = clean(notes?.operator_note)
  const clientNote = clean(notes?.client_note)
  if (!operatorNote && !clientNote) return ''

  const parts: string[] = []
  if (operatorNote) parts.push(`rejection note: "${operatorNote}"`)
  if (clientNote) parts.push(`client's change request: "${clientNote}"`)

  return ` This regeneration was given the ${parts.join(' and the ')}.`
}
