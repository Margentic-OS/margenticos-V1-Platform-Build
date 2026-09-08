// Notes attached to a document suggestion that is being replaced, carried into the
// generation run that replaces it.
//
// Two controls produce a note, and before this module existed only one of them
// reached an agent:
//
//   client   "Request changes" on a live document  -> document_suggestions.revision_note
//   operator "Reject and regenerate" in the queue  -> document_suggestions.rejection_reason
//   operator "Regenerate" on the document page     -> no rejection at all, just a note
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
//
// ─── A NOTE MAY NEVER TRAVEL WITHOUT THE VERSION IT IS ABOUT (2026-09-08) ─────
//
// These blocks used to assert two things that were false on the operator's Regenerate
// path: that the previous version had been REJECTED, and that the note was an instruction
// "about this specific document". Nothing was rejected there, and the document was never
// supplied, because the fetch was gated on a caller flag rather than on the document
// existing. So an operator writing "keep the opening, soften the rest" was instructing the
// model to edit text it had never been shown.
//
// The fix is structural rather than a wording change. Both builders now REQUIRE the prior
// version as an argument, so a caller cannot express "here is a note about the version you
// are replacing" without holding that version. When it is absent the note is dropped and
// the omission is stated out loud in suggestion_reason, because a silently dropped note is
// the same defect as ADR-038 wearing different clothes.

import { logger } from '@/lib/logger'

export interface RegenerationNotes {
  /** The operator's note: a rejection reason from the queue, or a Regenerate note. */
  operator_note?: string | null
  /** The client's original change request, when the version being replaced was a client revision. */
  client_note?: string | null
}

/**
 * The version this run replaces, as supplied to the prompt.
 *
 * This is deliberately the DOCUMENT ITSELF rather than a boolean. A boolean can be
 * passed as true by a caller that fetched nothing; an object can only be held by a
 * caller that actually has the version, and that same object is what the prompt
 * reproduces. The two cannot drift apart.
 */
export interface PriorVersion {
  version: string | number
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The prompt block naming what to change in this regeneration.
 *
 * Returns '' when there is no note, so the prompt is byte-identical to a run with no
 * note behind it. Returns '' and warns when there is a note but no prior version: the
 * note refers to a document the model cannot see, and an instruction to edit invisible
 * text is worse than no instruction.
 */
export function buildRegenerationNotesBlock(
  notes: RegenerationNotes | undefined,
  priorVersion: PriorVersion | null,
): string {
  const operatorNote = clean(notes?.operator_note)
  const clientNote = clean(notes?.client_note)
  if (!operatorNote && !clientNote) return ''

  if (!priorVersion) {
    logger.warn(
      'Regeneration note dropped: a note was supplied but no prior version exists to apply it to. ' +
      'The note refers to a document the model was never given, so it was not put in the prompt.',
      { has_operator_note: !!operatorNote, has_client_note: !!clientNote },
    )
    return ''
  }

  const clientSection = clientNote
    ? `\n\n### What the client asked for\n\n${clientNote}`
    : ''

  const operatorSection = operatorNote
    ? `\n\n### What the operator wants changed\n\n${operatorNote}`
    : ''

  const conflictRule = operatorNote && clientNote
    ? '\n\nBoth notes apply. Where they conflict, follow the operator note. It is the later ' +
      'judgement and it was made against the version that was actually produced.'
    : ''

  return (
    `\n\n---\n\n## NOTES ON VERSION ${priorVersion.version}, WHICH THIS RUN REPLACES\n\n` +
    `Version ${priorVersion.version} is reproduced in full above. The notes below are ` +
    'instructions about that specific document, not general guidance. Apply them.' +
    clientSection +
    operatorSection +
    conflictRule +
    '\n\nDo not silently ignore any part of a note. If part of one conflicts with the intake ' +
    'data or with a rule in your system prompt, produce the closest version that respects the ' +
    'rule and carry out the rest of the note in full.'
  )
}

/**
 * The sentence appended to suggestion_reason so the approval queue shows what the run
 * was given. Without this an operator cannot tell a regeneration that honoured their
 * note from one that ignored it.
 *
 * When a note existed but no prior version did, this SAYS SO. That case is the one an
 * operator most needs told, because they wrote an instruction and the run could not use it.
 */
export function buildRegenerationNotesReason(
  notes: RegenerationNotes | undefined,
  priorVersion: PriorVersion | null,
): string {
  const operatorNote = clean(notes?.operator_note)
  const clientNote = clean(notes?.client_note)
  if (!operatorNote && !clientNote) return ''

  if (!priorVersion) {
    return ' A note was supplied, but no prior version of this document existed for it to ' +
      'apply to, so it was not given to the agent.'
  }

  const parts: string[] = []
  if (operatorNote) parts.push(`operator note: "${operatorNote}"`)
  if (clientNote) parts.push(`client's change request: "${clientNote}"`)

  return ` This regeneration was given version ${priorVersion.version} plus the ${parts.join(' and the ')}.`
}

/**
 * The single note recorded on the VERSION this run produces, so the version history can
 * tell one version from another.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Found on 2026-09-03 while setting up the proof run for version history, not by reading
 * code. An operator regenerated with a note, approved the suggestion, and the resulting
 * version had revision_note NULL, because approve_document_suggestion passed NULL and
 * nothing had ever put the note on the suggestion row. Five regenerations therefore
 * produced five versions that all rendered as "Generated by your outbound team" and were
 * indistinguishable, which is the exact failure the version history exists to prevent.
 *
 * The note now goes onto the suggestion, and approve_document_suggestion carries it into
 * the version.
 *
 * OPERATOR NOTE WINS, for the same reason it wins in the prompt: it is the later
 * judgement and it was made against the version that was actually produced. The client
 * note is the fallback so a client revision staged for review still records why it
 * happened.
 *
 * THIS ONE DOES NOT TAKE THE PRIOR VERSION, deliberately. It records what a human asked
 * for, which stays true whether or not the run could act on it. The prompt and the reason
 * are claims about this run and must not outrun what the run was given; the version note
 * is a record of the request.
 */
export function noteForVersionHistory(notes: RegenerationNotes | undefined): string | null {
  return clean(notes?.operator_note) ?? clean(notes?.client_note)
}
