// Which strategy documents a stored variant set was written against, and whether they
// still are what they were.
//
// WHY THIS EXISTS. Measured in production on 2026-09-21. A messaging suggestion held
// variants A, C and D written against ICP v5 on 20 September. At 13:59 UTC another session
// approved an ICP suggestion, making ICP v6 active. At 14:10 a single-variant repair filled
// variant B, and because the repair builds its context from whatever is ACTIVE, B was
// written against v6. One document, four variants, two different ICPs, and a
// suggestion_reason still naming only v5.
//
// Nothing caught it. The repair's payload guard proves the surviving variants' BYTES do not
// change, and that guard worked exactly as designed. It has no opinion about whether the
// CONTEXT the new variant is written from matches the context the others came from. Those
// are different claims and only one of them was being checked.
//
// A clean-worktree check cannot catch this either: approving a document writes to the
// database and leaves no trace in git, so every git-based "is another session active" guard
// reports no other session, correctly and truthfully, while the ground has already moved.
//
// WHERE THE RECORDED VERSIONS COME FROM. The generation agent already ends every
// suggestion_reason with "Source documents: ICP v5, Positioning v2, TOV v3." That string is
// the provenance record, so this reads it rather than adding a column. That choice matters
// for one specific reason: it works on rows written BEFORE this guard existed, which is
// every row that currently exists. A new column would be null on all of them and the guard
// would pass vacuously on exactly the rows most likely to be affected.
//
// AN UNREADABLE PROVENANCE IS A REFUSAL, NOT A PASS. If the string cannot be parsed, this
// returns null and the caller must refuse. "I could not determine what this was written
// against" is not the same as "nothing has changed", and treating them the same is how a
// check becomes decorative.

/** The three strategy documents every messaging variant is written against. */
export interface SourceVersions {
  icp: string
  positioning: string
  tov: string
}

export class SourceProvenanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceProvenanceError'
  }
}

// Matches the tail the generation agent writes. Anchored on the literal label so a
// suggestion_reason that merely mentions a version in prose cannot be mistaken for the
// record. Versions are captured loosely because the column is TEXT, not an integer.
const SOURCE_LINE = /Source documents:\s*ICP v([A-Za-z0-9._-]+),\s*Positioning v([A-Za-z0-9._-]+),\s*TOV v([A-Za-z0-9._-]+?)\.?(?:\s|$)/

/**
 * The source versions recorded in a suggestion_reason, or null when it says nothing.
 *
 * Null is "no answer". The caller refuses on it; it must never be read as "unchanged".
 */
export function parseSourceVersions(suggestionReason: string | null): SourceVersions | null {
  if (!suggestionReason) return null
  const match = SOURCE_LINE.exec(suggestionReason)
  if (!match) return null
  return { icp: match[1], positioning: match[2], tov: match[3] }
}

/** The same shape the generation agent writes, so both ends render provenance identically. */
export function formatSourceVersions(versions: SourceVersions): string {
  return `ICP v${versions.icp}, Positioning v${versions.positioning}, TOV v${versions.tov}`
}

/** Which of the three documents differ between two readings, in a stable order. */
export function changedDocuments(recorded: SourceVersions, current: SourceVersions): string[] {
  const changed: string[] = []
  if (recorded.icp !== current.icp) changed.push('ICP')
  if (recorded.positioning !== current.positioning) changed.push('Positioning')
  if (recorded.tov !== current.tov) changed.push('TOV')
  return changed
}

/** One aligned line per document, marking the ones that moved. For the refusal message. */
function comparisonTable(recorded: SourceVersions, current: SourceVersions): string {
  const rows: Array<[string, string, string]> = [
    ['ICP', recorded.icp, current.icp],
    ['Positioning', recorded.positioning, current.positioning],
    ['TOV', recorded.tov, current.tov],
  ]
  return rows
    .map(([label, was, now]) =>
      `  ${label.padEnd(12)} recorded v${was}, now v${now}${was !== now ? '   CHANGED' : ''}`)
    .join('\n')
}

/**
 * Throws unless the documents a repair is about to read are the ones the surviving
 * variants were written against.
 *
 * Refuses in BOTH failing directions: an unreadable provenance and a changed document. The
 * first is the one that looks harmless and is not.
 */
export function assertSourceVersionsUnchanged(params: {
  suggestionReason: string | null
  current: SourceVersions
  variantKey: string
}): SourceVersions {
  const recorded = parseSourceVersions(params.suggestionReason)

  if (!recorded) {
    throw new SourceProvenanceError(
      'Variant repair refused: this suggestion does not record which strategy documents ' +
      'its variants were written against, so there is no way to tell whether they have ' +
      'changed since. A repair fills a slot alongside copy written from a known context. ' +
      'Without that context the only safe action is a full regeneration.'
    )
  }

  const changed = changedDocuments(recorded, params.current)
  if (changed.length > 0) {
    throw new SourceProvenanceError(
      'Variant repair refused: ' +
      `${changed.length === 1 ? 'a source document has' : 'source documents have'} changed ` +
      'since the surviving variants were written.\n\n' +
      comparisonTable(recorded, params.current) + '\n\n' +
      `Filling variant ${params.variantKey} from ${changed.join(' and ')} as ${changed.length === 1 ? 'it stands' : 'they stand'} now is not a repair, ` +
      'it is a partial regeneration: the document would hold variants derived from ' +
      'different source documents while its own reason names only one set. Regenerate the ' +
      'whole document against the current documents instead.'
    )
  }

  return recorded
}
