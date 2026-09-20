// CAN THE FALLBACK OPENING PARAGRAPH STAND AS THE FIRST LINE OF AN EMAIL?
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FAILURE THIS CATCHES, AND WHY NOTHING ELSE COULD
//
// Email 1 paragraph 2 is a SLOT. When research produced an observation, composition replaces
// it. When research did not, the variant's own authored P2 ships unchanged as the first
// thing the prospect reads (compose-sequence.ts: `trigger.source === 'research'`).
//
// That fallback is good design and it has a sharp edge. An author writing P2 knows it sits
// under a greeting and above the offer line, and can write it as a CONTINUATION of a thought
// the greeting never started. With research, nothing is wrong: the slot is replaced. Without
// research, the email opens mid-sentence, pointing at something that was never said.
//
// It shipped. Prospects received it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE EXISTING GATE CANNOT SEE IT, WHICH IS THE INTERESTING PART
//
// findBackReferences already detects exactly these pointers, and it runs on Email 1 in the
// messaging agent. It EXEMPTS the first content paragraph, on purpose, and its comment says
// why: "in Email 1 it IS the slot that gets replaced, and a demonstrative inside it can only
// refer to something in its own text, which always ships together with it."
//
// That reasoning is correct for the researched path and false for the fallback path. The
// exemption is precisely what makes this defect invisible: the one paragraph that needs
// checking as an opener is the one paragraph the gate skips, because the gate assumes it
// will be replaced.
//
// So this is not a second detector. It is the SAME detector, applied at the position the
// existing one cannot reach, using the same displacement trick opening-reference.ts already
// uses for the writer's observation: put a placeholder paragraph in front so the text moves
// off the exempt index.
//
// ═════════════════════════════════════════════════════════════════════════════
// GENERAL, NOT A RULE ABOUT ANY PARTICULAR COPY
//
// Nothing here knows about a variant, a client, a sector or a buyer. It reads the paragraph
// it is given and asks two structural questions about English: does it point backwards at
// something unnamed, and does it open on a connective that presupposes a previous sentence.
// A document written for any industry passes or fails on its own text.
//
// ═════════════════════════════════════════════════════════════════════════════
// REPORTS. NEVER BLOCKS. NEVER REWRITES.
//
// It returns findings. Nothing here throws, rejects a variant, edits copy or stops a send. A
// send halted by a heuristic about prose would be a worse failure than the one it prevents,
// and the copy belongs to whoever approved it.

import { findBackReferences } from './back-reference'

/**
 * Words that, at the very start of a paragraph, lean on a sentence that has not been said.
 *
 * SEPARATE FROM THE POINTER CHECK because it is a different fault. A pointer refers to a
 * missing NOUN; these refer to a missing CLAUSE. "Instead, we run it weekly" names nothing
 * and still opens halfway through an argument.
 *
 * Kept deliberately short and restricted to position ZERO. Every one of these words is
 * perfectly ordinary mid-paragraph, and several are ordinary at the start of a paragraph
 * that is not the FIRST one. The narrowness is the precision: this only ever looks at the
 * opening word of the opening paragraph.
 *
 * "So" and "And" are included even though both are used as deliberate openers in good copy,
 * because this reports rather than blocks, and an author who meant it can see the note and
 * move on. A gate would need a stricter list; a note does not.
 */
const PRESUPPOSING_OPENERS = new Set([
  'and', 'but', 'so', 'or', 'yet', 'then', 'also', 'plus',
  'instead', 'otherwise', 'however', 'though', 'although',
  'meanwhile', 'besides', 'still', 'anyway', 'again',
  'which', 'where', 'when', 'because', 'since',
])

export interface StandaloneOpeningFinding {
  kind:
    /** Points back at a noun that was never named. */
    | 'points_backwards'
    /** Opens on a word that presupposes a preceding sentence. */
    | 'presupposes_earlier_sentence'
  /** The phrase or word responsible, as written. */
  phrase: string
  /** One sentence of explanation, already readable by a non-developer. */
  detail: string
}

/**
 * Everything about this paragraph that stops it reading as a first line.
 *
 * An empty array means it reads as an opener, as far as a deterministic check can tell. It
 * is not a promise that the copy is good; it is the absence of the two faults above.
 *
 * DETERMINISTIC, NO MODEL CALL. Pattern matching on predictable text, per ADR-018.
 */
export function findStandaloneOpeningFaults(paragraph: string): StandaloneOpeningFinding[] {
  const text = paragraph.trim()
  if (!text) return []

  const findings: StandaloneOpeningFinding[] = []

  // ── 1. Opens on a connective ───────────────────────────────────────────────
  //
  // Position zero only. The apostrophe class matches back-reference.ts so a curly quote
  // cannot smuggle a word past the comparison.
  const firstWord = text
    .replace(/^[^A-Za-z]+/, '')
    .split(/[^A-Za-z']/)[0]
    ?.toLowerCase()

  if (firstWord && PRESUPPOSING_OPENERS.has(firstWord)) {
    findings.push({
      kind: 'presupposes_earlier_sentence',
      phrase: firstWord,
      detail:
        `The paragraph begins with "${firstWord}", which continues a sentence that does not ` +
        'exist when this is the first thing the reader sees.',
    })
  }

  // ── 2. Points backwards ────────────────────────────────────────────────────
  //
  // THE PLACEHOLDER IS LOAD-BEARING. findBackReferences exempts its first content paragraph,
  // so a paragraph passed on its own is never scanned at all and this function would return
  // clean on every input. One word with no noun in it moves the text to index 1 without
  // being able to supply an antecedent or change a verdict. Same device, and the same
  // reason, as scanPart in opening-reference.ts.
  const report = findBackReferences(`and\n\n${text}`)

  for (const hit of report.demonstratives) {
    findings.push({
      kind: 'points_backwards',
      phrase: hit.phrase,
      detail:
        `"${hit.phrase}" points at something named earlier, and nothing comes earlier when ` +
        'this is the opening line.',
    })
  }

  // Both pronoun channels are read. The source detector splits them by how much it trusts
  // them as a GATE, and neither is being used as one here: a bare "it" or a bare "this" in
  // an opening paragraph has nothing at all in front of it to bind to, so the distinction
  // that matters upstream does not apply at this position.
  for (const hit of [...report.unanchoredPronouns, ...report.ambiguousPronouns]) {
    findings.push({
      kind: 'points_backwards',
      phrase: hit.pronoun,
      detail:
        `"${hit.pronoun}" stands in for something that was never named, because this is the ` +
        'first line.',
    })
  }

  // Definite articles are deliberately NOT read. They are report-only in the source detector
  // and fire on almost every paragraph of real copy, so including them would bury the two
  // signals above in noise. Same decision as opening-reference.ts.

  return findings
}

/**
 * True when this paragraph reads as a standalone first line.
 *
 * The convenience form, for a caller that wants a verdict rather than a list.
 */
export function readsAsStandaloneOpening(paragraph: string): boolean {
  return findStandaloneOpeningFaults(paragraph).length === 0
}
