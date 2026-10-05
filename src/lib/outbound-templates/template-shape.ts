// The structured shape of brief-generated message templates, and the deterministic
// renderers that turn it into email bodies.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)", Rounds 3 to 7.
//
// ONE RENDERER, THREE CONSUMERS. The generator's validator, composition and the reading
// report all build email bodies through the functions in this file. That is deliberate:
// if the validator rendered one way and composition another, the validator would be
// proving something about emails that never ship. There is one definition of what a
// filled line looks like, and it lives here.
//
// THE STORED BODIES STAY COMPATIBLE. Each variant still carries `emails[]` with a plain
// `body` per position, exactly as before. Those bodies are the SLOT-FREE rendering, which
// is what a template-tier prospect receives, and what the research writer and composition
// already read. Email 1's slot-free body is:
//
//     {{first_name}} / pain / offer / question / sign-off
//
// so paragraph 2 is still the observation slot composition replaces with a researched
// trigger, and paragraph 3 is still the offer line the research writer is shown. The
// structured `lines` sit beside the bodies and are read only by the firm-fact tier.
//
// NO COPY LIVES IN THIS FILE. Every word of an email comes from the client's approved
// messaging document. Code supplies slot names and paragraph order, nothing else.

import { createHash } from 'crypto'

// {company} is the prospect's own firm, by the name it goes by (operator note 2 on the
// fourth reading, 2026-10-02): follow-up paragraphs only, so that Emails 2 and 3 carry
// something of the reader even where Email 1 is the plain template. Its fill comes from
// companyShortName, which returns nothing for a name that would read badly in a sentence.
export const SLOTS = ['does', 'for_whom', 'peer_group', 'company'] as const
export type Slot = (typeof SLOTS)[number]

/**
 * The slots a FOLLOW-UP paragraph may hold. {company} and {for_whom} need a slot_free form;
 * {peer_group} does not, because its slot-free form is the line with the brief's default
 * label, as in Email 1. {peer_group} joined on 2026-10-03: a follow-up's source is named
 * ("When we chat to {peer_group}, ..."), never faceless ("Some firms say").
 */
export const FOLLOWUP_SLOTS: readonly Slot[] = ['company', 'for_whom', 'peer_group']

export type SlotFills = Partial<Record<Slot, string>>

/** What a follow-up paragraph is doing. Email 1's lines carry their kind by position. */
export type ParagraphKind = 'pain' | 'offer' | 'ask' | 'close'

export interface TemplateWording {
  /** The line, with any {slot} placeholders. */
  text: string
  slots: Slot[]
  slot_free: string | null
  from: string[]
}

export interface TemplateLine {
  /** The line, with any {slot} placeholders. */
  text: string
  /** The slots this line DECLARES. Must equal the placeholders actually in `text`. */
  slots: Slot[]
  /**
   * The same line with no slot. Required when the line declares does, for_whom or company.
   * A line whose only slot is peer_group may leave it null: its slot-free form is the
   * line rendered with the brief's peer_group_default, which is also a label the client
   * confirmed.
   */
  slot_free: string | null
  /** Brief item ids this line uses. Every id must exist in the brief. */
  from: string[]
  /**
   * A SECOND WORDING of the same line, rotated per prospect for deliverability (operator
   * rule 8, 2026-10-01). It lives ON the line it alternates, so there is no second list to
   * drift out of step. Absent on documents written before this existed: one wording, index
   * 0, and everything behaves as it did. Email 1 lines only; follow-ups carry none: a
   * follow-up paragraph's two forms are its slotted text and its slot_free form.
   *
   * WORDING 0 IS THE STORED BODY. variants[X].emails[0].body is, by definition, wording 0
   * of every line, and that is the Email 1 the research writer, its judge and the follow-up
   * fingerprint are all built on. So tier 1 (a researched opening) ALWAYS uses wording 0;
   * only tiers 2 and 3 rotate.
   */
  alt?: TemplateWording | null
  /** Follow-up paragraphs only: what this paragraph is doing. */
  kind?: ParagraphKind
}

/** Every wording of a line: one for older documents, two where an alternate was written. */
export function wordingsOf(line: TemplateLine): TemplateWording[] {
  const first: TemplateWording = { text: line.text, slots: line.slots, slot_free: line.slot_free, from: line.from }
  return line.alt && typeof line.alt.text === 'string' && line.alt.text.trim() ? [first, line.alt] : [first]
}

export const EMAIL1_LINE_KEYS = ['subject', 'pain', 'offer', 'question'] as const
export type Email1LineKey = (typeof EMAIL1_LINE_KEYS)[number]
/** Which wording of each Email 1 line to render. Missing keys mean wording 0. */
export type WordingChoice = Partial<Record<Email1LineKey, number>>

/**
 * Which wording a prospect gets for one line. Deterministic by prospect id, salted per
 * line so pain and offer rotate independently, mirroring openerFrameIndex.
 */
export function wordingIndex(prospectId: string, lineKey: Email1LineKey, count: number): number {
  if (count <= 1) return 0
  const digest = createHash('sha256').update(`wording:${lineKey}:${prospectId}`).digest()
  return digest.readUInt32BE(0) % count
}

/** The wording choice for one prospect across all four Email 1 lines. */
export function wordingChoiceFor(prospectId: string, email1: Email1Lines): Required<WordingChoice> {
  return {
    subject: wordingIndex(prospectId, 'subject', wordingsOf(email1.subject).length),
    pain: wordingIndex(prospectId, 'pain', wordingsOf(email1.pain).length),
    offer: wordingIndex(prospectId, 'offer', wordingsOf(email1.offer).length),
    question: wordingIndex(prospectId, 'question', wordingsOf(email1.question).length),
  }
}

function pick(line: TemplateLine, index: number | undefined): TemplateWording {
  const all = wordingsOf(line)
  return all[index ?? 0] ?? all[0]
}

export interface Email1Lines {
  /** The brief pain angle this Email 1 leads with. Must be a most_buyers angle. */
  angle: string
  subject: TemplateLine
  /** One or two sentences: the pain as a peer-group pattern, plus its consequence. */
  pain: TemplateLine
  /** ONE sentence: what the sender does, then what the reader gets, citing a scope.does item and an outcome. */
  offer: TemplateLine
  /** One interest question, answerable in a word. Never a meeting request. */
  question: TemplateLine
  /**
   * THE LEAD-IN TO THE OFFER (operator, 2026-10-03): a conditional clause that names the
   * reader's firm and asks, never asserts: "If {company} is seeing this too,". Code joins it
   * in front of the offer sentence ("..., we find ..."), so the offer line itself is
   * unchanged and keeps its own slots. Its slot_free form ("If you're seeing this too,") is
   * what a prospect with no usable name receives. Absent on documents written before it
   * existed: the offer then stands alone, as it always did.
   */
  lead_in?: TemplateLine
  /**
   * The ONE problem this variant's offer line answers, in 10 words or fewer, or null for
   * the document's single NEUTRAL offer line, which names no specific problem. Read by the
   * offer-line selector (src/lib/composition/offer-angle.ts, copy-writing a9044e5): on the
   * researched path it picks the variant whose offer answers the hook, else the neutral
   * line. Stored on Email 1 as emails[0].offer_angle, where the selector reads it.
   */
  offer_angle: string | null
}

export interface FollowupLines {
  position: 2 | 3 | 4
  /** Emails 2 and 3: the angle this email brings. Email 4: the angle it names (= Email 1's). */
  angle: string
  paragraphs: TemplateLine[]
}

export interface VariantLines {
  brief_version: number
  email1: Email1Lines
  followups: FollowupLines[]
}

export interface FirmFactTierConfig {
  /** When false, no extraction is paid for and no prospect receives the firm-fact tier. */
  enabled: boolean
}

export interface SenderSignoff {
  firstName: string
  companyName: string
}

const PLACEHOLDER = /\{(does|for_whom|peer_group|company)\}/g

/** The slots a string actually contains, in order of first appearance. */
export function slotsIn(text: string): Slot[] {
  const found: Slot[] = []
  for (const m of text.matchAll(PLACEHOLDER)) {
    const slot = m[1] as Slot
    if (!found.includes(slot)) found.push(slot)
  }
  return found
}

/**
 * Fill a line's placeholders. Returns null when any placeholder has no fill, so a caller
 * can never ship a literal "{for_whom}".
 *
 * Capitalises the first letter of the result and of any sentence that a fill begins,
 * because a fill is stored lower-case ("you make trays for food brands") and a frame may
 * put it first.
 */
export function fillSlots(text: string, fills: SlotFills, opts: { capitalise?: boolean } = {}): string | null {
  let missing = false
  const filled = text.replace(PLACEHOLDER, (_, slot: Slot) => {
    const value = fills[slot]?.trim()
    if (!value) {
      missing = true
      return ''
    }
    return value
  })
  if (missing) return null
  return opts.capitalise === false ? filled : capitaliseSentenceStarts(filled)
}

function capitaliseSentenceStarts(text: string): string {
  return text
    .replace(/^\s*([a-z])/, (_, c: string) => c.toUpperCase())
    .replace(/([.?!]\s+)([a-z])/g, (_, stop: string, c: string) => stop + c.toUpperCase())
}

/**
 * The slot-free rendering of a line. Never returns a string with a placeholder in it.
 *
 * `capitalise: false` is for SUBJECTS, which are not sentences and keep the case they were
 * written in. Without it a subject opening on {peer_group} read "Exporters and new markets"
 * slot-free and "software makers and new markets" filled: one line, two cases, depending on
 * whether the prospect had a peer label.
 */
export function renderSlotFree(line: TemplateWording, peerGroupDefault: string, opts: { capitalise?: boolean } = {}): string {
  if (line.slot_free !== null && line.slot_free.trim() !== '') return line.slot_free.trim()
  const slots = slotsIn(line.text)
  if (slots.length === 0) return line.text.trim()
  if (slots.every(s => s === 'peer_group')) {
    const filled = fillSlots(line.text, { peer_group: peerGroupDefault }, opts)
    if (filled !== null) return filled.trim()
  }
  // Unreachable for a document that passed the validator, which requires slot_free for
  // every line declaring does or for_whom. Throwing is the fail-closed answer: a composed
  // email with a missing line must not be shipped.
  throw new Error(`renderSlotFree: line declares ${slots.join(', ')} and has no slot_free form`)
}

/**
 * Render a line WITH fills where every declared slot has one, otherwise slot-free.
 * Returns which form was used, so composition can record it.
 */
export function renderLine(
  line: TemplateWording,
  fills: SlotFills,
  peerGroupDefault: string,
  opts: { capitalise?: boolean } = {},
): { text: string; slotted: boolean } {
  const slots = slotsIn(line.text)
  if (slots.length > 0) {
    const filled = fillSlots(line.text, fills, opts)
    if (filled !== null) return { text: filled.trim(), slotted: true }
  }
  return { text: renderSlotFree(line, peerGroupDefault, opts), slotted: false }
}

/**
 * The offer paragraph: the lead-in, when there is one, joined in front of the offer
 * sentence. The offer opens "We ..." (offer_shape), which becomes "we" after the clause.
 */
export function joinLeadIn(leadIn: string | null, offer: string): string {
  if (!leadIn || !leadIn.trim()) return offer
  const continued = offer.trim().replace(/^We\b/, 'we')
  return `${leadIn.trim()} ${continued}`
}

/**
 * The offer paragraph with the reader's firm named in the lead-in, or null when the
 * paragraph cannot be named: no lead-in, no name, or a paragraph that is not the slot-free
 * one this line renders. Used by composition after an Email 1 is final, on every tier.
 */
export function namedLeadInParagraph(paragraph: string, leadIn: TemplateLine | null | undefined, companyName: string | null): string | null {
  if (!leadIn || !companyName?.trim()) return null
  const slotFree = leadIn.slot_free?.trim()
  if (!slotFree || !paragraph.startsWith(`${slotFree} `)) return null
  const named = fillSlots(leadIn.text, { company: companyName })
  if (named === null) return null
  return `${named.trim()}${paragraph.slice(slotFree.length)}`
}

function signoffLines(signoff: SenderSignoff): string {
  return `${signoff.firstName}\n${signoff.companyName}`
}

function joinParagraphs(paragraphs: string[]): string {
  return paragraphs.map(p => p.trim()).filter(p => p.length > 0).join('\n\n')
}

/**
 * Email 1 for a template-tier prospect: greeting, pain, offer, question, sign-off.
 * `wording` picks which wording of each line; omitted, it is wording 0, which is the
 * stored body.
 */
export function renderEmail1SlotFree(
  email1: Email1Lines,
  peerGroupDefault: string,
  signoff: SenderSignoff,
  wording: WordingChoice = {},
): { subject: string; body: string } {
  return {
    subject: renderSlotFree(pick(email1.subject, wording.subject), peerGroupDefault, { capitalise: false }),
    body: joinParagraphs([
      '{{first_name}}',
      renderSlotFree(pick(email1.pain, wording.pain), peerGroupDefault),
      joinLeadIn(email1.lead_in ? renderSlotFree(email1.lead_in, peerGroupDefault) : null, renderSlotFree(pick(email1.offer, wording.offer), peerGroupDefault)),
      renderSlotFree(pick(email1.question, wording.question), peerGroupDefault),
      signoffLines(signoff),
    ]),
  }
}

/** The subject cap applied to every rendered subject, slotted or not. */
export const SUBJECT_MAX_CHARS = 40

export interface FactEmail1 {
  subject: string
  body: string
  /** The opener sentence alone: the frame with the prospect's clause in it. */
  opener: string
  /** Index into opener_frames of the frame used. */
  frame_index: number
  subject_slotted: boolean
  pain_slotted: boolean
  offer_slotted: boolean
  question_slotted: boolean
}

/**
 * Email 1 for a firm-fact prospect: greeting, opener, pain, offer, question, sign-off.
 *
 * Returns null when there is no {does} fill, because the opener is the one line with no
 * slot-free form: without it this is not the firm-fact tier, it is the template.
 *
 * Every other line falls back to its slot-free form on its own. A slotted subject that
 * renders over the 40-character cap falls back to the slot-free subject.
 */
export function renderFactEmail1(input: {
  email1: Email1Lines
  openerFrames: readonly string[]
  frameIndex: number
  fills: SlotFills
  peerGroupDefault: string
  signoff: SenderSignoff
  /** Which wording of each line. Omitted means wording 0. */
  wording?: WordingChoice
}): FactEmail1 | null {
  const { email1, openerFrames, frameIndex, fills, peerGroupDefault, signoff } = input
  const wording = input.wording ?? {}
  if (!fills.does?.trim()) return null
  const frame = openerFrames[frameIndex]
  if (!frame) return null
  const opener = fillSlots(frame, { does: fills.does })
  if (opener === null) return null

  // A subject is not a sentence: it keeps the case it was written in. Capitalising it
  // shipped "New boutique hotel brands" beside lower-case slot-free subjects (2026-09-30).
  const subjectLine = pick(email1.subject, wording.subject)
  const subject = renderLine(subjectLine, fills, peerGroupDefault, { capitalise: false })
  const subjectFits = subject.text.length <= SUBJECT_MAX_CHARS
  const pain = renderLine(pick(email1.pain, wording.pain), fills, peerGroupDefault)
  const offer = renderLine(pick(email1.offer, wording.offer), fills, peerGroupDefault)
  const question = renderLine(pick(email1.question, wording.question), fills, peerGroupDefault)

  return {
    subject: subjectFits ? subject.text : renderSlotFree(subjectLine, peerGroupDefault, { capitalise: false }),
    body: joinParagraphs([
      '{{first_name}}', opener, pain.text,
      joinLeadIn(email1.lead_in ? renderLine(email1.lead_in, fills, peerGroupDefault).text : null, offer.text),
      question.text, signoffLines(signoff),
    ]),
    opener: opener.trim(),
    frame_index: frameIndex,
    subject_slotted: subjectFits && subject.slotted,
    pain_slotted: pain.slotted,
    offer_slotted: offer.slotted,
    question_slotted: question.slotted,
  }
}

/**
 * A follow-up body WITH the fills a prospect has: each paragraph filled where every slot
 * it declares has a fill, otherwise in its slot-free form, on its own. Returns which
 * paragraphs were filled, so composition can record what a prospect was sent.
 *
 * With no fills this is exactly renderFollowupSlotFree, which is the stored body.
 */
export function renderFollowup(
  followup: FollowupLines,
  fills: SlotFills,
  peerGroupDefault: string,
  signoff: SenderSignoff,
): { body: string; slotted: boolean[] } {
  const rendered = followup.paragraphs.map(p => renderLine(p, fills, peerGroupDefault))
  return {
    body: joinParagraphs(['{{first_name}}', ...rendered.map(r => r.text), signoffLines(signoff)]),
    slotted: rendered.map(r => r.slotted),
  }
}

/** A follow-up body with no fills: what is stored, and what a prospect with none receives. */
export function renderFollowupSlotFree(
  followup: FollowupLines,
  peerGroupDefault: string,
  signoff: SenderSignoff,
): string {
  return joinParagraphs([
    '{{first_name}}',
    ...followup.paragraphs.map(p => renderSlotFree(p, peerGroupDefault)),
    signoffLines(signoff),
  ])
}

/**
 * Which opener frame a prospect gets. Deterministic by prospect id, so a recomposition
 * produces the same email and a report can be reproduced.
 */
export function openerFrameIndex(prospectId: string, frameCount: number): number {
  if (frameCount <= 0) return -1
  const digest = createHash('sha256').update(`opener-frame:${prospectId}`).digest()
  return digest.readUInt32BE(0) % frameCount
}
