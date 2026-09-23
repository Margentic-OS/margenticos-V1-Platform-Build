// Hiding the section that is being rewritten from the model that rewrites it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS, MEASURED 2026-09-23
//
// The ICP generator's user message reproduces the live document in full under the
// instruction "What you produce REPLACES it. Keep what still holds." When the rule for
// writing a section changes, the model is looking at the old section while being asked for
// a new one, and it keeps it. That is not disobedience: it is the instruction it was given,
// and the old section is the most concrete thing in the context.
//
// Measured across two runs of the ICP generator with a changed trigger rule:
//
//   run 1, no regeneration note   3 of 5 triggers 100% word-overlap with the live version
//   run 2, note saying the rule
//     had changed and where to
//     read it                     the same 3 still at 100%, 9 of 15 evidence items still
//                                 breaking a ban the rule states outright
//
// Telling the model to ignore what it is looking at does not work. Not showing it does.
//
// THIS IS ALSO THE CONDITION A BRAND-NEW CLIENT IS IN. A client with no document has no
// section to be shown, so a regeneration that hides one section is exercising the same path
// a first-time generation takes. That makes this the only way to test what the generator
// produces for a new client without waiting for one.
// ═════════════════════════════════════════════════════════════════════════════

import { renderDocumentPlainText } from '@/lib/documents/render-plain-text'

/**
 * A dotted path into the document content, e.g. `tier_1.triggers`.
 *
 * A string rather than a typed union because the sections worth regenerating differ per
 * document type, and a union here would have to know all four. The caller names the path.
 */
export type SectionPath = string

/** Removes one dotted path from a content object. Returns a copy; the input is untouched. */
export function omitSection<T>(content: T, path: SectionPath): T {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return content
  const clone = JSON.parse(JSON.stringify(content)) as Record<string, unknown>

  let cursor: Record<string, unknown> = clone
  for (const key of parts.slice(0, -1)) {
    const next = cursor?.[key]
    // A path that does not exist is not an error. A document written before the section
    // existed has nothing to hide, and that is the same answer as hiding it.
    if (!next || typeof next !== 'object') return clone as unknown as T
    cursor = next as Record<string, unknown>
  }
  delete cursor[parts[parts.length - 1]]
  return clone as unknown as T
}

/**
 * The live document as the model should see it while rewriting `path`.
 *
 * RE-RENDERED FROM THE STRIPPED CONTENT, never string-surgery on the stored prose. The
 * stored plain_text is markdown with headings, and deleting a section from prose by pattern
 * would leave the format subtly different from every other run: a heading behind, a blank
 * line short. Re-rendering means the only difference between this and the ordinary context
 * is the absence of one section, which is exactly what was asked for.
 *
 * Returns the stored plain_text unchanged when no path is being regenerated, so a normal
 * run is byte-identical to what it was before this existed.
 */
export function documentContextFor(
  doc: { plain_text: string | null; content: unknown },
  regeneratingPath: SectionPath | null,
): string {
  if (!regeneratingPath) {
    return doc.plain_text ?? JSON.stringify(doc.content, null, 2)
  }
  return renderDocumentPlainText(omitSection(doc.content, regeneratingPath))
}
