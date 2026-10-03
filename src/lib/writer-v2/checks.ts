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
//   3. SENDER SCOPE: a sender claim cites a line that is in the playbook, and no sentence
//      matches the playbook's never-claim or call-to-action patterns.
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

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

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

/** Applies the transforms to every email and to every sentence the writer declared, so the
 *  declarations still match the bodies they quote. */
export function transformOutput(out: WriterOutput): WriterOutput {
  const fix = (s: string) => scrubAITells(s, 'writer-v2').trim()
  return {
    ...out,
    emails: out.emails.map(e => ({ ...e, subject: e.subject ? fix(e.subject) : e.subject, body: transformBody(e.body) })),
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

/** The initials of a multi-word name, in capitals ("Moving Sales Professionals" gives "MSP"), or null. */
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

  // 1. WORD COUNTS, as sent.
  for (const e of emails) {
    const words = countWords(withSignOff(e.body, sender))
    const band = WRITER_V2_WORD_BANDS[e.email]
    if (words < band.min || words > band.max) failures.push(`Email ${e.email} is ${words} words with the sign-off; it must be ${band.label}`)
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
  const used = out.fact_used ?? { fact_id: 'none', quote: '' }
  if (used.fact_id !== 'none') {
    const f = checkFact(used.fact_id, 'The chosen fact')
    if (f && used.quote && !norm(f.evidence).includes(norm(used.quote).replace(/^"|"$/g, ''))) {
      failures.push(`The quote given for ${f.id} is not in its evidence: "${used.quote}"`)
    }
  }
  for (const c of out.prospect_claims ?? []) {
    const where = `Email ${c.email} sentence "${c.sentence}"`
    if (!(c.email >= 1 && c.email <= 4)) { failures.push(`A declared claim names Email ${c.email}, which does not exist`); continue }
    if (!bodyText(c.email).includes(norm(c.sentence))) failures.push(`${where} is declared as a claim but is not in Email ${c.email}`)
    const f = checkFact(c.fact_id, where)
    if (f && f.kind === 'research') {
      const d = parseFactDate(f.date)
      const s = c.sentence.toLowerCase()
      const monthNamed = MONTHS.find(m => new RegExp(`\\b${m}\\b`).test(s))
      if (d && monthNamed && MONTHS[d.getUTCMonth()] !== monthNamed && !norm(f.evidence).includes(monthNamed)) {
        failures.push(`${where} says ${monthNamed}, but ${f.id} is dated ${f.date}`)
      }
      const year = s.match(/\b(19|20)\d\d\b/)?.[0]
      if (d && year && Number(year) !== d.getUTCFullYear() && !f.evidence.includes(year)) {
        failures.push(`${where} says ${year}, but ${f.id} is dated ${f.date}`)
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
      const namesFirm = !hedged && (firmNames.some(n => ns.includes(n)) || firmAcronyms.some(a => new RegExp(`\\b${a}\\b`).test(s)))
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
        if (MONTHS.includes(bare.toLowerCase())) return
        const isNumber = /\d/.test(bare)
        const isProper = i > 0 && /^[A-Z]/.test(bare) && !COMMON.has(bare.toLowerCase()) && !/^I(['’]|$)/.test(bare)
        if (!(isNumber || isProper)) return
        if (corpus.includes(norm(bare))) return
        if (sourcedByAbbreviation.has(i) || isKnownAbbreviation(bare, corpusInitials)) return
        failures.push(`Email ${e.email} names "${bare}", which appears in no fact, prospect field or playbook line`)
      })
    }
  })

  // 3. SENDER SCOPE.
  const scopeNorm = norm(playbookScopeText(playbook))
  for (const c of out.sender_claims ?? []) {
    if (c.playbook_line && !scopeNorm.includes(norm(c.playbook_line).replace(/^"|"$/g, ''))) {
      failures.push(`Email ${c.email} sentence "${c.sentence}" cites a playbook line that is not in the playbook: "${c.playbook_line}"`)
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
