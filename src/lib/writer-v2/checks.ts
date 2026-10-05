// THE ONLY CHECKS ON THE WRITER V2 PATH, and the two code transforms.
//
// Decided by the operator on 2026-10-03 (Notion: "Writer v2: playbook format ... prototype
// spec", sections 0 and 1). The old writing path's gates (the bridge fact-check, capacity,
// activity, need-match, judge and floor checks) are NOT run here: the relevance test showed
// they reject natural writing. What remains is:
//
//   1. WORD COUNTS, section 0's raised bands, counted as sent: greeting line, body and the
//      two-line sign-off, footer excluded (the same count CLAUDE.md states for every email).
//   2. TRUTH for claims about the prospect or their firm: every declared claim rests on a fact
//      that was offered, quotes it, and names the right month and year; undeclared claims are
//      caught where code can see them (a statement naming the firm, an event-shaped sentence,
//      a proper noun or number found in no input). An abbreviation and its full form count as
//      the same name ("HR" for "Human Resources").
//   3. SENDER SCOPE: a sender claim either cites a line that is in the playbook, or describes
//      only actions the playbook's offer names (every content word it uses appears in the offer,
//      its short wordings or the proof). No sentence may match the playbook's never-claim or
//      call-to-action patterns, whatever else it passes.
//
// RETRY REDUCTION (operator, 2026-10-05, after the first 188-prospect batch, where 130 of 188
// sequences had at least one failed attempt):
//   - the writer is given its word limits for the part it writes (greeting, sign-off and footer
//     taken out), derived from the bands below, which are unchanged;
//   - a sentence about what the sender does that names the prospect's firm only as who it is for
//     ("We find the right buyers for <firm>") is a sender claim, judged by the scope check;
//   - a prospect claim may cite several facts ("R1, R2"), each of which must exist;
//   - the scope check reads the actions a sender claim describes, not its exact wording.
//
// THE LIMIT, stated so nobody over-trusts it: an undeclared claim made only of common words
// ("you just won a big one") is not caught. General hedged lines about firms like theirs are
// not claims about the prospect and are not checked.
//
// TRANSFORMS (code, never a check): dashes are replaced through scrubAITells, the project's
// one dash scrubber, and paragraphs are separated by exactly one blank line.

import { countWords } from '@/lib/composition/personalization'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import type { WriterFact } from './facts'
import { parseFactDate } from './facts'
import { playbookScopeText, type WriterPlaybook } from './playbook'

export interface WriterEmail { email: number; subject: string | null; body: string }

export interface WriterOutput {
  fact_used: { fact_id: string; quote: string }
  link_sentence: string
  angles: Array<{ email: number; angle: string }>
  emails: WriterEmail[]
  prospect_claims: Array<{ email: number; sentence: string; fact_id: string }>
  sender_claims: Array<{ email: number; sentence: string; playbook_line: string }>
  draft?: string
  self_check?: string
}

export interface Sender { firstName: string; company: string }

export interface ProspectNames {
  firstName: string
  lastName: string | null
  role: string | null
  companyName: string | null
  shortName: string | null
}

/** Section 0's bands (operator, 2026-10-03), raised because drafts kept landing just over. */
export const WRITER_V2_WORD_BANDS: Record<number, { min: number; max: number; label: string }> = {
  1: { min: 40, max: 110, label: '40 to 110' },
  2: { min: 30, max: 80, label: '30 to 80' },
  3: { min: 30, max: 80, label: '30 to 80' },
  4: { min: 1, max: 44, label: 'under 45' },
}

/**
 * THE WORD LIMITS FOR WHAT THE WRITER ACTUALLY WRITES. The bands above count the email as sent:
 * greeting line, body and the two-line sign-off. The writer writes the greeting but never the
 * sign-off, and was told the as-sent bands, so it had to subtract words it could not see. Every
 * one of the 121 word-count failures in the 2026-10-05 batch was over the limit, not under.
 * Derived from the bands, never a second set of numbers: the bands stay the hard limits.
 */
export function bodyWordLimits(firstName: string, sender: Sender): Record<number, { min: number; max: number }> {
  const overhead = countWords(`${firstName},`) + countWords(sender.firstName) + countWords(sender.company)
  return Object.fromEntries(Object.entries(WRITER_V2_WORD_BANDS).map(([n, b]) =>
    [Number(n), { min: Math.max(1, b.min - overhead), max: b.max - overhead }]))
}

/** The words of a body after its greeting line: what the writer itself wrote, sign-off excluded. */
function wordsAfterGreeting(body: string): number {
  const lines = body.trim().split('\n')
  const greeting = /^[^.?!\n]{1,40},$/.test(lines[0]?.trim() ?? '') ? countWords(lines[0]) : 0
  return countWords(body) - greeting
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

// The writer abbreviates the long month names (2026-10-05), so the date check reads either form.
// Every spelling maps to its month's index. CAPITALISED ONLY, because "may" and "march" are also
// ordinary words ("you may want"), and a month is always capitalised in English.
const MONTH_FORMS: Array<[RegExp, number]> = MONTHS.flatMap((m, i) => {
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1)
  const forms = [m, m.slice(0, 3), ...(m === 'september' ? ['sept'] : [])].map(cap)
  return [...new Set(forms)].map(f => [new RegExp(`\\b${f}\\b`), i] as [RegExp, number])
})

/** The month a sentence names, by index, in full or abbreviated form; null when none. */
export function monthNamedIn(sentence: string): number | null {
  for (const [form, i] of MONTH_FORMS) if (form.test(sentence)) return i
  return null
}

const isMonthWord = (word: string) => MONTH_FORMS.some(([form]) => new RegExp(`^${form.source}\\.?$`).test(word))

export const norm = (s: string) => s.toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

export function splitSentences(text: string): string[] {
  return text.split(/\n+/).flatMap(l => l.split(/(?<=[.?!])\s+(?=[A-Z"“])/)).map(s => s.trim()).filter(Boolean)
}

/** The body as sent before the footer: the writer's body, a blank line, the two sign-off lines. */
export function withSignOff(body: string, sender: Sender): string {
  return `${body.trim()}\n\n${sender.firstName}\n${sender.company}`
}

// ─── Transforms ───────────────────────────────────────────────────────────────

/** No dashes, and one blank line between paragraphs. Every line the writer wrote is a paragraph. */
export function transformBody(body: string): string {
  const scrubbed = scrubAITells(body, 'writer-v2')
  return scrubbed.split('\n').map(l => l.trim()).filter(Boolean).join('\n\n')
}

// Words that end in a full stop without ending a sentence: titles, company forms, common
// abbreviations. NOT the abbreviated months: the writer ends sentences on "Sept." and "Oct.", and
// a month mid-sentence is followed by a number, which never counts as a break here anyway. Matched case-insensitively against the word before
// the stop. Initials ("J.") and dotted acronyms ("U.S.") are handled by shape, below.
const NON_TERMINAL = new Set(['prof', 'dr', 'mr', 'mrs', 'ms', 'mx', 'st', 'sr', 'jr', 'mt', 'ft', 'inc', 'ltd', 'llc', 'llp', 'plc', 'co', 'corp', 'bros', 'dept', 'univ', 'assn', 'vs', 'etc', 'approx', 'no', 'e.g', 'i.e'])

/**
 * Where the first sentence of a paragraph ends, or -1 when it cannot be found safely. A stop
 * after a known abbreviation, a single capital letter (an initial) or a dotted acronym is not a
 * sentence end. Only a break followed by a capital letter or an opening quote counts.
 */
export function firstSentenceEnd(paragraph: string): number {
  const re = /([.?!])["”’)]?\s+(?=["“‘(]?[A-Z])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(paragraph)) !== null) {
    if (m[1] === '.') {
      const before = paragraph.slice(0, m.index)
      const word = before.split(/\s+/).pop() ?? ''
      if (NON_TERMINAL.has(word.toLowerCase().replace(/^[("“‘]/, ''))) continue
      if (/^[A-Z]$/.test(word)) continue // an initial
      if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word)) continue // U.S, U.K, e.g
    }
    return m.index + m[0].length
  }
  return -1
}

/**
 * EMAIL 1 OPENS ON ONE SHORT SENTENCE ABOUT THE FACT, and why it matters starts a new paragraph
 * (operator, 2026-10-05). A code transform, never a check: when Email 1's first paragraph after
 * the greeting holds more than one sentence, it is split after the first. Applied only when the
 * sequence opens on a fact (a research fact or the firm's own description), never on the
 * industry label, where the opening is a pain rather than a fact about them.
 */
export function splitOpeningParagraph(body: string): string {
  const paragraphs = body.split('\n\n')
  if (paragraphs.length < 2) return body
  const opening = paragraphs[1]
  const at = firstSentenceEnd(opening)
  if (at < 0) return body
  const first = opening.slice(0, at).trim()
  const rest = opening.slice(at).trim()
  if (!rest) return body
  return [paragraphs[0], first, rest, ...paragraphs.slice(2)].join('\n\n')
}

const opensOnAFact = (out: WriterOutput) => /^(R\d+|FIRM)$/.test(out.fact_used?.fact_id ?? '')

/** Applies the transforms to every email and to every sentence the writer declared, so the
 *  declarations still match the bodies they quote. */
export function transformOutput(out: WriterOutput): WriterOutput {
  const fix = (s: string) => scrubAITells(s, 'writer-v2').trim()
  const split = opensOnAFact(out)
  return {
    ...out,
    emails: out.emails.map(e => {
      const body = transformBody(e.body)
      return { ...e, subject: e.subject ? fix(e.subject) : e.subject, body: split && e.email === 1 ? splitOpeningParagraph(body) : body }
    }),
    prospect_claims: (out.prospect_claims ?? []).map(c => ({ ...c, sentence: fix(c.sentence) })),
    sender_claims: (out.sender_claims ?? []).map(c => ({ ...c, sentence: fix(c.sentence) })),
  }
}

// ─── Abbreviations ────────────────────────────────────────────────────────────

const JOINERS = new Set(['of', 'and', '&', 'the', 'for', 'in'])

/** Initials of every run of two or more words in the text, joiners skipped: "Human Resources" gives "hr". */
export function initialisms(text: string): Set<string> {
  const words = text.replace(/[^A-Za-z0-9&' -]/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    let acc = ''
    for (let j = i; j < Math.min(words.length, i + 8); j++) {
      const w = words[j]
      if (JOINERS.has(w.toLowerCase())) { if (j === i) break; continue }
      acc += w[0].toLowerCase()
      if (acc.length >= 2) out.add(acc)
    }
  }
  return out
}

/** The initials of a multi-word name, in capitals ("Northgate Field Services" gives "NFS"), or null. */
export function acronymOf(name: string | null): string | null {
  if (!name) return null
  const words = name.replace(/[^A-Za-z0-9& -]/g, ' ').split(/\s+/).filter(w => w && !JOINERS.has(w.toLowerCase()))
  return words.length >= 2 ? words.map(w => w[0].toUpperCase()).join('') : null
}

/** True when an all-capitals token stands for words in the corpus ("HR" against "human resources"). */
function isKnownAbbreviation(token: string, corpusInitials: Set<string>): boolean {
  return /^[A-Z][A-Z0-9&]{1,6}s?$/.test(token) && corpusInitials.has(token.replace(/s$/, '').replace(/&/g, '').toLowerCase())
}

// ─── The checks ───────────────────────────────────────────────────────────────

const EVENT_SHAPE = /^(saw|noticed|spotted|caught|read)\b|\byou(?:'ve| have| had)? (?:just |recently )\w+ed\b|\byou(?:'re| are) (?:heading|hiring|speaking|launching|expanding|growing)\b|\b(?:back in|earlier this|last) (?:january|february|march|april|may|june|july|august|september|october|november|december|month|week|year|spring|summer|autumn|fall|winter)\b/i

// Words that open a sentence or are ordinary capitalised words, never a name.
const COMMON = new Set(['i', 'we', 'you', 'your', 'it', 'if', 'the', 'a', 'an', 'and', 'but', 'so', 'with', 'that', 'this', 'no', 'not', 'what', 'when', 'is', 'are', 'has', 'have', 'would', 'worth', 'last', 'just', 'saw', 'quick', 'happy', 'either', 'fair', 'great', 'most', 'one', 'some', 'any', 'all', 'how', 'who', 'does', 'do', 'or', 'in', 'on', 'at', 'for', 'of', 'to', 'by', 'from', 'as', 'be', 'our', 'my', 'they', 'their', 'there', 'then', 'still', 'even', 'every', 'each', 'nothing', "there's", "that's", "it's", "we're", "you're", "we'll", "you'll", "i'm", "i'd", "isn't", "don't", "doesn't", "won't", "can't", 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'ok', 'okay'])

/** The fact ids a declaration cites: "R1", "R1, R2", "R3 and R1", "R2 / R5". */
export function citedFactIds(factId: string): string[] {
  return [...new Set((factId ?? '').split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i).map(s => s.trim()).filter(Boolean))]
}

// ─── Sender claims: what the sender says it does ──────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every way a sentence may name the firm: its names case-insensitively, its initials as written. */
function firmNamePatterns(p: ProspectNames): Array<{ source: string; flags: string }> {
  const names = [p.companyName, p.shortName].filter((n): n is string => !!n && n.length > 2).map(n => ({ source: escapeRe(n), flags: 'i' }))
  const acronyms = [p.shortName, p.companyName].map(acronymOf).filter((a): a is string => !!a).map(a => ({ source: escapeRe(a), flags: '' }))
  const seen = new Set<string>()
  return [...names, ...acronyms].filter(x => !seen.has(x.source + x.flags) && seen.add(x.source + x.flags))
}

/**
 * THE FIRM NAMED ONLY AS WHO THE SENDER'S WORK IS FOR. "We find the right buyers for Velocity"
 * says what the sender does; the firm is the beneficiary, and nothing is asserted about it.
 * Tonight's batch failed such lines as undeclared claims about the firm (operator, 2026-10-05).
 *
 * Returns the sentence with each beneficiary mention replaced by "you" ("for Velocity" gives
 * "for you", "who Velocity serves" gives "who you serve") when, after that, the sentence no
 * longer names the firm and is about the sender (we, us, our). Otherwise null: the firm is
 * named some other way ("so that cycle stops at Velocity", "Velocity's new practice"), and the
 * sentence stays a claim about the firm for the truth check. Two shapes only, on purpose.
 */
export function asSenderClaimForTheFirm(sentence: string, p: ProspectNames): string | null {
  const patterns = firmNamePatterns(p)
  if (patterns.length === 0) return null
  let out = sentence
  for (const { source, flags } of patterns) {
    out = out
      .replace(new RegExp(`\\bfor (?:the )?${source}(?![\\w'’])`, `g${flags}`), 'for you')
      .replace(new RegExp(`\\bwho ${source} (?:serves|serve|works with|work with)\\b`, `g${flags}`), 'who you serve')
  }
  if (out === sentence) return null
  if (patterns.some(({ source, flags }) => new RegExp(`\\b${source}(?!\\w)`, flags).test(out))) return null
  if (!/\b(?:we|we're|we'll|we've|us|our)\b/i.test(out)) return null
  return out
}

// Function words, pronouns and generic quantifiers. A sender claim is judged on what is left:
// the words that say what the sender does. "go" is here so "nothing goes out unseen" is read by
// its visibility words, never by the verb of motion.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'so', 'then', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'into', 'about', 'before', 'after', 'when', 'while', 'until', 'where', 'how', 'if', 'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'what', 'it', 'its', "it's", 'we', "we're", "we'll", "we've", "we'd", 'us', 'our', 'ours', 'you', "you're", "you'll", "you've", "you'd", 'your', 'yours', 'they', 'them', 'their', 'is', 'are', 'be', 'been', 'being', 'was', 'were', 'am', 'do', 'does', 'did', "don't", "doesn't", "didn't", 'have', 'has', 'had', "haven't", "hasn't", 'will', 'would', 'can', 'could', "can't", "won't", 'just', 'also', 'every', 'each', 'all', 'any', 'both', 'one', 'there', "there's", "that's", 'here', 'not', 'no', 'never', 'nothing', 'anything', 'everything', 'something', 'anyone', 'everyone', 'someone', 'only', 'than', 'too', 'very', 'go', 'goes', 'going', 'went', 'gone'])

// Irregular forms read as their base, so "seen" matches "see" and "found" matches "find".
const IRREGULAR: Record<string, string> = { seen: 'see', saw: 'see', found: 'find', wrote: 'write', written: 'write', sent: 'send', ran: 'run', took: 'take', taken: 'take', brought: 'bring', met: 'meet', made: 'make', got: 'get', kept: 'keep', people: 'person' }

/** A crude, consistent stem: the same rule reads the sentence and the playbook, so it only has to agree with itself. */
function stem(word: string): string {
  let w = IRREGULAR[word] ?? word
  w = w.replace(/ility$/, 'le').replace(/ies$/, 'y').replace(/(?<=\w{3})(?:ing|ed|es|s)$/, '')
  if (/([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1) // pinned -> pinn -> pin
  return w.replace(/e$/, '')
}

function contentStems(text: string): string[] {
  return norm(text).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).map(w => w.replace(/'s$/, '').replace(/^'+|'+$/g, '')).filter(w => w && !FUNCTION_WORDS.has(w)).map(stem)
}

/**
 * The words of a sender claim that name an action the playbook's offer does not. Empty means
 * every action it describes is in the offer: the offer itself, its short wordings and the proof
 * (finding buyers, writing to them, booking meetings, visibility, for the first client). Read
 * from the client's own playbook, never from a list here. The never-claim and call-to-action
 * patterns are a separate check on every sentence and are never relaxed by this one.
 */
export function wordsOutsideOffer(sentence: string, playbook: WriterPlaybook, sender: Sender): string[] {
  const allowed = new Set(contentStems([playbook.offer, ...(playbook.offer_wordings ?? []), playbook.proof, sender.company].join(' ')))
  const outside = norm(sentence).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).map(w => w.replace(/'s$/, '').replace(/^'+|'+$/g, ''))
    .filter(w => w && !FUNCTION_WORDS.has(w) && !allowed.has(stem(w)))
  return [...new Set(outside)]
}

export interface CheckInput {
  output: WriterOutput
  /** The facts the writer was OFFERED in this tier. A claim resting on any other fact fails. */
  offered: WriterFact[]
  prospect: ProspectNames
  sender: Sender
  playbook: WriterPlaybook
}

export function writerV2Failures({ output: out, offered, prospect: p, sender, playbook }: CheckInput): string[] {
  const failures: string[] = []
  const emails = [...(out.emails ?? [])].sort((a, b) => a.email - b.email)
  if (emails.length !== 4 || emails.some((e, i) => e.email !== i + 1 || typeof e.body !== 'string')) {
    return ['the output does not hold exactly four emails numbered 1 to 4']
  }
  if (!emails[0].subject || !emails[0].subject.trim()) failures.push('Email 1 has no subject line')
  if (emails.slice(1).some(e => e.subject)) failures.push('Emails 2 to 4 reply in the same thread and must have no subject')

  // 1. WORD COUNTS, as sent. The failure also states the count and limit for the part the
  // writer wrote, so a retry is told a number it can act on.
  const limits = bodyWordLimits(p.firstName, sender)
  for (const e of emails) {
    const words = countWords(withSignOff(e.body, sender))
    const band = WRITER_V2_WORD_BANDS[e.email]
    if (words < band.min || words > band.max) {
      const own = limits[e.email]
      failures.push(`Email ${e.email} is ${words} words with the sign-off; it must be ${band.label} (the part you write after the greeting is ${wordsAfterGreeting(e.body)} words; it must be ${own.min} to ${own.max})`)
    }
  }

  // 2. TRUTH, declared claims.
  const factById = new Map(offered.map(f => [f.id, f]))
  const bodyText = (n: number) => norm(emails[n - 1].body)
  const checkFact = (factId: string, where: string): WriterFact | null => {
    const f = factById.get(factId)
    if (!f) { failures.push(`${where} rests on "${factId}", which is not one of the facts given`); return null }
    if (f.ineligible) failures.push(`${where} rests on ${f.id}, which may not be used: ${f.ineligible}`)
    return f
  }
  // The chosen fact is the ONE fact the sequence opens on, and it decides the recorded tier, so
  // it stays a single id. Only a sentence may cite several.
  const used = out.fact_used ?? { fact_id: 'none', quote: '' }
  if (used.fact_id !== 'none') {
    if (citedFactIds(used.fact_id).length > 1) {
      failures.push(`The chosen fact names several facts ("${used.fact_id}"); name only the one fact the sequence opens on`)
    } else {
      const f = checkFact(used.fact_id, 'The chosen fact')
      if (f && used.quote && !norm(f.evidence).includes(norm(used.quote).replace(/^"|"$/g, ''))) {
        failures.push(`The quote given for ${f.id} is not in its evidence: "${used.quote}"`)
      }
    }
  }
  for (const c of out.prospect_claims ?? []) {
    const where = `Email ${c.email} sentence "${c.sentence}"`
    if (!(c.email >= 1 && c.email <= 4)) { failures.push(`A declared claim names Email ${c.email}, which does not exist`); continue }
    if (!bodyText(c.email).includes(norm(c.sentence))) failures.push(`${where} is declared as a claim but is not in Email ${c.email}`)
    // A sentence may rest on several facts ("R1, R2"); every one must exist. A month or year
    // in the sentence is right when it matches ANY of them, since each may supply part of it.
    const ids = citedFactIds(c.fact_id)
    if (ids.length === 0) { failures.push(`${where} is declared as a claim but names no fact`); continue }
    const cited = ids.map(id => checkFact(id, where)).filter((f): f is WriterFact => !!f)
    if (cited.length < ids.length) continue
    const dated = cited.filter(f => f.kind === 'research').map(f => ({ f, d: parseFactDate(f.date) })).filter((x): x is { f: WriterFact; d: Date } => !!x.d)
    if (dated.length > 0) {
      const named = dated.map(x => `${x.f.id} is dated ${x.f.date}`).join(', ')
      const monthIndex = monthNamedIn(c.sentence)
      if (monthIndex !== null && !dated.some(({ f, d }) => monthIndex === d.getUTCMonth() || monthIndex === monthNamedIn(f.evidence))) {
        failures.push(`${where} says ${MONTHS[monthIndex]}, but ${named}`)
      }
      const year = c.sentence.toLowerCase().match(/\b(19|20)\d\d\b/)?.[0]
      if (year && !dated.some(({ f, d }) => Number(year) === d.getUTCFullYear() || f.evidence.includes(year))) {
        failures.push(`${where} says ${year}, but ${named}`)
      }
    }
  }

  // 2. TRUTH, undeclared claims code can see.
  const declared = (out.prospect_claims ?? []).map(c => ({ email: c.email, s: norm(c.sentence) }))
  const firmNames = [p.companyName, p.shortName].filter((n): n is string => !!n && n.length > 2).map(norm)
  // The firm's initials ("MSP"), so a statement using them is caught like one using its name.
  const firmAcronyms = [p.shortName, p.companyName].map(acronymOf).filter((a): a is string => !!a)
  emails.forEach(e => {
    for (const s of splitSentences(e.body)) {
      if (/^[A-Z][\w'’-]*,$/.test(s)) continue // the greeting line
      const ns = norm(s)
      if (declared.some(d => d.email === e.email && (d.s.includes(ns) || ns.includes(d.s)))) continue
      // Naming the firm is not by itself a claim: a hedged line or a question asserts nothing.
      const hedged = /\bif\b|\bwhether\b|\?\s*$|\b(?:firms|teams|people|founders|consultants|companies) like\b/i.test(s)
      let namesFirm = !hedged && (firmNames.some(n => ns.includes(n)) || firmAcronyms.some(a => new RegExp(`\\b${a}\\b`).test(s)))
      if (namesFirm) {
        // What the sender does, with the firm named only as who it is for: a sender claim, judged
        // by the scope check (the offer's actions, never a cited line, so a citation cannot carry
        // an extra clause about the firm past it).
        const asSender = asSenderClaimForTheFirm(s, p)
        if (asSender !== null) {
          namesFirm = false
          const outside = wordsOutsideOffer(asSender, playbook, sender)
          if (outside.length > 0) failures.push(`Email ${e.email} sentence "${s}" says what we do in words the playbook's offer does not use (${outside.join(', ')}); describe only what the offer and proof say we do`)
        }
      }
      if (namesFirm || EVENT_SHAPE.test(s)) failures.push(`Email ${e.email} sentence "${s}" says something about the prospect or their firm and rests on no declared fact`)
    }
  })

  // Specifics with no source: a proper noun or number found in no input. Abbreviations match
  // their full form in either direction.
  const corpusRaw = [playbookScopeText(playbook), p.firstName, p.lastName ?? '', p.role ?? '', p.companyName ?? '', p.shortName ?? '', sender.firstName, sender.company,
    ...offered.filter(f => !f.ineligible).flatMap(f => [f.evidence, f.provenance, f.date ?? ''])].join(' \n ')
  const corpus = norm(corpusRaw)
  const corpusInitials = initialisms(corpusRaw)
  const corpusAbbreviations = new Set((corpusRaw.match(/\b[A-Z][A-Z0-9&]{1,6}\b/g) ?? []).map(a => a.replace(/&/g, '').toLowerCase()))
  emails.forEach(e => {
    for (const s of splitSentences(e.body)) {
      const tokens = s.replace(/[.,!?;:()"“”]/g, ' ').split(/\s+/).filter(Boolean)
      // A run of capitalised words whose initials are an abbreviation in the inputs is sourced.
      const sourcedByAbbreviation = new Set<number>()
      for (let i = 1; i < tokens.length; i++) {
        let acc = ''
        for (let j = i; j < tokens.length && /^[A-Z]/.test(tokens[j]); j++) {
          acc += tokens[j][0].toLowerCase()
          if (acc.length >= 2 && corpusAbbreviations.has(acc)) for (let k = i; k <= j; k++) sourcedByAbbreviation.add(k)
        }
      }
      tokens.forEach((t, i) => {
        const bare = t.replace(/['’]s$/, '')
        if (isMonthWord(bare)) return
        const isNumber = /\d/.test(bare)
        const isProper = i > 0 && /^[A-Z]/.test(bare) && !COMMON.has(bare.toLowerCase()) && !/^I(['’]|$)/.test(bare)
        if (!(isNumber || isProper)) return
        if (corpus.includes(norm(bare))) return
        if (sourcedByAbbreviation.has(i) || isKnownAbbreviation(bare, corpusInitials)) return
        failures.push(`Email ${e.email} names "${bare}", which appears in no fact, prospect field or playbook line`)
      })
    }
  })

  // 3. SENDER SCOPE. A sender claim is in scope when the line it cites is in the playbook, OR
  // when every action it describes is one the offer names, in any wording. The second is what
  // most failures in the 2026-10-05 batch needed: the writer cited two real wordings joined by
  // " / ", or reworded one, and the sentence itself was within the offer.
  const scopeNorm = norm(playbookScopeText(playbook))
  for (const c of out.sender_claims ?? []) {
    if (!c.playbook_line || scopeNorm.includes(norm(c.playbook_line).replace(/^"|"$/g, ''))) continue
    const outside = wordsOutsideOffer(asSenderClaimForTheFirm(c.sentence ?? '', p) ?? c.sentence ?? '', playbook, sender)
    if (outside.length > 0) {
      failures.push(`Email ${c.email} sentence "${c.sentence}" cites a playbook line that is not in the playbook: "${c.playbook_line}", and says what we do in words the offer does not use (${outside.join(', ')})`)
    }
  }
  const rules = [...playbook.never_claim, ...playbook.calls_to_action.never]
  for (const e of emails) {
    for (const s of [...splitSentences(e.body), ...(e.subject ? [e.subject] : [])]) {
      for (const g of rules) {
        if (g.patterns.some(pat => new RegExp(pat, 'i').test(s))) failures.push(`Email ${e.email} sentence "${s}" breaks the playbook rule: ${g.rule}`)
      }
    }
  }
  return [...new Set(failures)]
}

/** Report only: sentences sharing a run of five or more words with an approved example. */
export function copiedPhrases(out: WriterOutput, examples: string[]): string[] {
  const grams = (s: string, n: number) => {
    const w = norm(s).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean)
    const g: string[] = []
    for (let i = 0; i + n <= w.length; i++) g.push(w.slice(i, i + n).join(' '))
    return g
  }
  const exampleGrams = new Set(examples.flatMap(s => grams(s, 5)))
  const hits: string[] = []
  for (const e of out.emails) {
    for (const s of splitSentences(e.body)) {
      const shared = grams(s, 5).filter(g => exampleGrams.has(g))
      if (shared.length > 0) hits.push(`Email ${e.email}: "${s}" (shares "${shared[0]}")`)
    }
  }
  return hits
}
