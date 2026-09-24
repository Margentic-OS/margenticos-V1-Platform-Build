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

import { checkActivityVerdict } from './activity-verdict'
import { findFirmographicFigures } from './firmographic'
import { splitIntoSentences } from './sentence-count'
import { findYearCountFaults } from './year-count'
import {
  findAssumedCapacityClaims, assumedCapacityFeedback, isUnambiguousReaderClaim, isSenderSide,
} from './assumed-capacity'
import { findAudienceContactClaims, audienceContactFeedback } from './audience-contact'
import { logger } from '@/lib/logger'

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
/**
 * The LEGAL suffixes only, for the whole-name fallback below.
 *
 * SEPARATE FROM COMPANY_SUFFIXES ON PURPOSE. That set also holds descriptive words like
 * 'consulting' and 'business', which are there to stop a GENERIC word becoming the one token
 * that proves a callback. Stripping those from a whole-name fallback would be the opposite
 * mistake: it would turn "8 Consulting" into "8" and the fallback would be worse than the
 * rule it rescues.
 */
const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'plc', 'llp', 'lp', 'corp', 'corporation',
  'gmbh', 'bv', 'sa', 'srl', 'pty', 'pte', 'ag', 'nv', 'oy', 'ab',
])

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

  // ── EVERY TOKEN SKIPPED MEANS NO FORM AT ALL, AND THAT IS UNSATISFIABLE ─────
  //
  // Measured 2026-09-24: companyNameForms('8 Consulting') returned []. The first token is
  // one character and is skipped for being under two; the second is in COMPANY_SUFFIXES and
  // is skipped as a suffix; the loop then ends with nothing. The callback gate asks whether
  // the copy says "you" or names the company, so with no form to match, NO EMAIL THIS
  // PROSPECT COULD EVER RECEIVE can satisfy it. One prospect's Email 3 opened by naming the
  // company in full and was rejected anyway, and both follow-ups were lost.
  //
  // Any name whose only non-suffix token is a single character hits this, and so does one
  // made entirely of suffix words. The rules above are about choosing the BEST short form;
  // when they choose none, the answer is not "this company has no name".
  //
  // THE FALLBACK IS THE WHOLE NAME WITH LEGAL SUFFIXES REMOVED, which is a form that
  // certainly appears when the copy names the company in full, and is strictly safer than
  // the leading-token rule: it is longer and more distinctive, so it cannot collide with an
  // ordinary noun the way accepting "Restaurant" from "Matrix Restaurant Consulting" would.
  // Only LEGAL suffixes come off, so "8 Consulting" keeps "Consulting" and yields the
  // name as written rather than the bare "8".
  //
  // ONLY WHEN A DISTINGUISHING TOKEN EXISTS AND WAS TOO SHORT, never when every token is a
  // generic word. The two cases look identical from here, both produce no form, and they
  // need opposite answers:
  //
  //   "8 Consulting"        "8" is distinctive and was skipped for LENGTH.   Fall back.
  //   "Consulting Group"    every token is generic. There is nothing to see. Do not.
  //
  // Falling back on the second would credit any sentence containing "consulting group" as
  // naming the company, which is the exact collision COMPANY_SUFFIXES exists to prevent,
  // one phrase up. Such a company is still reachable through the second-person branch,
  // which is an ordinary requirement rather than an impossible one.
  const hasShortDistinguishingToken = companyName
    .split(/[\s,./&-]+/)
    .map(raw => raw.replace(/[^\p{L}\p{N}]/gu, ''))
    .some(token => token.length > 0 && token.length < 2 && !COMPANY_SUFFIXES.has(token.toLowerCase()))

  if (forms.length === 0 && hasShortDistinguishingToken) {
    const whole = companyName
      .split(/[\s,]+/)
      .filter(word => {
        const bare = word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
        return bare.length > 0 && !LEGAL_SUFFIXES.has(bare)
      })
      .join(' ')
      .trim()
    if (whole) forms.push(whole)
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
  return splitIntoSentences(text)
}

/**
 * The reference with its closing question removed, for the echo check only.
 *
 * Returns the reference unchanged when it ends in no question, which is the conservative
 * direction: nothing is excluded unless it is clearly the approved question.
 */
function referenceWithoutClosingQuestion(reference: string): string {
  const sentences = splitIntoSentences(reference)
  if (sentences.length === 0) return reference
  const last = sentences[sentences.length - 1]
  if (!last.trim().endsWith('?')) return reference
  return sentences.slice(0, -1).join(' ')
}

/** Paragraphs, split on a blank line. A follow-up with no blank line is one paragraph. */
function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
}

/** The first paragraph, for email 3's callback scope. */
function firstParagraphOf(text: string): string {
  return paragraphsOf(text)[0] ?? ''
}

/**
 * The most sentences one paragraph of a generated follow-up holds AFTER REFORMATTING.
 *
 * TWO, because a follow-up is read in a thread by someone who did not reply to the first
 * one. One constant, so disagreeing with it is a one-line change.
 */
export const MAX_SENTENCES_PER_PARAGRAPH = 2

/**
 * SPLITS OVERLONG PARAGRAPHS. IT REJECTS NOTHING.
 *
 * Paragraph length is the one fault here that has a correct answer computable without
 * asking again: the words are right and only the line breaks are wrong. A gate would spend
 * a model call, and an exhausted retry costs the prospect a personalised email, to arrive
 * at a result this function produces for free.
 *
 * WORD-FOR-WORD IDENTICAL, guaranteed by construction: it re-joins the sentences
 * splitIntoSentences returns and inserts blank lines between groups of two. It never
 * rewrites, drops or reorders anything.
 *
 * Run BEFORE the gates, so every other check sees the text as it will ship.
 */
export function reformatParagraphs(prose: string): string {
  return (prose ?? '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .flatMap(para => {
      const sentences = splitIntoSentences(para)
      if (sentences.length <= MAX_SENTENCES_PER_PARAGRAPH) return [para]
      const groups: string[] = []
      for (let i = 0; i < sentences.length; i += MAX_SENTENCES_PER_PARAGRAPH) {
        groups.push(sentences.slice(i, i + MAX_SENTENCES_PER_PARAGRAPH).join(' '))
      }
      return groups
    })
    .join('\n\n')
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
  /**
   * The prospect's own first name, so the gate can refuse copy that uses it in the third
   * person. REQUIRED, and null is an explicit value rather than an omission.
   *
   * NOT OPTIONAL, deliberately, and this is the one design decision in the field. Email 1's
   * equivalent is a required positional parameter (write-opening.ts:1371), so no caller can
   * forget it and the compiler says so. An optional field here would let a third call site
   * arrive later, compile, and silently skip the check, which is this codebase's most
   * repeated failure: a gate that exists and never runs reads on every report as a gate that
   * found nothing. Every caller that genuinely has no name passes null and says so.
   */
  prospectFirstName: string | null
  /**
   * The dated findings, for the year-count check. REQUIRED for the same reason
   * prospectFirstName is: an optional corpus is a gate that silently does not run, and
   * findingsEvidence a few fields up is this file's own worked example of exactly that.
   */
  datedCandidates: ReadonlyArray<{ date?: string | null }>
  /** The run clock, so the arithmetic is against the real date rather than the model's. */
  now: Date
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
  const { prose, position, reference, companyName, prospectFirstName, datedCandidates, now, bodyWordCount, minWords, maxWords } = input
  const offerLine = input.offerLine ?? null
  const label = `email ${position}`

  const text = prose.trim()
  if (!text) {
    failures.push(`${label}: the writer returned nothing`)
    return failures
  }

  // THE ABSENCE AND ACTIVITY-VERDICT GATE, the same one Email 1's observation and bridge
  // are held to. A follow-up telling the reader their own visible activity is failing, or
  // naming what they lack, is the same fault in email 2 as in email 1, and until now
  // nothing checked emails 2 and 3 for it at all.
  //
  // THE WHOLE EMAIL IS PASSED AS THE OBSERVATION HALF. The detector takes two parts because
  // Email 1 has two; a follow-up is prose with no equivalent split, and passing it as one
  // part keeps every hit attributable to this email rather than to a half that does not
  // exist here.
  for (const v of checkActivityVerdict(text, '', { prospectId: `followup-${position}` }, 'block')) {
    failures.push(`${label}: ${v}`)
  }

  // ── THE RECIPIENT IS NEVER NAMED IN THE THIRD PERSON ───────────────────────
  //
  // Measured on the runs of 2026-09-24: two follow-ups wrote about the reader by name,
  // "<first name> stops doing the prospecting herself" and "<first name> does not need to
  // shift focus". Email 1 has forbidden this since it had a writer; follow-ups never
  // inherited it, because the name was not in scope at this call site at all.
  //
  // WHY THE MODEL DOES IT, which is the part worth recording: the follow-up writer is handed
  // Email 1 with the merge tag ALREADY RESOLVED to the real name (produce-opening.ts), so it
  // reads "Andrea," as a literal greeting and reuses it as an ordinary proper noun. It is
  // imitating its input correctly. The defence is the gate, not a hope.
  //
  // NAMING THE COMPANY STAYS LEGAL. That is the callback gate's own alternative a few lines
  // below, and the two must not contradict each other.
  //
  // THE ORDINARY-WORD EXEMPTION. A first name is often a common English word: Mark, Grant,
  // Bill, Will, Rose, May, Art, Dawn, Drew, Hope. A bare word-boundary match on those would
  // reject correct copy for saying "will" or "the bill", which is the expensive direction:
  // one failure here discards BOTH follow-ups. So the match requires the name to be
  // CAPITALISED mid-sentence, which is what a proper noun looks like and what an ordinary
  // word does not, and the check is skipped at the start of a sentence where the capital
  // carries no information.
  if (prospectFirstName && prospectFirstName.trim().length > 1) {
    const name = prospectFirstName.trim()
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Capitalised as written, and NOT at the start of a sentence: preceded by a word
    // character or a space that is not the first character after terminal punctuation.
    const thirdPerson = new RegExp(`(?<![.!?]\\s)(?<!^)\\b${escaped}\\b`, 'g')
    // THE CALLBACK GATE'S ALTERNATIVE MUST STAY AVAILABLE. A few lines below, copy passes
    // by naming the company. If a company form CONTAINS the first name, as in a firm named
    // after its founder, that same sentence would trip this gate, and the two gates would
    // demand opposite things with no legal move between them. The company forms are
    // therefore cut out of the text before this gate reads it.
    const companyForms = companyNameForms(companyName)
    const withoutCompany = companyForms.reduce(
      (acc, form) => acc.split(form).join(' '.repeat(form.length)),
      text,
    )
    const hits = [...withoutCompany.matchAll(thirdPerson)].filter(m => {
      const matched = withoutCompany.slice(m.index ?? 0, (m.index ?? 0) + name.length)
      // Case-SENSITIVE on the first letter: "Will" is a name, "will" is a verb.
      return matched[0] === name[0].toUpperCase()
    })
    if (hits.length > 0) {
      const sentence = sentencesOf(text).find(x => new RegExp(`\\b${escaped}\\b`).test(x)) ?? text
      failures.push(
        `${label} names the reader in the third person ("${name}"): ${quote(sentence)}. ` +
        'Write to them as "you", or name their company. The email already greets them by name.',
      )
    }
  }

  // ── CLAIMS ABOUT THE READER'S CAPACITY, AND PROMISES ABOUT THEIR AUDIENCE ──
  //
  // Both checks existed and neither reached emails 2 and 3. findAssumedCapacityClaims had
  // four call sites in src and none was a follow-up; the audience check was never promoted
  // out of an analysis script at all, so for two runs it was measured and could not act.
  //
  // BLOCKING IS DELIBERATELY NARROWER THAN DETECTING, and that split is the whole design.
  // Measured 2026-09-24: wiring the unchanged detector to block on follow-ups hit four live
  // sentences, at least two of which were the SENDER describing its own work, and one
  // rejection here discards BOTH follow-ups. So:
  //
  //   BLOCK   a claim that names the reader or their firm and has no first-person subject
  //           governing it. "Your week is full", "Acme's attention is committed".
  //   COUNT   everything else, including the impersonal form, which may be the population
  //           statement a bridge is required to be. Logged, never returned.
  //
  // A SENDER-SIDE STATEMENT IS NEVER BLOCKED, per the instruction and per this module's own
  // header, which has listed sender statements as permitted since it was written.
  const readerNames = companyNameForms(companyName)
  for (const hit of findAssumedCapacityClaims(text)) {
    if (isUnambiguousReaderClaim(hit, readerNames)) {
      failures.push(`${label}: ${assumedCapacityFeedback([hit])}`)
    } else {
      logger.info('followup-gates: assumed-capacity scored, not gated', {
        position, kind: hit.kind, matched: hit.matched, sentence: hit.sentence,
        senderSide: isSenderSide(hit.sentence, hit.matched),
      })
    }
  }

  // THE AUDIENCE PROMISE BLOCKS OUTRIGHT. It is not a matter of degree: outbound reaches
  // people who have never heard of the prospect, so copy promising to reach the audience
  // they already have describes work nobody is selling, whoever the sender is. There is no
  // reading of it as a population statement, which is why it needs no sender exemption.
  for (const hit of findAudienceContactClaims(text)) {
    failures.push(`${label}: ${audienceContactFeedback([hit])}`)
  }

  // ── A COUNT OF YEARS IS ARITHMETIC ─────────────────────────────────────────
  // Email 3 said thirteen years about a firm founded fourteen years earlier, while Email 1's
  // subject for the same prospect said twelve. Both were model prose over a date the row
  // already held. See year-count.ts.
  for (const fault of findYearCountFaults(text, datedCandidates, now)) {
    failures.push(`${label}: ${fault}`)
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

  // ── WHERE THE CALLBACK HAS TO LAND ────────────────────────────────────────
  //
  // EMAIL 2: the first SENTENCE. EMAIL 3: anywhere in the first PARAGRAPH.
  //
  // MEASURED 2026-09-24. Three prospects with a clean personalised Email 1 shipped template
  // follow-ups, and two of the three died on this gate, both on EMAIL 3, both because the
  // paragraph opened on a general statement and addressed the reader in its second
  // sentence. Email 3 is the last message in the sequence and it earns a sentence of
  // context before it points; email 2 does not, because it arrives closest to the first.
  //
  // The scope is the only thing that differs. What counts as a callback is identical.
  const callbackScope = position === 3 ? (firstParagraphOf(text) || first) : first
  // The SHORT form, not the registered name. See companyShortForm: matching the full name
  // rejected six correct emails on the 2026-09-21 run.
  // ANY acceptable short form, not just the leading token. See companyNameForms.
  const namesCompany = companyNameForms(companyName).some(form =>
    new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(callbackScope))
  if (!SECOND_PERSON.test(callbackScope) && !namesCompany) {
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
  //
  // THE REFERENCE'S CLOSING QUESTION IS EXCLUDED. It is the client's own approved copy and
  // reusing it is permitted, so matching against it rejects a follow-up for doing something
  // allowed. Measured 2026-09-24: one prospect with a clean personalised Email 1 lost its
  // follow-ups to "worth a quick call to see", six words of the approved question.
  //
  // THE LAST QUESTION IN THE REFERENCE, not any question: an approved follow-up asks one,
  // and it is the last sentence. Dropping every interrogative would blind the check to a
  // lifted mid-paragraph question, which is not approved copy.
  const echo = findEcho(text, referenceWithoutClosingQuestion(reference))
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
