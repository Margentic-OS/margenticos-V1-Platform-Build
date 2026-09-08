// The client's document says what it does not know. Read it before tuning anything.
//
// ─── WHY THIS EXISTS AND WHY NOTHING ELSE READS IT ───────────────────────────
//
// The ICP generation agent writes `unresolved_fields` into the document's content: an array
// of gaps it could not settle and claims it could not verify, each carrying the field it
// affects, why it is unresolved, and the question that would settle it. An operator sees
// them on the approval card. The client-facing projection strips them.
//
// NOTHING READS THEM WHEN THE SEARCH IS BUILT, and they are already in scope at that exact
// moment: persistIcpFilterSpec loads the whole document content and hands it to the spec
// derivation, which never looks. So a document that openly says "I do not know this" is
// used to build a search as though it did.
//
// Tuning a search built on a field the document itself flags as unestablished is the most
// expensive kind of wasted work: every round measures a population defined by a value
// nobody has confirmed. So this is read at round zero, before any model call, and a gap
// that bears on the search is a terminal state rather than a warning.
//
// ─── THE REASON CARRIES THE DOCUMENT'S OWN QUESTION, VERBATIM ────────────────
//
// The agent already wrote a question designed to settle the gap. Paraphrasing it would
// produce a second, worse version of a question that has to be asked of a person anyway.
// So the terminal reason quotes it, and an operator can put it to the client as written.

import type { UnresolvedFieldFinding } from '@/lib/tuner/types'

/**
 * Field-path fragments the search is actually built from.
 *
 * ─── WHY A LIST OF FRAGMENTS AND NOT "ANY UNRESOLVED FIELD BLOCKS" ───────────
 *
 * A document can carry a gap that has nothing to do with the search, and stopping for one
 * would make the tuner unusable on exactly the clients whose documents are honest about
 * their gaps. MEASURED 2026-09-08: the one live organisation carrying unresolved fields
 * carries two, on a revenue band and on a stage descriptor, and NEITHER reaches the search.
 * Revenue is not a spec field at all, and stage is not read by the derivation. Blocking on
 * those would have stopped the run for a reason that was not true.
 *
 * These four are what the search is genuinely built from, and the list is derived from
 * reading the spec derivation rather than guessed:
 *
 *   industries   becomes the classification codes
 *   headcount    becomes the size band
 *   seniority    becomes the provider-side seniority filter
 *   geography    becomes both country axes
 *
 * Matched as a case-insensitive substring of the field path, so `tier_1.company_profile.
 * industries` and `tier_2.company_profile.industries` both hit without either being named.
 */
export const SEARCH_BEARING_PATH_FRAGMENTS = [
  'industries',
  'headcount',
  'seniority',
  'geography',
] as const

interface RawUnresolvedField {
  kind?: unknown
  field_path?: unknown
  why_unresolved?: unknown
  question_to_settle_it?: unknown
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Read the unresolved fields off a document's content.
 *
 * Tolerant of a malformed entry rather than throwing: this runs at round zero on documents
 * written by several generations of the ICP agent, and a run that dies because one entry is
 * shaped oddly would be worse than one that reports the entries it could read. An entry with
 * no field path is kept and marked as not bearing on the search, because it cannot be shown
 * to bear on it.
 */
export function readUnresolvedFields(
  icpContent: Record<string, unknown> | null | undefined,
): UnresolvedFieldFinding[] {
  const raw = icpContent?.unresolved_fields
  if (!Array.isArray(raw)) return []

  return raw
    .filter((e): e is RawUnresolvedField => Boolean(e) && typeof e === 'object')
    .map(entry => {
      const fieldPath = asText(entry.field_path)
      const lowered = fieldPath.toLowerCase()
      return {
        kind: asText(entry.kind) || 'unestablished_field',
        fieldPath,
        whyUnresolved: asText(entry.why_unresolved),
        questionToSettleIt: asText(entry.question_to_settle_it),
        bearsOnSearch:
          fieldPath.length > 0 &&
          SEARCH_BEARING_PATH_FRAGMENTS.some(fragment => lowered.includes(fragment)),
      }
    })
}

/**
 * The terminal reason for a document whose gaps block the search.
 *
 * Names the field and quotes the document's own question, so an operator can read it to the
 * client without rewriting it. Where the agent wrote no question, that absence is stated
 * rather than filled in with one this module invented.
 */
export function describeBlockingFields(findings: UnresolvedFieldFinding[]): string {
  const blocking = findings.filter(f => f.bearsOnSearch)
  if (blocking.length === 0) return ''

  const parts = blocking.map(f => {
    const why = f.whyUnresolved ? ` ${f.whyUnresolved}` : ''
    const question = f.questionToSettleIt
      ? ` Ask the client: "${f.questionToSettleIt}"`
      : ' The document recorded no question to settle it, so one has to be written.'
    return `${f.fieldPath} (${f.kind}).${why}${question}`
  })

  return (
    `The search is built from ${blocking.length === 1 ? 'a field' : 'fields'} the client's own ` +
    `document records as unresolved, so tuning would be measuring a population defined by a ` +
    `value nobody has confirmed. ${parts.join(' ')}`
  )
}
