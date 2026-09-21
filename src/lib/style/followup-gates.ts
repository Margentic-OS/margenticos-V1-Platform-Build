// Deterministic gates for written follow-up emails.
//
// ADR-028: code validators are the hard gates on model output and prompt instructions are
// advisory. Everything here is a rule the prompt also states, restated in code because the
// prompt stating it is not enforcement.
//
// THESE GATES FAIL SOFT, and that is decided by the CALLER rather than here. This module
// returns reasons; write-opening puts them in their own array and never in `gates`, so a
// bad follow-up falls back to its template follow-up and cannot consume one of the two or
// three attempts Email 1 gets. The reasoning is the subject line's, one position further
// along: Email 1 is the email that decides whether anything is read at all, and spending
// its attempts on a problem that is not its own is a direct transfer of budget away from
// it.
//
// RULE ZERO. Every pattern below is generic English: quantifiers, pronouns, tense markers,
// punctuation. No industry noun, no buyer archetype, no worked example. The one piece of
// client-specific material this module touches is the stripped reference passed in at
// runtime, and it is only ever used as a HAYSTACK to reject against, never as a source of
// anything.

import { findFirmographicFigures } from './firmographic'

/** Lowercased, punctuation-stripped, single-spaced. For comparing prose to prose. */
export function normaliseForEcho(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

/**
 * How many consecutive words make an echo.
 *
 * SIX, matching the approved-offer-line gate in write-opening, which has been live and
 * has not been reported as a false positive. Six normalised words is long enough that two
 * writers do not land on it by accident and short enough to catch a lifted clause rather
 * than only a lifted sentence.
 */
export const ECHO_NEEDLE_WORDS = 6

/**
 * The first run of ECHO_NEEDLE_WORDS words from `text` that also appears in `reference`,
 * or null.
 *
 * SLIDES A WINDOW rather than testing the opening words alone. The offer-line gate tests
 * one needle because it is asking whether a whole fixed paragraph was reproduced. Here the
 * question is whether ANY clause travelled, and a lifted sentence in the middle of a
 * paragraph is the likelier shape.
 */
export function findEcho(text: string, reference: string): string | null {
  if (!reference.trim()) return null
  const hay = normaliseForEcho(reference)
  if (!hay) return null

  const words = normaliseForEcho(text).split(' ').filter(Boolean)
  for (let i = 0; i + ECHO_NEEDLE_WORDS <= words.length; i++) {
    const needle = words.slice(i, i + ECHO_NEEDLE_WORDS).join(' ')
    if (hay.includes(needle)) return needle
  }
  return null
}

/**
 * Openings that are the same move however they are worded.
 *
 * A LIST OF MOVES, NOT OF STRINGS. Each entry is one way of saying "I am writing again and
 * I have nothing to add", which is the thing being rejected. Adding a wording to an entry
 * is maintenance; adding an entry is a decision.
 */
const BANNED_PHRASES: readonly RegExp[] = [
  /\bjust (?:following up|circling back|checking in|bumping this|touching base)\b/i,
  /\b(?:wanted|thought I'?d|figured I'?d) to? ?(?:follow up|circle back|check in)\b/i,
  /\b(?:i )?(?:never|didn'?t|haven'?t) heard (?:back|from you)\b/i,
  /\bhope (?:this (?:finds|email finds) you well|you'?re well|all is well|you'?re doing well)\b/i,
  /\bin case (?:this|it|my last(?: email)?) (?:got|was) (?:buried|missed|lost)\b/i,
]

/**
 * References to WHEN the previous email went out, or to the gap since it did.
 *
 * BANNED BECAUSE THE GAP IS NOT KNOWN AT WRITING TIME. These emails are written in one
 * response, days before they send, and the interval between each send is set by the
 * sending tool rather than by us. A sentence naming the interval is therefore a claim the
 * writer has no way to make true, and it is wrong for every prospect whose sequence is
 * paused, resumed after an out-of-office, or re-timed.
 *
 * DELIBERATELY NOT A BAN ON TIME WORDS IN GENERAL. A date or a month describing the
 * PROSPECT'S own activity is the entire basis of the observation Email 1 is built on, and
 * it must keep working here. What is banned is a time reference whose subject is our own
 * previous message or the silence after it.
 */
const BANNED_TIME_REFERENCES: readonly RegExp[] = [
  /\b(?:last|earlier this|the other) (?:week|day|month)\b/i,
  /\byesterday\b/i,
  /\ba (?:few|couple of) (?:days|weeks) ago\b/i,
  /\bsince (?:i|we) (?:emailed|wrote|reached out|got in touch)\b/i,
  /\bmy (?:last|previous|first) (?:email|message|note)\b/i,
  /\b(?:when|after) (?:i|we) (?:wrote|emailed|reached out)\b/i,
]

/**
 * Quantifiers over a population, at the START of a sentence.
 *
 * THE POPULATION OPENER IS THE ONE MOVE THE REFERENCE MATERIAL IS FULL OF. Measured
 * 2026-09-21 on the active document of the one live organisation: eight of eight template
 * follow-ups at positions 2 and 3 open this way. The reference has its first paragraph
 * stripped for exactly this reason (see followup-frame.ts), and this gate is the second
 * layer, because a strip removes what can be copied and does not remove the writer's own
 * habit of reaching for the shape.
 *
 * ANCHORED TO THE SENTENCE START. Mid-sentence generalisation is ordinary English and is
 * how the bridge works in Email 1. It is the OPENING that must be about this reader.
 */
const POPULATION_OPENERS: readonly RegExp[] = [
  /^(?:most|many|some|few|plenty of|a lot of|the majority of|the average)\b/i,
  /^(?:everyone|everybody|nobody|no one|anyone)\b/i,
  /^(?:people|firms|companies|teams|founders|owners|businesses|leaders)\s+(?:who|that|at|in|like)\b/i,
  /^(?:there(?:'s| is| are)|it(?:'s| is))\s+(?:a |an |one )?(?:common|usual|typical|familiar)\b/i,
  /^the (?:pattern|cost|problem|issue|thing|trap|difference|counterintuitive)\b/i,
  /^when\s+\w+\s+(?:has|have|fails?|failed|goes|go|runs?)\b/i,
]

/** Second person, or a possessive of it. The marker that a sentence is addressed to them. */
const SECOND_PERSON = /\byou(?:'re|r|rs|rself)?\b/i

/**
 * Legal and descriptive suffixes that are part of a registered name and never part of how
 * anybody refers to a company in a sentence.
 */
const COMPANY_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'plc', 'llp', 'lp', 'corp', 'corporation', 'co',
  'company', 'group', 'holdings', 'partners', 'partnership', 'associates', 'consulting',
  'consultancy', 'consultants', 'advisors', 'advisers', 'advisory', 'services', 'solutions',
  'international', 'global', 'gmbh', 'bv', 'sa', 'srl', 'pty', 'pte', 'ag', 'nv', 'oy', 'ab',
  // 'business' and 'enterprises' are here for the OTHER direction. Without them, a name
  // like "Global Business Consulting Services" falls through its leading descriptive words
  // and offers "Business" as a short form, and the gate would then count a sentence saying
  // "Business is slow" as naming the company. A generic word must never become the token
  // that proves a callback.
  'business', 'businesses', 'enterprise', 'enterprises', 'management', 'strategy',
])

/**
 * The shortest form of a company name that a person would actually write.
 *
 * ═══ THIS FIXES A MEASURED FALSE POSITIVE, AND THE DIRECTION MATTERS ═══
 *
 * The first version matched `companyName` IN FULL against the opening sentence. Real copy
 * uses the short form, so on the 2026-09-21 run SIX of the TWELVE hits on the callback
 * gate were emails that did name the company and were rejected anyway:
 *
 *     written      stored
 *     "Abacus"     "Abacus Business Consulting, Inc."
 *     "Cavalry"    "Cavalry Consulting LLC"
 *     "Interra's"  "Interra Consulting"
 *     "BCR"        "BCR Business Consulting Resources, Inc."
 *     "Matrix"     "Matrix Restaurant Consulting"
 *     "CANDOR"     "CANDOR Management Consulting"
 *
 * Half the gate's output was wrong, and wrong in the expensive direction: it threw away
 * correct copy and spent a retry doing it.
 *
 * SO THIS TAKES THE FIRST SIGNIFICANT TOKEN, suffixes dropped. It deliberately does NOT
 * try to match any token: a company called "Matrix Restaurant Consulting" should not be
 * credited with a callback because the email happened to contain the word "restaurant".
 * The leading token is the distinguishing part of a name in every case measured, and
 * anything looser starts accepting ordinary nouns as company references.
 *
 * Returns null when nothing usable survives, and the caller then requires second person,
 * which is the stricter branch and the safe direction to fail in.
 */
export function companyNameForms(companyName: string | null | undefined): string[] {
  if (!companyName) return []
  const forms: string[] = []

  // A PARENTHESISED OR ALL-CAPS ACRONYM, WHEREVER IT SITS. Found on the 2026-09-21 rerun,
  // after the leading-token rule below had already fixed six of eight false positives. The
  // remaining two were companies whose real short form is an acronym at the END:
  //
  //     written     stored
  //     "VMF's"     "Virtual Miss Friday (VMF Ltd)"
  //     "GBCS's"    "Global Business Consulting Services (GBCS)"
  //
  // The leading token is "Virtual" and "Global", so the rule below could never reach them.
  // An acronym is safe to accept from anywhere in the name in a way an ordinary word is
  // not: it is distinctive by construction, so it cannot collide with a common noun the
  // way accepting "Restaurant" from "Matrix Restaurant Consulting" would.
  for (const token of companyName.match(/\b\p{Lu}{2,}\b/gu) ?? []) {
    if (!COMPANY_SUFFIXES.has(token.toLowerCase())) forms.push(token)
  }

  // THE FIRST SIGNIFICANT TOKEN, suffixes dropped. This is the distinguishing part of an
  // ordinary company name, and it fixed six measured false positives where the gate had
  // matched the registered name in full while the copy used the short form:
  //
  //     "Abacus" / "Abacus Business Consulting, Inc."      "Cavalry" / "Cavalry Consulting LLC"
  //     "Interra's" / "Interra Consulting"                 "BCR" / "BCR Business Consulting Resources, Inc."
  //     "Matrix" / "Matrix Restaurant Consulting"          "CANDOR" / "CANDOR Management Consulting"
  //
  // Half the gate's output was wrong, and wrong in the expensive direction: it threw away
  // correct copy and spent a retry doing it.
  //
  // DELIBERATELY NOT "ANY TOKEN". A company called "Matrix Restaurant Consulting" must not
  // be credited with a callback because the email happened to say "restaurant". Anything
  // looser starts accepting ordinary nouns as company references, which turns a gate that
  // was too strict into one that passes copy it should reject.
  for (const raw of companyName.split(/[\s,./&-]+/)) {
    const token = raw.replace(/[^\p{L}\p{N}]/gu, '')
    if (token.length < 2) continue
    if (COMPANY_SUFFIXES.has(token.toLowerCase())) continue
    forms.push(token)
    break
  }

  return [...new Set(forms)]
}

/** The single short form, kept for callers that want one. Null when none survives. */
export function companyShortForm(companyName: string | null | undefined): string | null {
  return companyNameForms(companyName)[0] ?? null
}

/**
 * Longest sentence permitted, in words. Under 25, per the sequence rule, so 24 is the
 * largest that passes.
 */
export const FOLLOWUP_MAX_SENTENCE_WORDS = 24

/** Sentences, split on terminal punctuation. Good enough for counting length. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function wordsIn(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** A short, safe excerpt of offending copy for a gate message. */
function quote(text: string, max = 90): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return JSON.stringify(t.length > max ? `${t.slice(0, max)}…` : t)
}

export interface FollowupGateInput {
  /**
   * The evidence corpus the traceability and firmographic checks read. Same string the
   * Email 1 gates read, so a figure legal there is legal here.
   */
  findingsEvidence?: string
  /** The written middle prose for this email. */
  prose: string
  /** Which email this is, for the message. */
  position: 2 | 3
  /** The stripped template reference this email was written against. */
  reference: string
  /**
   * The approved offer line from Email 1, which this writer is shown as part of the
   * Email 1 body.
   *
   * A SECOND ECHO CORPUS, AND A NARROW ONE ON PURPOSE. Email 2's job is to explain the
   * mechanism, so it SHOULD overlap with the offer line in substance, and its callback
   * SHOULD reference Email 1's observation. Echo-gating the whole of Email 1 would
   * therefore reject the thing the email is for. What must not happen is the offer line
   * coming back word for word, because the reader already read it in Email 1 and a
   * verbatim repeat reads as a template with the paragraphs shuffled.
   *
   * This mirrors the offer-line echo gate the Email 1 writer already has, which exists
   * for the same reason one position earlier.
   */
  offerLine?: string | null
  /** The prospect's company name, which counts as addressing them by name. */
  companyName?: string | null
  /** The composed body's word count, measured the way composition measures it. */
  bodyWordCount: number
  /** The band for this position, from EMAIL_WORD_LIMITS. */
  minWords: number
  maxWords: number
}

/**
 * Every reason this follow-up must not ship. Empty means it may.
 *
 * ONE ARRAY, THEREFORE ONE SOFT-FAIL PATH BY CONSTRUCTION. There is no second channel a
 * failure could take and no way to add one without editing the single `return` below. The
 * subject gate in write-opening is written the same way and says so for the same reason.
 */
export function checkFollowupGates(input: FollowupGateInput): string[] {
  const failures: string[] = []
  const { prose, position, reference, companyName, bodyWordCount, minWords, maxWords } = input
  const offerLine = input.offerLine ?? null
  const label = `email ${position}`

  const text = prose.trim()
  if (!text) {
    failures.push(`${label}: the writer returned nothing`)
    return failures
  }

  const sentences = sentencesOf(text)

  // ── The opening sentence is about THIS READER ──────────────────────────────
  const first = sentences[0] ?? text
  const population = POPULATION_OPENERS.find(re => re.test(first))
  if (population) {
    failures.push(
      `${label} opens on a population rather than a callback: ${quote(first)}. ` +
      'The first sentence must point at something this prospect can recognise as theirs.',
    )
  }

  // The SHORT form, not the registered name. See companyShortForm: matching the full name
  // rejected six correct emails on the 2026-09-21 run.
  // ANY acceptable short form, not just the leading token. See companyNameForms.
  const namesCompany = companyNameForms(companyName).some(form =>
    new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(first))
  if (!SECOND_PERSON.test(first) && !namesCompany) {
    failures.push(
      `${label} opens without addressing the reader: ${quote(first)}. ` +
      'The callback must say "you" or name their company, or it is not a callback.',
    )
  }

  // ── Moves that say "I am writing again and have nothing to add" ────────────
  for (const re of BANNED_PHRASES) {
    const hit = text.match(re)
    if (hit) failures.push(`${label} uses a banned follow-up phrase: ${quote(hit[0])}`)
  }

  for (const re of BANNED_TIME_REFERENCES) {
    const hit = text.match(re)
    if (hit) {
      failures.push(
        `${label} refers to when the previous email went out: ${quote(hit[0])}. ` +
        'The gap between sends varies and is not known when this is written.',
      )
    }
  }

  // ── Lifted from the reference it was shown ─────────────────────────────────
  const echo = findEcho(text, reference)
  if (echo) {
    failures.push(
      `${label} reproduces ${ECHO_NEEDLE_WORDS} consecutive words from the client's ` +
      `approved follow-up it was shown as a reference: ${quote(echo)}`,
    )
  }

  const offerEcho = offerLine ? findEcho(text, offerLine) : null
  if (offerEcho) {
    failures.push(
      `${label} reproduces ${ECHO_NEEDLE_WORDS} consecutive words of the offer line the ` +
      `prospect already read in email 1: ${quote(offerEcho)}`,
    )
  }

  // ── House rules that apply to every email we send ──────────────────────────
  const questionMarks = (text.match(/\?/g) ?? []).length
  if (questionMarks > 1) {
    failures.push(`${label} asks ${questionMarks} questions: the closing question is the only one`)
  }

  const longest = sentences.reduce<{ words: number; text: string }>(
    (worst, s) => (wordsIn(s) > worst.words ? { words: wordsIn(s), text: s } : worst),
    { words: 0, text: '' },
  )
  if (longest.words > FOLLOWUP_MAX_SENTENCE_WORDS) {
    failures.push(
      `${label} has a ${longest.words}-word sentence against a cap of ` +
      `${FOLLOWUP_MAX_SENTENCE_WORDS}: ${quote(longest.text)}`,
    )
  }

  // A FIGURE FROM THE PROSPECT'S RECORD IS BANNED HERE EXACTLY AS IT IS IN EMAIL 1.
  // CLAUDE.md states this as a hard fail for email content generally, not for one position:
  // "it reads as a database lookup, it may be wrong, and a wrong number in the opening line
  // is worse than a generic one". A follow-up is no safer a place for it.
  const figures = findFirmographicFigures(text)
  if (figures.length > 0) {
    failures.push(
      `${label} quotes ${figures.join(' and ')} from the prospect's record: ` +
      'qualify by role, stage or situation instead',
    )
  }

  if (bodyWordCount < minWords || bodyWordCount > maxWords) {
    failures.push(
      `${label} composes to ${bodyWordCount} words, outside its band of ${minWords} to ${maxWords}`,
    )
  }

  return failures
}

/**
 * Reasons emails 2 and 3 must not ship AS A PAIR. Separate from the per-email gate because
 * these cannot be evaluated on one email alone.
 */
export function checkFollowupPairGates(
  email2: string,
  email3: string,
  words2: number,
  words3: number,
): string[] {
  const failures: string[] = []

  // Email 3 no longer than Email 2. The taper is carried by the bands themselves; this
  // binds only when Email 2 lands near its floor, which is the same shape and the same
  // justification as the rule the messaging agent keeps for the template path.
  if (words3 > words2) {
    failures.push(`email 3 is ${words3} words against email 2's ${words2}: it must not be longer`)
  }

  // ONE FINDING DEVELOPED, NOT ONE SENTENCE REPEATED. A shared sentence means email 3 is
  // restating email 2 rather than taking a different angle on the same finding.
  const in2 = new Set(
    sentencesOf(email2).map(normaliseForEcho).filter(s => s.split(' ').length >= 4),
  )
  const shared = sentencesOf(email3)
    .map(s => ({ raw: s, norm: normaliseForEcho(s) }))
    .find(s => s.norm.split(' ').length >= 4 && in2.has(s.norm))
  if (shared) {
    failures.push(`email 3 repeats a sentence from email 2 verbatim: ${quote(shared.raw)}`)
  }

  return failures
}
