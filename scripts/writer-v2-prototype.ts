// WRITER V2 PROTOTYPE. A standalone, read-only trial of the writer specified on the Notion
// page "Writer v2: playbook format, MargenticOS playbook v1, writer instructions (prototype
// spec)", section 1. It is NOT the pipeline: nothing here is imported by src/, and nothing
// is written to any prospect, document or table.
//
//   npx tsx scripts/writer-v2-prototype.ts --org <id> --playbook <file.md> --scope <file.json> \
//     --out-dir .writer-export/writer-v2 [--n 10] [--exclude-companies a,b,c] [--cap 5] [--seed N]
//
// WHAT IT DOES, per prospect:
//   1. Reads the stored inputs: first name, company, short name (companyShortName, the same
//      function composition uses), role; the stored research candidates with source, date
//      and evidence; the stored firm fact. No new fetches.
//   2. One model call writes the whole four-email sequence, once per writer model.
//   3. Runs the only guards section 1 allows: word counts, and truth. On a failure, ONE
//      retry with the failures stated; a second failure is reported and the sequence kept.
//   4. Reports, never blocks, any sentence closely copying an approved example.
//
// RULE ZERO. The prompt below is generic. The client's playbook (market story, angles,
// offer, proof, never-claim list, voice, approved examples) is DATA loaded from --playbook,
// and the never-claim patterns are DATA loaded from --scope. Neither is written here.
//
// WHAT "QUOTED EVIDENCE" MEANS FOR A RESEARCH FACT. Stored research candidates carry an
// observation sentence, a source, a provenance line and a date, but no verbatim quote from
// the page. So the observation is the evidence the writer quotes, and the truth guard checks
// the writer's quote against it. The firm fact does carry a verbatim quote from the site.
//
// THE TRUTH GUARD, AND ITS LIMIT. The writer declares every sentence that says something
// about the prospect or their firm, with the fact it rests on. Code then checks: the fact
// exists; a research fact is dated within 12 months of today and does not read as a
// founding date, tagline or ended role; the quote is in the fact's evidence; a month or year
// in the sentence matches the fact's date. Code also catches UNDECLARED claims it can see:
// a sentence naming the firm, or one in the "saw you..." / "you recently..." shape, and any
// proper noun or number that appears in no input. An undeclared claim made only of common
// words ("you just won a big one") is not caught. General hedged lines ("a lot of
// consultants tell us...") are not prospect claims and are not checked.
//
// THE OUTPUT NAMES REAL PEOPLE AND FIRMS. --out-dir must be under .writer-export/
// (gitignored). This file holds no names.

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { companyShortName, firmTradeWords } from '../src/lib/composition/company-short-name'
import { clientGenericWords, type OutboundBrief } from '../src/lib/outbound-brief/brief'
import { peerKindRecordFromRow } from '../src/lib/sourcing/peer-kind'
import { countWords } from '../src/lib/composition/personalization'
import { OPT_OUT_FOOTER } from '../src/lib/composition/opt-out-footer'
import type { ObservationCandidate } from '../src/lib/agents/research/types'
import type { FirmFactRecord } from '../src/lib/agents/research/firm-fact'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// ─── Models and prices ────────────────────────────────────────────────────────
// The production research writer (write-opening.ts WRITER_MODEL) and the strongest model
// available. Prices per million tokens, first-party API, read 2026-10-03.
interface WriterModel { id: string; label: string; inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number; firstCallGuess: number }
const MODELS: WriterModel[] = [
  { id: 'claude-sonnet-4-6', label: 'production writer (Sonnet 4.6)', inPerM: 3, outPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, firstCallGuess: 0.12 },
  { id: 'claude-fable-5-1', label: 'strongest available (Fable 5.1, effort medium)', inPerM: 10, outPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5, firstCallGuess: 0.6 },
]

function costOf(model: WriterModel, usage: Anthropic.Usage): number {
  return (usage.input_tokens * model.inPerM
    + usage.output_tokens * model.outPerM
    + (usage.cache_read_input_tokens ?? 0) * model.cacheReadPerM
    + (usage.cache_creation_input_tokens ?? 0) * model.cacheWritePerM) / 1_000_000
}

// ─── Dates ────────────────────────────────────────────────────────────────────
const TODAY = new Date()
const WINDOW_START = new Date(TODAY.getTime() - 365 * 24 * 3600 * 1000)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** A stored date as a Date, or null. Accepts YYYY, YYYY-MM and YYYY-MM-DD. */
function parseFactDate(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1))
}

// A founding date, a tagline or an ended role is never a fact to open on (spec, section 1).
const NOT_AN_EVENT = /\b(founded|co-?founded|established in|since (19|20)\d\d|tagline|slogan|motto|formerly|former|previously|stepped down|left (his|her|their|the) role|departed|ex-)\b/i

interface Fact {
  id: string
  kind: 'research' | 'firm' | 'record'
  source: string
  date: string | null
  evidence: string
  provenance: string
  shared: boolean
  /** Why a research fact may not be used, or null when it may. */
  ineligible: string | null
}

function researchFact(c: ObservationCandidate, i: number): Fact {
  const d = parseFactDate(c.date)
  let ineligible: string | null = null
  if (!d) ineligible = 'undated'
  else if (d < WINDOW_START) ineligible = `dated ${c.date}, older than 12 months`
  else if (d > TODAY) ineligible = `dated ${c.date}, in the future`
  else if (NOT_AN_EVENT.test(c.observation)) ineligible = 'reads as a founding date, tagline or ended role'
  return {
    id: `R${i + 1}`,
    kind: 'research',
    source: c.source,
    date: c.date ?? null,
    evidence: c.observation,
    provenance: c.provenance || 'no provenance',
    shared: c.is_reshare === true,
    ineligible,
  }
}

// ─── Playbook ─────────────────────────────────────────────────────────────────
interface ScopeGuards { never_claim: Array<{ rule: string; patterns: string[] }>; cta: Array<{ rule: string; patterns: string[] }> }

function loadPlaybook(file: string): { full: string; exampleSentences: string[] } {
  const full = fs.readFileSync(file, 'utf-8')
  const at = full.search(/^## Approved examples/m)
  if (at < 0) throw new Error('playbook has no "## Approved examples" section')
  const examples = full.slice(at).split('\n').filter(l => l.trim() && !l.startsWith('#') && !/^Tone only/.test(l))
  // A greeting line ("Name,") is not a sentence anyone could copy.
  const exampleSentences = examples.flatMap(splitSentences).filter(s => countWords(s) >= 4)
  return { full, exampleSentences }
}

// ─── The prompt (generic) ─────────────────────────────────────────────────────
const SYSTEM = `You write cold email sequences for a B2B client, to one prospect at a time. The client's playbook is below. Everything about the client (who they sell to, the angles, the offer, the proof, what they must never claim, the voice, and example emails) comes from the playbook. Nothing else about the client may be assumed.

TASK: write a four-email sequence to the prospect as ONE conversation, in one pass.

1. CHOOSE THE MOST MEANINGFUL FACT FOR THIS CLIENT. Ask: given this fact, would this prospect value the client's outcome now? Write the link in one sentence a sceptical reader would accept. A fact must be a dated event within the last 12 months: never a founding date, tagline or ended role. A content hook must cite what the content says, never only that it exists. A fact marked SHARED is somebody else's post the prospect amplified: say they shared it. If no research fact qualifies, open with what the firm does (the FIRM or RECORD fact); if that is missing too, use no opener.
2. PICK ANGLES FROM THE PLAYBOOK. Email 1's angle matches the fact and its link. Emails 2 and 3 usually take different angles. When there is a strong personal fact, Email 2 or 3 carries that thread (for example, a callback to the event).
3. WRITE IN THE CLIENT'S VOICE, using the playbook's approved examples for tone only. Never copy their sentences, names or specifics.
4. SHAPE (guidance, not a template). Email 1: the observation (if personal), why it matters (hedged, never asserting about the reader), the offer (outcome-led, within the playbook's scope), one question tied to the hook. Emails 2 and 3: the angle, its consequence, the offer or proof, one question. Email 4: a short, warm close naming the main theme.
5. SELF-CHECK the draft against six tests, then revise once: human-sounding; paints a clear picture; easy to read; coherent; ties together across the emails; gives a reason to reply.

LENGTHS (counted in words, including the greeting line and a two-line sign-off that is added after your body): Email 1 40 to 90 words; Emails 2 and 3 30 to 70; Email 4 under 40. So keep your Email 1 body to about 85 words at most, Emails 2 and 3 to about 65, Email 4 to about 35.

FORMAT OF EACH BODY: the prospect's first name and a comma on the first line, then short paragraphs separated by a blank line. Do NOT write a sign-off or a footer; they are added for you. Only Email 1 has a subject line (short, lower case is fine); Emails 2 to 4 reply in the same thread and have none.

TRUTH. Every sentence that says something about the prospect or their firm (what they did, said, posted, hired, won, run, are heading to) must rest on one of the facts given, by its id, and quote the evidence it rests on. Dates must be right. Anything the sender says it does must sit within the playbook's offer and proof, and never touch its never-claim list. A general hedged line about firms like theirs ("a lot of consultants tell us...") is not a claim about the prospect.

Return ONLY one JSON object, no prose before or after, with exactly these keys:
{
  "draft": "the first draft of all four emails as plain text",
  "self_check": "one line per test: what the draft got wrong, and what you changed",
  "fact_used": { "fact_id": "R1, FIRM, RECORD or none", "quote": "the words of that fact's evidence you rest on, copied exactly" },
  "link_sentence": "one sentence: why this fact makes the client's outcome valuable to this prospect now",
  "angles": [ { "email": 1, "angle": "angle name from the playbook" }, { "email": 2, "angle": "..." }, { "email": 3, "angle": "..." }, { "email": 4, "angle": "..." } ],
  "emails": [ { "email": 1, "subject": "...", "body": "..." }, { "email": 2, "subject": null, "body": "..." }, { "email": 3, "subject": null, "body": "..." }, { "email": 4, "subject": null, "body": "..." } ],
  "prospect_claims": [ { "email": 1, "sentence": "the sentence exactly as written in the body", "fact_id": "R1" } ],
  "sender_claims": [ { "email": 1, "sentence": "the sentence exactly as written", "playbook_line": "the words of the playbook's Offer or Proof it sits within, copied exactly" } ]
}`

function userMessage(p: ProspectInput): string {
  const facts = p.facts.filter(f => !f.ineligible)
  const factLines = facts.length === 0
    ? 'None.'
    : facts.map(f => `${f.id} [${f.kind === 'research' ? 'research' : f.kind === 'firm' ? 'what the firm does, from its website' : 'what the firm does, from its stored record'}]${f.shared ? ' [SHARED, NOT THEIRS]' : ''}\n   date: ${f.date ?? 'standing description'}\n   source: ${f.source} | ${f.provenance}\n   evidence: "${f.evidence}"`).join('\n')
  const dropped = p.facts.filter(f => f.ineligible).length
  return `Today is ${iso(TODAY)}. The 12-month window starts ${iso(WINDOW_START)}.

PROSPECT
First name: ${p.firstName}
Role: ${p.role ?? 'not recorded'}
Company (full name): ${p.companyName ?? 'not recorded'}
Company as a sentence says it: ${p.shortName ?? 'do not name the firm; say "your firm" or similar'}

FACTS YOU MAY USE (${dropped} other stored research findings were left out: undated, older than 12 months, or a founding date, tagline or ended role)
${factLines}`
}

// ─── Guards ───────────────────────────────────────────────────────────────────
interface WriterOutput {
  draft?: string
  self_check?: string
  fact_used: { fact_id: string; quote: string }
  link_sentence: string
  angles: Array<{ email: number; angle: string }>
  emails: Array<{ email: number; subject: string | null; body: string }>
  prospect_claims: Array<{ email: number; sentence: string; fact_id: string }>
  sender_claims: Array<{ email: number; sentence: string; playbook_line: string }>
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

function splitSentences(text: string): string[] {
  return text.split(/\n+/).flatMap(l => l.split(/(?<=[.?!])\s+(?=[A-Z"“])/)).map(s => s.trim()).filter(Boolean)
}

function signOff(body: string, sender: Sender): string {
  return `${body.trim()}\n\n${sender.firstName}\n${sender.company}`
}

const WORD_BANDS: Record<number, { min: number; max: number; label: string }> = {
  1: { min: 40, max: 90, label: '40 to 90' },
  2: { min: 30, max: 70, label: '30 to 70' },
  3: { min: 30, max: 70, label: '30 to 70' },
  4: { min: 1, max: 39, label: 'under 40' },
}

function guardFailures(out: WriterOutput, p: ProspectInput, sender: Sender, playbook: string, scope: ScopeGuards): string[] {
  const failures: string[] = []
  const emails = [...out.emails].sort((a, b) => a.email - b.email)
  if (emails.length !== 4 || emails.some((e, i) => e.email !== i + 1)) return ['the output does not hold exactly four emails numbered 1 to 4']

  // WORD COUNTS, including the greeting and the two-line sign-off, as sent.
  for (const e of emails) {
    const words = countWords(signOff(e.body, sender))
    const band = WORD_BANDS[e.email]
    if (words < band.min || words > band.max) failures.push(`Email ${e.email} is ${words} words with the sign-off; it must be ${band.label}`)
  }

  const factById = new Map(p.facts.map(f => [f.id, f]))
  const bodyText = (n: number) => norm(emails[n - 1].body)

  // TRUTH, part 1: every declared claim about the prospect or their firm.
  const checkFact = (factId: string, where: string): Fact | null => {
    const f = factById.get(factId)
    if (!f) { failures.push(`${where} rests on "${factId}", which is not one of the facts given`); return null }
    if (f.ineligible) failures.push(`${where} rests on ${f.id}, which may not be used: ${f.ineligible}`)
    return f
  }
  if (out.fact_used.fact_id !== 'none') {
    const f = checkFact(out.fact_used.fact_id, 'The chosen fact')
    if (f && out.fact_used.quote && !norm(f.evidence).includes(norm(out.fact_used.quote).replace(/^"|"$/g, ''))) {
      failures.push(`The quote given for ${f.id} is not in its evidence: "${out.fact_used.quote}"`)
    }
  }
  for (const c of out.prospect_claims) {
    const where = `Email ${c.email} sentence "${c.sentence}"`
    if (!(c.email >= 1 && c.email <= 4)) { failures.push(`A declared claim names Email ${c.email}, which does not exist`); continue }
    if (!bodyText(c.email).includes(norm(c.sentence))) failures.push(`${where} is declared as a claim but is not in Email ${c.email}`)
    const f = checkFact(c.fact_id, where)
    if (f && f.kind === 'research') {
      // Dates must be right: a month or year named in the sentence matches the fact's date.
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

  // TRUTH, part 2: claims the writer did not declare, where code can see them.
  const declared = new Set(out.prospect_claims.map(c => `${c.email}|${norm(c.sentence)}`))
  const names = [p.companyName, p.shortName].filter((n): n is string => !!n && n.length > 2).map(n => norm(n))
  const EVENT_SHAPE = /^(saw|noticed|spotted|caught|read)\b|\byou(?:'ve| have| had)? (?:just |recently )\w+ed\b|\byou(?:'re| are) (?:heading|hiring|speaking|launching|expanding|growing)\b|\b(?:back in|earlier this|last) (?:january|february|march|april|may|june|july|august|september|october|november|december|month|week|year|spring|summer|autumn|fall|winter)\b/i
  emails.forEach(e => {
    for (const s of splitSentences(e.body)) {
      if (/^[A-Z][\w'’-]*,$/.test(s)) continue // the greeting line
      const isDeclared = [...declared].some(k => k.startsWith(`${e.email}|`) && (k.slice(2).includes(norm(s)) || norm(s).includes(k.slice(2))))
      if (isDeclared) continue
      const namesFirm = names.some(n => norm(s).includes(n))
      if (namesFirm || EVENT_SHAPE.test(s)) failures.push(`Email ${e.email} sentence "${s}" says something about the prospect or their firm and rests on no declared fact`)
    }
  })
  // Specifics with no source: a proper noun or a number that appears in no input.
  // The playbook WITHOUT its approved examples: a name lifted from an example is copied, not sourced.
  const playbookNoExamples = playbook.slice(0, Math.max(0, playbook.search(/^## Approved examples/m)))
  const corpus = norm([playbookNoExamples, p.firstName, p.lastName ?? '', p.role ?? '', p.companyName ?? '', p.shortName ?? '', sender.firstName, sender.company,
    ...p.facts.filter(f => !f.ineligible).flatMap(f => [f.evidence, f.provenance, f.date ?? ''])].join(' '))
  const COMMON = new Set(['i', 'we', 'you', 'your', 'it', 'if', 'the', 'a', 'an', 'and', 'but', 'so', 'with', 'that', 'this', 'no', 'not', 'what', 'when', 'is', 'are', 'has', 'have', 'would', 'worth', 'last', 'just', 'saw', 'quick', 'happy', 'either', 'fair', 'great', 'most', 'one', 'some', 'any', 'all', 'how', 'who', 'does', 'do', 'or', 'in', 'on', 'at', 'for', 'of', 'to', 'by', 'from', 'as', 'be', 'our', 'my', 'they', 'their', 'there', 'then', 'still', 'even', 'every', 'each', 'nothing', 'there\'s', 'that\'s', 'it\'s', 'we\'re', 'you\'re', 'we\'ll', 'you\'ll', 'i\'m', 'i\'d', 'isn\'t', 'don\'t', 'doesn\'t', 'won\'t', 'can\'t'])
  emails.forEach(e => {
    for (const s of splitSentences(e.body)) {
      const tokens = s.replace(/[.,!?;:()"“”]/g, ' ').split(/\s+/).filter(Boolean)
      tokens.forEach((t, i) => {
        const bare = t.replace(/['’]s$/, '')
        const isNumber = /\d/.test(bare)
        const isProper = i > 0 && /^[A-Z]/.test(bare) && !COMMON.has(bare.toLowerCase()) && !/^I(['’]|$)/.test(bare)
        // Month names are checked against the fact's date above, so they are not checked here.
        if (MONTHS.includes(bare.toLowerCase())) return
        if ((isNumber || isProper) && !corpus.includes(norm(bare))) failures.push(`Email ${e.email} names "${bare}", which appears in no fact, prospect field or playbook line`)
      })
    }
  })

  // SENDER CLAIMS: within the playbook's scope, never on its never-claim list.
  const playbookNorm = norm(playbook)
  for (const c of out.sender_claims) {
    if (c.playbook_line && !playbookNorm.includes(norm(c.playbook_line).replace(/^"|"$/g, ''))) {
      failures.push(`Email ${c.email} sentence "${c.sentence}" cites a playbook line that is not in the playbook: "${c.playbook_line}"`)
    }
  }
  for (const e of emails) {
    for (const s of splitSentences(e.body)) {
      for (const g of [...scope.never_claim, ...scope.cta]) {
        if (g.patterns.some(pat => new RegExp(pat, 'i').test(s))) failures.push(`Email ${e.email} sentence "${s}" breaks the playbook rule: ${g.rule}`)
      }
    }
  }
  return [...new Set(failures)]
}

/** Report only: a sentence sharing a run of five or more words with an approved example. */
function copiedPhrases(out: WriterOutput, exampleSentences: string[]): string[] {
  const grams = (s: string, n: number) => {
    const w = norm(s).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean)
    const g: string[] = []
    for (let i = 0; i + n <= w.length; i++) g.push(w.slice(i, i + n).join(' '))
    return g
  }
  const exampleGrams = new Set(exampleSentences.flatMap(s => grams(s, 5)))
  const hits: string[] = []
  for (const e of out.emails) {
    for (const s of splitSentences(e.body)) {
      const shared = grams(s, 5).filter(g => exampleGrams.has(g))
      if (shared.length > 0) hits.push(`Email ${e.email}: "${s}" (shares "${shared[0]}")`)
    }
  }
  return hits
}

// ─── One prospect, one model ──────────────────────────────────────────────────
interface Sender { firstName: string; company: string }
interface ProspectInput {
  id: string
  firstName: string
  lastName: string | null
  role: string | null
  companyName: string | null
  shortName: string | null
  facts: Fact[]
}
interface Attempt { output: WriterOutput | null; raw: string; failures: string[]; cost: number; usage: Anthropic.Usage }
interface ModelResult { model: string; attempts: Attempt[]; final: WriterOutput | null; finalFailures: string[]; copied: string[]; cost: number }

function parseOutput(text: string): WriterOutput | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) as WriterOutput } catch { return null }
}

async function callModel(client: Anthropic, model: WriterModel, system: string, messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> {
  // Sonnet 4.6 runs as the production writer does: no thinking, default temperature.
  // Fable 5.1 always thinks; effort is its only control, set to medium to hold the cap.
  const params: Anthropic.MessageCreateParamsNonStreaming = model.id.startsWith('claude-fable')
    ? { model: model.id, max_tokens: 16000, system, messages, output_config: { effort: 'medium' } } as Anthropic.MessageCreateParamsNonStreaming
    : { model: model.id, max_tokens: 8000, system, messages }
  return client.messages.create(params)
}

async function runOne(client: Anthropic, model: WriterModel, p: ProspectInput, sender: Sender, playbook: { full: string; exampleSentences: string[] }, scope: ScopeGuards, budget: Budget): Promise<ModelResult> {
  const system = `${SYSTEM}\n\n=== CLIENT PLAYBOOK ===\n${playbook.full}`
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage(p) }]
  const attempts: Attempt[] = []
  for (let i = 0; i < 2; i++) {
    budget.reserve(model)
    const res = await callModel(client, model, system, messages)
    const cost = costOf(model, res.usage)
    budget.spend(model, cost)
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      attempts.push({ output: null, raw: '', failures: [`the model stopped: ${res.stop_reason}`], cost, usage: res.usage })
      break
    }
    const raw = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
    const output = parseOutput(raw)
    const failures = output ? guardFailures(output, p, sender, playbook.full, scope) : ['the output was not a JSON object in the shape asked for']
    attempts.push({ output, raw, failures, cost, usage: res.usage })
    if (failures.length === 0 || i === 1) break
    // ONE RETRY, with the failures stated. The whole first response goes back unchanged.
    messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] })
    messages.push({ role: 'user', content: `Your sequence failed these checks:\n- ${failures.join('\n- ')}\n\nRewrite the whole sequence so every check passes, keeping what was good. Return the same JSON shape.` })
  }
  const last = attempts[attempts.length - 1]
  const final = [...attempts].reverse().find(a => a.output)?.output ?? null
  return {
    model: model.id,
    attempts,
    final,
    finalFailures: last.failures,
    copied: final ? copiedPhrases(final, playbook.exampleSentences) : [],
    cost: attempts.reduce((s, a) => s + a.cost, 0),
  }
}

// ─── The cap ──────────────────────────────────────────────────────────────────
// Refuses a call when what has been spent plus the dearest call seen so far for that model
// (or a first guess) would pass the cap. So the cap holds before the bill, not after it.
class Budget {
  spent = 0
  private dearest = new Map<string, number>()
  constructor(readonly cap: number) {}
  reserve(model: WriterModel) {
    const projected = this.dearest.get(model.id) ?? model.firstCallGuess
    if (this.spent + projected * 1.25 > this.cap) throw new BudgetStop(`cap $${this.cap} would be passed: spent $${this.spent.toFixed(3)}, next ${model.id} call projected $${projected.toFixed(3)}`)
  }
  spend(model: WriterModel, cost: number) {
    this.spent += cost
    this.dearest.set(model.id, Math.max(this.dearest.get(model.id) ?? 0, cost))
  }
}
class BudgetStop extends Error {}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const orgId = arg('org')
  const playbookFile = arg('playbook')
  const scopeFile = arg('scope')
  const outDir = arg('out-dir')
  const n = Number(arg('n') ?? '10')
  const cap = Number(arg('cap') ?? '5')
  if (!orgId || !playbookFile || !scopeFile || !outDir) throw new Error('--org, --playbook, --scope and --out-dir are required')
  if (!path.resolve(outDir).includes(`${path.sep}.writer-export`)) throw new Error('--out-dir must be under .writer-export/ (gitignored): the output names real people')
  const excluded = (arg('exclude-companies') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  let seed = Number(arg('seed') ?? Date.now() % 100000)
  const seedUsed = seed
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  if (seed <= 0) seed = 1

  const playbook = loadPlaybook(playbookFile)
  const scope = JSON.parse(fs.readFileSync(scopeFile, 'utf-8')) as ScopeGuards
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: org, error: orgError } = await supabase.from('organisations').select('name, founder_first_name').eq('id', orgId).single()
  if (orgError || !org?.name || !org.founder_first_name) throw new Error('organisation needs a name and founder_first_name for the sign-off')
  const sender: Sender = { firstName: org.founder_first_name, company: org.name }

  // The client's generic words, for the short name, from its active messaging document.
  const { data: doc } = await supabase.from('strategy_documents').select('content')
    .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'active').is('segment_id', null).maybeSingle()
  const brief = ((doc?.content ?? {}) as Record<string, unknown>).outbound_brief as Pick<OutboundBrief, 'generic_kind_words' | 'peer_group_default'> | undefined
  const genericWords = brief ? clientGenericWords({ generic_kind_words: brief.generic_kind_words ?? [], peer_group_default: brief.peer_group_default }) : new Set<string>()

  // Prospects not uploaded, with research from the last 30 days.
  const since = new Date(TODAY.getTime() - 30 * 24 * 3600 * 1000).toISOString()
  const { data: rows, error } = await supabase.from('prospects')
    .select('id, first_name, last_name, job_title, role, company_name, company_industry, apollo_enrichment_data, firm_fact, current_research_result_id')
    .eq('organisation_id', orgId).eq('outbound_upload_status', 'pending').not('current_research_result_id', 'is', null)
  if (error) throw new Error(error.message)
  const resultIds = (rows ?? []).map(r => r.current_research_result_id as string)
  const { data: results, error: rError } = await supabase.from('prospect_research_results')
    .select('id, candidates, created_at').eq('organisation_id', orgId).in('id', resultIds).gte('created_at', since)
  if (rError) throw new Error(rError.message)
  const resultById = new Map((results ?? []).map(r => [r.id as string, r]))
  const eligible = (rows ?? [])
    .filter(r => resultById.has(r.current_research_result_id as string))
    .filter(r => !excluded.some(x => (r.company_name ?? '').toLowerCase().includes(x)))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j], eligible[i]] }
  const picked = eligible.slice(0, n)
  console.log(`eligible ${eligible.length}, picked ${picked.length}, seed ${seedUsed}, cap $${cap}`)

  const prospects: ProspectInput[] = picked.map(r => {
    const candidates = (resultById.get(r.current_research_result_id as string)!.candidates ?? []) as ObservationCandidate[]
    const facts = candidates.map(researchFact)
    const ff = r.firm_fact as FirmFactRecord | null
    if (ff?.quote) facts.push({ id: 'FIRM', kind: 'firm', source: 'website', date: ff.source_fetched_at?.slice(0, 10) ?? null, evidence: ff.quote, provenance: ff.source_url ?? 'no url', shared: false, ineligible: null })
    else if (r.company_industry) facts.push({ id: 'RECORD', kind: 'record', source: 'stored company record', date: null, evidence: `${r.company_industry}`, provenance: 'industry field', shared: false, ineligible: null })
    const record = peerKindRecordFromRow({ company_name: r.company_name, company_industry: r.company_industry, enrichment: r.apollo_enrichment_data })
    return {
      id: r.id as string,
      firstName: (r.first_name as string | null) ?? 'there',
      lastName: r.last_name as string | null,
      role: (r.job_title as string | null) ?? (r.role as string | null),
      companyName: r.company_name as string | null,
      shortName: companyShortName(r.company_name, genericWords, { firstName: r.first_name, lastName: r.last_name }, firmTradeWords(record?.industry, record?.tags)),
      facts,
    }
  })

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 10 * 60 * 1000, maxRetries: 1 })
  const budget = new Budget(cap)
  const results2: Array<{ p: ProspectInput; byModel: ModelResult[]; order: string[] }> = []
  let stoppedAt: string | null = null
  outer: for (const p of prospects) {
    const byModel: ModelResult[] = []
    for (const model of MODELS) {
      try {
        process.stdout.write(`${p.id.slice(0, 8)} ${model.id} ... `)
        const r = await runOne(client, model, p, sender, playbook, scope, budget)
        byModel.push(r)
        console.log(`$${r.cost.toFixed(3)} attempts ${r.attempts.length} failures ${r.finalFailures.length} (total $${budget.spent.toFixed(3)})`)
      } catch (e) {
        if (e instanceof BudgetStop) { stoppedAt = e.message; console.log(`STOP: ${e.message}`); if (byModel.length) results2.push({ p, byModel, order: byModel.map(m => m.model) }); break outer }
        throw e
      }
    }
    // Which model is Version 1 is decided at random, per prospect.
    const order = random() < 0.5 ? byModel.map(m => m.model) : byModel.map(m => m.model).reverse()
    results2.push({ p, byModel, order })
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'raw-results.json'), JSON.stringify({ seed: seedUsed, results: results2 }, null, 2))
  }

  fs.mkdirSync(outDir, { recursive: true })
  writeReadingFile(path.join(outDir, 'reading-file.md'), results2, sender, budget, stoppedAt, eligible.length, seedUsed)
  console.log(`spent $${budget.spent.toFixed(3)} of $${cap}`)
}

function writeReadingFile(file: string, results: Array<{ p: ProspectInput; byModel: ModelResult[]; order: string[] }>, sender: Sender, budget: Budget, stoppedAt: string | null, eligibleCount: number, seed: number) {
  const L: string[] = []
  const asSent = (out: WriterOutput | null) => {
    if (!out) return ['(no sequence: the model returned nothing usable)']
    return [...out.emails].sort((a, b) => a.email - b.email).flatMap(e => [
      `**Email ${e.email}**${e.email === 1 && e.subject ? `  Subject: ${e.subject}` : ''}`,
      '',
      ...`${signOff(e.body, sender)}\n\n${OPT_OUT_FOOTER}`.split('\n').map(l => (l ? `> ${l}` : '>')),
      '',
    ])
  }
  L.push('# Writer v2 prototype: reading file', '')
  results.forEach(({ p, byModel, order }, i) => {
    L.push(`## Prospect ${i + 1}: ${p.firstName} at ${p.companyName ?? 'unknown company'}`, '')
    order.forEach((modelId, v) => {
      L.push(`### Version ${v + 1}`, '', ...asSent(byModel.find(m => m.model === modelId)?.final ?? null))
    })
  })
  L.push('---', '', '# Key (read after the blind read)', '')
  L.push(`Seed ${seed}. ${eligibleCount} prospects were eligible (not uploaded, research in the last 30 days, excluded companies removed); ${results.length} run.`)
  L.push(`Models: ${MODELS.map(m => `${m.id} = ${m.label}`).join('; ')}.`)
  L.push(`Spent $${budget.spent.toFixed(3)} of the $${budget.cap} cap.${stoppedAt ? ` STOPPED EARLY: ${stoppedAt}` : ''}`, '')
  const qualifying = results.filter(r => r.p.facts.some(f => f.kind === 'research' && !f.ineligible)).length
  L.push(`Prospects with at least one qualifying personal fact (research fact dated within 12 months, not a founding date, tagline or ended role): ${qualifying} of ${results.length}.`, '')
  results.forEach(({ p, byModel, order }, i) => {
    L.push(`## Prospect ${i + 1}: ${p.firstName} at ${p.companyName ?? 'unknown company'} (${p.id})`, '')
    L.push(`Short name: ${p.shortName ?? '(none: firm not named)'}. Facts offered: ${p.facts.filter(f => !f.ineligible).map(f => f.id).join(', ') || 'none'}; left out: ${p.facts.filter(f => f.ineligible).length}.`, '')
    order.forEach((modelId, v) => {
      const r = byModel.find(m => m.model === modelId)!
      const out = r.final
      const fact = out ? p.facts.find(f => f.id === out.fact_used.fact_id) : undefined
      L.push(`### Version ${v + 1} = ${modelId}`, '')
      L.push(`- Cost: $${r.cost.toFixed(4)} over ${r.attempts.length} call${r.attempts.length === 1 ? '' : 's'} (${r.attempts.map(a => `$${a.cost.toFixed(4)}`).join(' + ')})`)
      if (out) {
        L.push(`- Fact chosen: ${out.fact_used.fact_id}${fact ? ` (${fact.kind}, ${fact.source}, dated ${fact.date ?? 'none'})` : ''}`)
        if (fact) L.push(`  - Stored evidence: "${fact.evidence}"`, `  - Provenance: ${fact.provenance}`)
        L.push(`  - Quote the writer gave: "${out.fact_used.quote}"`)
        L.push(`- Link sentence: ${out.link_sentence}`)
        L.push(`- Angles: ${[...out.angles].sort((a, b) => a.email - b.email).map(a => `E${a.email} ${a.angle}`).join('; ')}`)
      }
      if (r.attempts.length > 1) L.push(`- First attempt failed the guards: ${r.attempts[0].failures.map(f => `\n  - ${f}`).join('')}`)
      L.push(r.finalFailures.length ? `- FINAL SEQUENCE STILL FAILS the guards (kept above): ${r.finalFailures.map(f => `\n  - ${f}`).join('')}` : '- Guards: pass')
      L.push(r.copied.length ? `- Copied phrases (report only): ${r.copied.map(c => `\n  - ${c}`).join('')}` : '- Copied phrases: none')
      if (out?.self_check) L.push(`- Self-check notes: ${out.self_check.replace(/\n+/g, ' / ')}`)
      L.push('')
    })
  })
  fs.writeFileSync(file, L.join('\n'))
}

main().catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1) })
