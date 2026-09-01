// Email 1 paragraph slot labels — the stored record of what job each paragraph does.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// getVariantEmail1Frame reads Email 1 POSITIONALLY: index 0 is the observation slot,
// index 1 the offer line, index 2 the CTA. Measured across all 72 stored variant rows,
// index 1 is an offer line in 12 of them. In the other 60 it is a second problem-framing
// paragraph, because those documents predate the frame rewrite and have no offer line at
// all. The writer has therefore been briefed with a paragraph that does a different job,
// labelled as the offer line, and nothing noticed: composition reads paragraphs from the
// END of the body, so it kept working while the frame reader was wrong.
//
// The fix is to stop inferring a paragraph's job from its position. This module defines
// the vocabulary and the storage shape. NOTHING READS THESE LABELS YET — adding them is
// deliberately inert, so the backfill can be reviewed before any behaviour depends on it.
//
// ─── WHY {slot, text} PAIRS AND NOT A PARALLEL ARRAY OF NAMES ────────────────
//
// A `string[]` of slot names alongside the paragraphs derived from `body` is exactly the
// parallel-array shape that has already produced two silent defects in this codebase (the
// monitor sweep bounded by the shorter of two arrays, and the byJobType literal whose
// missing key was hidden by an `as` cast). Nothing structural stops the two lists drifting,
// and the drift is invisible because both sides still look well-formed.
//
// Pairing each label with the paragraph text it describes removes the index arithmetic
// entirely. It also makes staleness DETECTABLE rather than silent: `body` is the single
// source of truth for what gets sent, and a reader can confirm the labels still describe
// it by comparing the stored texts to the body's own paragraphs. If a revision rewrites a
// body, the texts stop matching and slotsMatchBody returns false, so a future reader falls
// back to the positional read rather than trusting a label that now points at nothing.
//
// TRADE-OFF ACCEPTED: this duplicates roughly four paragraphs of copy per variant row.
// That duplication is not redundancy for its own sake, it is what makes the labels
// checkable against the body. `body` remains authoritative; the copies here are never
// rendered, never sent, and never used as content.

/**
 * The job a paragraph does in a cold email. CATEGORY LEVEL by rule: no industry, sector,
 * buyer title, or offer appears here or may ever be added here. These describe the
 * STRUCTURE of a cold email and must read identically for a logistics firm, a SaaS
 * business, and a professional services practice.
 */
export type Email1Slot =
  /** Names a problem or pattern the reader may recognise. The slot composition replaces. */
  | 'observation'
  /** Continues framing the problem or its consequence. Says nothing about the sender. */
  | 'problem_context'
  /** Names what the SENDER does and what changes for the reader. */
  | 'offer'
  /** Describes the sender's organisation, background, or process. */
  | 'sender_credentials'
  /** The closing question that asks for the reply. */
  | 'cta'
  /** The sender's name and organisation name. */
  | 'sign_off'

export const EMAIL1_SLOTS = [
  'observation',
  'problem_context',
  'offer',
  'sender_credentials',
  'cta',
  'sign_off',
] as const satisfies readonly Email1Slot[]

/**
 * One paragraph's label together with the paragraph it labels.
 *
 * `text` is a COPY of the paragraph as it appeared in `body` when the label was derived.
 * It exists so the labelling can be verified against the body, never so it can be sent.
 */
export interface Email1ParagraphSlot {
  slot: Email1Slot
  text: string
}

/**
 * Splits an Email 1 body into its content paragraphs.
 *
 * This is the SAME rule getVariantEmail1Frame applies: split on blank lines, trim, drop
 * empties, and drop the {{first_name}} greeting. It is duplicated here rather than
 * imported because compose-sequence.ts is untouched in this branch. A test pins the two
 * against each other over every stored body, so a drift between them fails rather than
 * producing labels that describe a different set of paragraphs than the frame reader sees.
 */
export function splitEmail1Paragraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !/^\{\{first_name\}\},?\s*$/.test(p))
}

/**
 * True when `slots` still describes `body` exactly: same number of paragraphs, same text,
 * in the same order.
 *
 * A future reader must call this before trusting a label. Returning false is not an error
 * condition, it means the body has been edited since the labels were derived and the
 * caller should fall back to the positional read, which is what it does today anyway.
 */
export function slotsMatchBody(slots: Email1ParagraphSlot[] | undefined, body: string): boolean {
  if (!slots || slots.length === 0) return false
  const paras = splitEmail1Paragraphs(body)
  if (paras.length !== slots.length) return false
  return paras.every((p, i) => p === slots[i].text)
}
