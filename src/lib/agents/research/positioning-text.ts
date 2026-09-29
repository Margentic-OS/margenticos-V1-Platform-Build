// THE POSITIONING DOCUMENT AS ONE NUMBERED, LABELLED CORPUS.
//
// WHY THE WHOLE DOCUMENT AND NOT A SUMMARY. loadClientContext already reduces positioning to
// two strings: positioningSummary (one field) and valuePropContext (the cold-outreach hook
// plus the top two value themes). Both are built for a synthesis prompt to reason over, and
// neither is a corpus anything can CITE INTO. Measured on the live active document:
// 17,848 characters of JSON across 9 top-level keys, of which the two summarised fields are
// about 1,300. A check asking "does the client's own document say they do this work" against
// 7% of that document answers a different question.
//
// WHY EACH LEAF IS LABELLED WITH ITS PATH. Measured on the same document,
// competitive_alternatives and competitive_landscape are 4,175 characters, 23% of it, and
// they describe WHAT OTHER PEOPLE DO. A verifier handed an unlabelled blob can quote a
// competitor's capability as evidence that THIS client's service meets a need, and the quote
// would be genuine. The label is what makes that visible to the reader of a rejection, and
// what lets the prompt draw the distinction at all.
//
// WHY ONE LINE PER LEAF, WITH NEWLINES COLLAPSED. The line is the unit a citation names, so
// a leaf spanning several lines would make a line number ambiguous. Collapsing is lossy for
// display and exact for matching, which is the only thing done with it.
//
// NOT SHARED WITH scripts/derive-trigger-reasons.ts, DELIBERATELY. That script has its own
// flattener producing an UNLABELLED, UNNUMBERED blob, and its verifier searches the whole
// blob for a quote. Two functions that must produce the same output are the drift shape this
// codebase keeps paying for; two functions that must produce DIFFERENT output are not, and
// merging these would silently change the prompt that script sends.

/** One string leaf of the document, with the path it was found at. */
export interface PositioningLeaf {
  /** Dotted path with array indices, e.g. `value_themes[1].theme`. */
  path: string
  /** The leaf's text, whitespace collapsed to single spaces. */
  text: string
}

function walk(value: unknown, path: string, out: PositioningLeaf[]): void {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim()
    if (text) out.push({ path, text })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, out))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, out)
    }
  }
  // Numbers, booleans and null carry no prose and are not quotable. Dropped rather than
  // stringified: a line reading "true" is a line a verifier can cite and nobody can read.
}

/** Every string leaf of the document, in document order. */
export function positioningLeaves(content: unknown): PositioningLeaf[] {
  const out: PositioningLeaf[] = []
  walk(content, '', out)
  return out
}

/**
 * The document as one string, one leaf per line, each line `path: text`.
 *
 * THIS IS WHAT IS STORED on ClientDocContext and snapshotted onto a batch entry, rather than
 * the leaf array, because the snapshot is jsonb and a string round-trips through it without
 * a shape to keep in step. positioningLines reads it back.
 */
export function flattenPositioningText(content: unknown): string {
  return positioningLeaves(content).map(l => `${l.path}: ${l.text}`).join('\n')
}

/**
 * Read the flattened string back into its lines, WITHOUT the path label.
 *
 * The label is for the reader and for the model. A citation is checked against the TEXT, so
 * a verifier that quotes the path it found a sentence under is not credited for it.
 */
export function positioningLines(positioningText: string): PositioningLeaf[] {
  return positioningText
    .split('\n')
    .map(line => {
      const sep = line.indexOf(': ')
      return sep < 0
        ? { path: '', text: line.trim() }
        : { path: line.slice(0, sep), text: line.slice(sep + 2).trim() }
    })
    .filter(l => l.text.length > 0)
}

/** The corpus a citation names, numbered from 1 exactly as buildFindingsEvidence is. */
export function buildPositioningCorpus(positioningText: string): string {
  return positioningLines(positioningText)
    .map((l, i) => `${i + 1}. [${l.path}] ${l.text}`)
    .join('\n')
}
