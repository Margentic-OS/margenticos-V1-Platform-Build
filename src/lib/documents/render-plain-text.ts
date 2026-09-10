// Renders a strategy document's structured `content` as readable plain text.
//
// WHY THIS EXISTS. `strategy_documents.plain_text` has four kinds of consumer and, until
// this module, no writer at all. It was NULL on all 69 rows in production, so every reader
// took its fallback branch:
//
//   - The four generation agents read the prior version as
//     `plain_text ?? JSON.stringify(content, null, 2)`, so every regeneration has fed the
//     agent raw JSON where prose was intended.
//   - The buyer criterion agent does the same.
//   - The client-facing document views fall back to `PlainTextView` when `content` does not
//     parse into the structured shape, and render a permanent, false
//     "Document content is being processed" when plain_text is null.
//   - `document_suggestions.current_value` is written from it, so the operator's
//     before/after diff on the approval screen has never rendered. 56 approvals, no diff.
//
// THIS IS A FORMATTING CONVERSION AND NOTHING ELSE. Same words, different layout. No model
// call, no rewriting, no summarising, no reordering of content. The only text this module
// introduces is HEADINGS DERIVED FROM KEY NAMES, which are structural labels rather than
// document prose ("jtbd_statement" -> "Jtbd Statement"). Every string that was in the JSON
// appears verbatim in the output, and `assertNoContentLost` below is the check that proves
// it rather than asserting it.
//
// WHY SCHEMA-AGNOSTIC, AND WHY THAT IS THE WHOLE DESIGN. A census of the live table on
// 2026-09-08 found NINE distinct top-level key sets across four document types, plus two
// documents whose content root is an ARRAY rather than an object:
//
//   icp          4 shapes  (± client_pricing, ± unresolved_fields, ± assumptions_we_have_made)
//   positioning  2 shapes  (moore_positioning vs moore_statement)
//   tov          2 shapes  (± sentence_mechanics, ± what_this_voice_never_does)
//   messaging    1 object shape (variants) + 2 array-rooted rows
//
// A renderer that knew the schema would need nine branches and would break on the tenth.
// This one walks whatever JSON it is given, so a shape it has never seen renders correctly
// by construction and a new key appears in the output the day it is added. Structure
// variance is therefore not a reason to reach for a model; it is the reason not to.

/** A JSON value, which is all this module knows how to expect. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * Turns a snake_case or camelCase key into a heading.
 *
 * This is the ONLY text this module invents, and it is invented from a key name, never from
 * document content. Kept deliberately dumb: no dictionary, no special cases, no acronym
 * table. A lookup table would be a second list to keep in step with the schema, which is
 * the shape this codebase keeps getting bitten by.
 */
export function humaniseKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** True for a value that contributes no words and is skipped rather than rendered empty. */
const isEmpty = (v: Json): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

/** A scalar renders as itself, verbatim, with no quoting or escaping. */
const isScalar = (v: Json): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * Renders one value at a given heading depth.
 *
 * Depth governs heading markers only. It never changes, truncates or reorders content:
 * beyond depth 6 the markers stop deepening and the text still renders in full, because
 * losing a nested paragraph to a formatting rule would be exactly the silent content loss
 * this module is supposed to prevent.
 */
function renderValue(value: Json, depth: number): string[] {
  if (isEmpty(value)) return []

  if (isScalar(value)) return [String(value)]

  if (Array.isArray(value)) {
    const out: string[] = []
    const allScalar = value.every(item => isScalar(item) || isEmpty(item))

    if (allScalar) {
      // A list of scalars becomes a bullet list. One line each, verbatim.
      for (const item of value) {
        if (isEmpty(item)) continue
        out.push(`- ${String(item)}`)
      }
      return out
    }

    // A list of objects becomes numbered blocks, so the reader can tell where one ends and
    // the next begins. Numbering is positional and adds no words.
    //
    // The item renders at depth + 2, not depth + 1, so its fields sit one level BELOW the
    // block number rather than beside it. At depth + 1 the number and the first field were
    // both "#####" and the fields read as siblings of the block rather than as its contents,
    // which for a messaging document put every email body at the same level as the marker
    // introducing it.
    value.forEach((item, i) => {
      if (isEmpty(item)) return
      const inner = renderValue(item, depth + 2)
      if (inner.length === 0) return
      out.push(`${'#'.repeat(Math.min(depth + 1, 6))} ${i + 1}.`)
      out.push('')
      out.push(...inner)
      out.push('')
    })
    return out
  }

  // An object becomes a heading per key, in the key order the document already has. Key
  // order is preserved, never sorted: the agents wrote these in a deliberate order and
  // re-sorting would change how the document reads.
  const out: string[] = []
  for (const [key, child] of Object.entries(value as { [k: string]: Json })) {
    if (isEmpty(child)) continue
    const inner = renderValue(child, depth + 1)
    if (inner.length === 0) continue

    out.push(`${'#'.repeat(Math.min(depth, 6))} ${humaniseKey(key)}`)
    out.push('')
    out.push(...inner)
    out.push('')
  }
  return out
}

/**
 * Renders a document's `content` as readable plain text.
 *
 * Returns '' for content that carries no words at all, which is honest: a caller storing ''
 * has stored "this document has no renderable body", and the UI's null-check still shows
 * its placeholder. It never throws on an unexpected shape.
 */
export function renderDocumentPlainText(content: unknown): string {
  if (content === null || content === undefined) return ''

  const lines = renderValue(content as Json, 1)

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')   // collapse runs of blank lines left by skipped branches
    .trim()
}

/**
 * Every string leaf in a JSON value, in document order.
 *
 * This is the input side of the no-content-lost check. Numbers and booleans are excluded
 * deliberately: they render via String() and a bare "5" would match half the document by
 * substring, making the check weaker rather than stronger.
 */
export function collectStringLeaves(value: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.trim() !== '') out.push(v)
      return
    }
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk)
    }
  }
  walk(value)
  return out
}

/**
 * Throws unless every string that was in `content` appears verbatim in `rendered`.
 *
 * THIS IS THE GUARANTEE, and it is checkable rather than asserted. The failure this module
 * must never have is quietly dropping a paragraph: a backfill that loses content is worse
 * than the NULL it replaces, because NULL is visibly missing and a truncated document is
 * not. Five of the 69 rows are live documents a client can read today.
 *
 * Note it checks CONTAINMENT, not equality. The rendered text legitimately contains more
 * than the JSON strings did: headings derived from key names, bullet markers, and block
 * numbers. It may never contain LESS.
 */
export function assertNoContentLost(content: unknown, rendered: string, label: string): void {
  const missing = collectStringLeaves(content).filter(leaf => !rendered.includes(leaf))
  if (missing.length > 0) {
    throw new Error(
      `render-plain-text: ${missing.length} string(s) from ${label} did not survive rendering. ` +
      `First: ${JSON.stringify(missing[0]?.slice(0, 120))}`,
    )
  }
}
