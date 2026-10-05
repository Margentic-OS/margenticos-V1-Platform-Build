// Firm-fact extraction: one verified clause about what a template-bound prospect does,
// from the website text research already stored.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)". Decisions 2 and 3, Design,
// Cost, Round 4 ({does}), Round 6 (faithfulness check, revised caps).
//
// MODEL CALLS, and why each is one (ADR-018):
//   extraction  claude-sonnet-4-6. Picking the most specific thing a page says the firm
//               does, and recasting it as one second-person clause in the page's own words,
//               is synthesis; rules cannot do it.
//   judge       claude-haiku-4-5-20251001. Whether a paraphrase says only what its source
//               says is a judgement. SEPARATE from extraction because a model checking its
//               own paraphrase tends to agree with itself (Round 6).
// Everything around the two calls is deterministic and lives in firm-fact-checks.ts.
//
// COST, ENFORCED BY CONSTRUCTION AND CHECKED THREE WAYS (Cost section, Round 6):
//   1. Pre-submit: the extraction request is token-counted. Over the cap, the website text
//      is cut once and recounted; still over, nothing is submitted and the prospect gets
//      the template (reason firm_fact_cost_ceiling).
//   2. Build time: firm-fact-cost.test.ts derives the worst case from USD_PER_MTOK and the
//      caps and fails if it exceeds $0.02.
//   3. Post-call: actual usage is priced at FULL price and written to research_usage. Over
//      $0.02, which the construction says cannot happen, the fact is discarded, an error is
//      logged (Sentry), and the firm_fact_extraction flag is switched off for every client
//      until a person reviews it.
// No retry inside this tier: a failed or rejected extraction ships the template, so a
// prospect is billed for at most one extraction and one judge call.
//
// INLINE, NOT THE BATCH API. The plan's design put extraction on the batch route at half
// price. The first cut calls inline at full price, which the ceiling was set to hold at
// ("at FULL price so it holds even if a request ever falls back off the batch route").
// Moving to the batch route halves the cost and is on the deferred list.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { readBrief, clientGenericWords } from '@/lib/outbound-brief/brief'
import {
  EXTRACTION_MAX_INPUT_TOKENS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  FIRM_FACT_CEILING_USD,
  FIRM_FACT_CHECKS_VERSION,
  FIRM_FACT_EXTRACTION_MODEL,
  FIRM_FACT_JUDGE_MODEL,
  JUDGE_MAX_INPUT_TOKENS,
  JUDGE_MAX_OUTPUT_TOKENS,
  QUOTE_MAX_CHARS,
  SECTION_RANK,
  SOURCE_MAX_AGE_DAYS,
  WEBSITE_TEXT_MAX_CHARS,
  CARRIER_VERBS,
  KNOWN_ACRONYM_LIST,
  QUOTE_CHECK_STOP_WORDS,
  actualFirmFactCostUsd,
  broadClause,
  ampersandAsAnd,
  clauseForms,
  isKindVerb,
  type KindVerb,
  checkDoesClause,
  checkFirmKind,
  sentenceCaseKind,
  sentenceCaseClause,
  checkForWhom,
  findWordsAbsentFromQuote,
  decodePageText,
  identityMatches,
  quoteIsVerbatim,
  unusablePageReason,
} from './firm-fact-checks'

export const FIRM_FACT_FLAG_KEY = 'firm_fact_extraction'

export interface PeerGroupOption {
  id: string
  label: string
}

export interface FirmFactSource {
  text: string
  url: string | null
  fetched_at: string
  research_result_id: string
}

interface TokenCounts {
  input_tokens: number
  output_tokens: number
}

/** What is stored in prospects.firm_fact. passed = false rows are kept: no second payment. */
export interface FirmFactRecord {
  version: number
  passed: boolean
  reason: string | null
  does: string | null
  for_whom: string | null
  peer_group_id: string | null
  peer_group_label: string | null
  quote: string | null
  section: string | null
  source_url: string | null
  source_fetched_at: string | null
  research_result_id: string | null
  extracted_at: string
  check_reasons: string[]
  judge: JudgeVerdict | null
  cost_usd_full_price: number
  /**
   * Which rung of the ladder this fact reached (version 8): 'specific' when the clause in
   * `does` passed, 'broad' when only the kind of firm did. Absent or null on a record that
   * did not pass.
   */
  rung?: 'specific' | 'broad' | null
  /** The kind of firm, with its article ("an HR consultancy"), when that rung passed. */
  kind?: string | null
  /** The verb the broad line opens on, given by the extraction: "run" or "are". */
  kind_verb?: KindVerb | null
  kind_quote?: string | null
  /** The judge's audit of the broad line, when one was made. */
  judge_broad?: JudgeVerdict | null
}

export interface JudgeVerdict {
  claims: Array<{ claim: string; supported: boolean }>
  added_number: boolean
  added_praise: boolean
  /** True when added_concepts is not empty. Kept as its own field for records stored before version 5. */
  added_claim: boolean
  /** Rule 10: every idea in the clause the quote does not state. Any entry fails the clause. */
  added_concepts: string[]
  customers_supported: boolean
  peer_group_supported: boolean
}

export interface FirmFactOutcome {
  record: FirmFactRecord
  usage: { extraction: TokenCounts | null; judge: TokenCounts | null }
}

// ─── Prompts (Rule Zero: no industry, market or client is named) ──────────────

export const FIRM_FACT_EXTRACTION_PROMPT = `You read the text of one company's own website and pick out what the company does.

Return ONLY JSON, no prose. Write it ONCE and stop: do not revise it, repeat it or explain it. Code checks every field afterwards.
{"peer_group":"<id>" or null,"candidates":[{"does":"you ...","for_whom":"..." or null,"quote":"...","section":"service" | "niche" | "body" | "title" | "tagline"}],"firm_kind":{"kind":"a ...","verb":"run" or "are","quote":"..."} or null}
Return {"peer_group":null,"candidates":[],"firm_kind":null} if the page does not say what the company does, or is not a company's own page.
Give at most 2 candidates, best first. Give firm_kind as well whenever the page says what kind of company it is, even when you also give candidates.

does: what the company does, said TO the company: "you" plus a present-tense verb, then one specific detail such as a named service or the kind of customer. One clause, 12 words or fewer, no full stop, no comma and no dash: name ONE thing, or two joined by "and", never a list. Where the page gives a list, write the clause for its FIRST item alone. Lower case, except a name or an acronym. Prefer a line that names a SERVICE the company sells, or its niche, over a slogan or a tagline: a slogan says what the company hopes for ("for a changing world", "to help you thrive") and could sit on any company's page. Mark a slogan's section as "tagline" honestly; it is used only when nothing better is on the page.
NO ACRONYM THE READER MAY NOT KNOW. Only these may appear: ${KNOWN_ACRONYM_LIST}. For any other short form in capitals, use the plain words the page itself gives for it if your quote holds them, or leave that part out, or pick a different quote.
Never use the word "your". When the page speaks to its own customer ("we run your accounts"), say who that customer is if the quote names them ("you run accounts for dentists"), or pick a different quote.
USE THE PAGE'S OWN WORDS. Every noun, every service and every action in does must be a word that appears in your quote. Change only the grammar: "we" becomes "you", and a verb may change its tense or ending ("designing" to "design", "builds" to "build"). Never swap a word for a nicer or plainer one, and never add a word for something the quote does not name: if the quote says "systems", do not write "automation systems"; if it says "implement", do not write "select and implement".
A noun stays a noun. If the quote names the work as a thing ("installation", "translation"), do not turn it into a verb: keep the noun and open with "you provide". "you help" and "you provide" are the only two openings you may use that the quote does not contain.
YOU MAY LEAVE A WORD OUT. YOU MAY NEVER PUT ONE IN. Never put in does: numbers, praise or claims of quality, sales language (a word such as "solutions" that could describe any company), how long they have existed, what they do not do, named clients, people or places that are not on the page, guesses. If the quote itself uses such a word, leave that word out; never replace it with another. If nothing is left that says what the company does, pick a different quote or return no candidate.

for_whom: who the company's own customers are, as a plural category of 5 words or fewer, for example "regional food wholesalers". Use only words that appear in your quote. Never a named organisation. Never a bare word like "businesses" or "clients". null if the quote does not say.

firm_kind: what KIND of company this is, said simply, in the page's own words. kind is "a" or "an" plus 5 words or fewer, such as "a dental practice". Write it in lower case, but keep any short form exactly as the page writes it. The only short forms allowed are ${KNOWN_ACRONYM_LIST}; for any other, use the page's plain words for it or give null. Every word of it must appear in its quote. It ends on the noun for what the company is, as the page writes it after "a" or "an". It names the FIELD OF WORK, never only the company's size, ownership, legal form, age or place: "a small business", "a family firm", "a start-up" and "a limited company" say nothing about what it does, so give null instead. No praise, no numbers, no names of places, people, brands or products, no "leading" or "boutique". Its quote is the shortest span of the page, copied exactly, under 250 characters, that says the company itself is that kind of company. null if the page does not say what kind of company it is.
verb: the word that makes "you <verb> <kind>" a sentence a person would say. "run" when kind names an organisation ("you run a dental practice"). "are" when kind names a person or a maker ("you are a pension adviser", "you are a furniture maker").

peer_group: the id from PEER GROUPS whose label best describes the company itself, or null if none fits well.

quote: the shortest span of the page, copied exactly as it appears, under 250 characters, that contains every word you used in does and in for_whom.

section: where the quote sits on the page.`

export const FIRM_FACT_JUDGE_PROMPT = `You check whether short clauses about a company say only what quotes from its own website say.

You get one or two ITEMS. Each has its own QUOTE and a CLAUSE, addressed to the company as "you". You also get CUSTOMERS (who its customers are, or none) and PEER GROUP (a label for what kind of company it is, or none).

For EACH item, go through its CLAUSE one word at a time against ITS OWN QUOTE. Skip only these: ${QUOTE_CHECK_STOP_WORDS.join(', ')}. For EVERY other word, decide whether the QUOTE states it: the same word, another form of the same word, or a plain synonym doing the same job in the sentence. A word the quote does not state is ADDED, even when it is a reasonable guess and even when it is probably true. A more specific word than the quote uses is added: if the quote says "cold rooms" and the clause says "energy-saving cold rooms", "energy-saving" is not stated. An extra action is added: if the quote says "we repair lifts" and the clause says "you install and repair lifts", "install" is not stated.
${CARRIER_VERBS.map(v => `"${v}"`).join(' or ')} straight after "you" is a special case. It is stated when the quote shows the company ITSELF does or supplies what follows. It is NOT stated when the quote says the company does something else with that thing: if the quote says "we build software that tracks parcels" and the clause says "you provide parcels", "provide" is not stated, because the company does not provide parcels.
"run" or "are" straight after "you", followed by a kind of company or of professional ("you run a dental practice", "you are a pension adviser"), is a special case too. It is stated when the quote says the company ITSELF is that kind. It is NOT stated when the quote is about a kind of company or professional it sells to, works with or writes about.

For each item also say:
- added_number: the clause has a number the quote does not have.
- added_praise: the clause praises the company or claims quality.
- twists_the_quote: true if the clause changes what the quote means: it says the opposite of the quote, because a word such as "not" was left out; it says of the company something the quote says of the company's customers, or of somebody or something else; or it joins the quote's words into a different action on a different thing. A clause that only LEAVES OUT part of the quote does not twist it, so false: its ending left off, one item of a list it gives, a describing word dropped.

Then say once, for the company:
- customers_supported: the first item's quote states CUSTOMERS, with nothing added: every describing word in CUSTOMERS is in that quote. Also true when CUSTOMERS is none.
- peer_group_supported: a quote fits PEER GROUP as a description of the company, or PEER GROUP is none.

Return ONLY JSON. One entry in "items" for each ITEM you were given, and in each, one entry in "words" for every word of its clause you did not skip, in order:
{"items":[{"item":"A","words":[{"word":"...","stated":true}],"twists_the_quote":false,"added_number":false,"added_praise":false}],"customers_supported":true,"peer_group_supported":true}`

function parseJson(text: string): unknown {
  // THE LAST fenced block that parses, not the first. A model that writes an answer, then
  // "Wait, let me fix", then a second answer means the second: read from a real extraction
  // on 2026-10-01, where the first block was taken and the correction thrown away.
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1])
  const bodies = blocks.length > 0 ? blocks.reverse() : [text]
  let firstError: unknown = null
  for (const body of bodies) {
    const start = body.search(/\{\s*"/)
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) { firstError ??= new SyntaxError('no JSON object'); continue }
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError ?? new SyntaxError('no JSON object')
}

function emptyRecord(reason: string, extra: Partial<FirmFactRecord> = {}): FirmFactRecord {
  return {
    version: FIRM_FACT_CHECKS_VERSION,
    passed: false,
    reason,
    does: null,
    for_whom: null,
    peer_group_id: null,
    peer_group_label: null,
    quote: null,
    section: null,
    source_url: null,
    source_fetched_at: null,
    research_result_id: null,
    extracted_at: new Date().toISOString(),
    check_reasons: [],
    judge: null,
    cost_usd_full_price: 0,
    ...extra,
  }
}

// ─── The pure-ish core: one prospect, given its page ──────────────────────────

/**
 * Extract and verify one firm fact. Never throws for a content problem: every failure is a
 * record with passed = false and a reason. Throws only for programming errors.
 */
export async function extractFirmFact(input: {
  client: Anthropic
  companyName: string
  source: FirmFactSource
  peerGroups: readonly PeerGroupOption[]
  /**
   * The words that are generic for THIS client's list (clientGenericWords in the brief). A
   * clause or a kind made only of these names nothing. REQUIRED, so a caller that drops
   * them does not compile: a caller with no brief passes an empty set and says so.
   */
  genericWords: ReadonlySet<string>
}): Promise<FirmFactOutcome> {
  const { client, companyName, source, peerGroups, genericWords } = input
  const base = {
    source_url: source.url,
    source_fetched_at: source.fetched_at,
    research_result_id: source.research_result_id,
  }
  const page = decodePageText(source.text)

  const unusable = unusablePageReason(page)
  if (unusable) return { record: emptyRecord(unusable, base), usage: { extraction: null, judge: null } }
  if (!identityMatches(companyName, page, source.url)) {
    return { record: emptyRecord('identity_mismatch', base), usage: { extraction: null, judge: null } }
  }

  // 1. Pre-submit cost gate: count, cut once, recount.
  const buildUser = (text: string) =>
    `COMPANY: ${companyName}\nPEER GROUPS: ${JSON.stringify(peerGroups.map(p => ({ id: p.id, label: p.label })))}\nPAGE TEXT:\n${text}`
  let pageForModel = page.slice(0, WEBSITE_TEXT_MAX_CHARS)
  let counted = await countInputTokens(client, FIRM_FACT_EXTRACTION_MODEL, FIRM_FACT_EXTRACTION_PROMPT, buildUser(pageForModel))
  if (counted !== null && counted > EXTRACTION_MAX_INPUT_TOKENS) {
    const keep = Math.floor(pageForModel.length * (EXTRACTION_MAX_INPUT_TOKENS / counted) * 0.9)
    pageForModel = pageForModel.slice(0, Math.max(0, keep))
    counted = await countInputTokens(client, FIRM_FACT_EXTRACTION_MODEL, FIRM_FACT_EXTRACTION_PROMPT, buildUser(pageForModel))
  }
  if (counted === null || counted > EXTRACTION_MAX_INPUT_TOKENS) {
    logger.warn('firm-fact: request not submitted, over the cost ceiling or uncountable', { counted })
    return { record: emptyRecord('firm_fact_cost_ceiling', base), usage: { extraction: null, judge: null } }
  }

  // 2. Extraction.
  let extractionUsage: TokenCounts | null = null
  let candidates: Array<{ does?: unknown; for_whom?: unknown; peer_group?: unknown; quote?: unknown; section?: unknown }> = []
  let rawKind: { kind?: unknown; verb?: unknown; quote?: unknown } | null = null
  let topPeer: string | null = null
  try {
    const response = await client.messages.create({
      model: FIRM_FACT_EXTRACTION_MODEL,
      max_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: FIRM_FACT_EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: buildUser(pageForModel) }],
    })
    extractionUsage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    // A CUT-OFF ANSWER IS A FAILURE, UNLESS A WHOLE ANSWER IS IN IT. Read from real
    // extractions on 2026-10-01: on some pages the model writes a complete answer, then
    // "Wait, let me fix", and runs out of room part way through writing it again. The
    // first answer is whole, every field of it is checked by code and judged like any
    // other, and throwing it away was a paid failure on a prospect that had passed. An
    // answer that is cut off with nothing whole in it does not parse, and is still a
    // failure with its own reason.
    let parsed: { candidates?: unknown; firm_kind?: unknown; peer_group?: unknown }
    if (response.stop_reason === 'max_tokens') {
      try {
        parsed = parseJson(text) as typeof parsed
      } catch {
        return finish(emptyRecord('extraction_truncated', base), extractionUsage, null)
      }
    } else {
      parsed = parseJson(text) as typeof parsed
    }
    candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
    rawKind = parsed.firm_kind && typeof parsed.firm_kind === 'object' ? parsed.firm_kind as { kind?: unknown; verb?: unknown; quote?: unknown } : null
    topPeer = typeof parsed.peer_group === 'string' ? parsed.peer_group : null
  } catch (err) {
    logger.warn('firm-fact: extraction call or parse failed', { error: String(err) })
    return finish(emptyRecord('extraction_failed', base), extractionUsage, null)
  }
  if (candidates.length === 0 && !rawKind) return finish(emptyRecord('no_fact_on_page', base), extractionUsage, null)

  // 3. Deterministic checks, candidates in section-rank order; first to pass goes on.
  const checked = candidates
    .map(c => ({
      // In the case of running prose, like the kind: a clause lifted from a heading keeps
      // the heading's capitals ("you provide Fractional Executive Services"), and a word is
      // lowered only where the page itself writes it in lower case, so a name keeps its own.
      does: typeof c.does === 'string'
        ? sentenceCaseClause(c.does.trim().replace(/[.]$/, ''), typeof c.quote === 'string' ? c.quote.trim() : '', page)
        : '',
      for_whom: typeof c.for_whom === 'string' && c.for_whom.trim() ? c.for_whom.trim() : null,
      peer_group: typeof c.peer_group === 'string' ? c.peer_group : null,
      quote: typeof c.quote === 'string' ? c.quote.trim() : '',
      section: typeof c.section === 'string' ? c.section : 'body',
    }))
    .sort((a, b) => (SECTION_RANK[a.section] ?? 3) - (SECTION_RANK[b.section] ?? 3))
  const allReasons: string[] = []
  let chosen: (typeof checked)[number] | null = null
  let forWhom: string | null = null
  // A CLAUSE IS REPAIRED BY REMOVAL BEFORE IT IS REFUSED (checks version 16), and EVERY
  // CANDIDATE IS TRIED AS WRITTEN BEFORE ANY IS REPAIRED (version 17). A clause the model
  // wrote whole is better than one code cut: on 2026-10-02 the first candidate's cut form
  // ("you help boutique hotels reach their full potential") shipped ahead of a second
  // candidate that said what the firm does. So two passes over the candidates: the clause
  // as written, then its repairs (the first item of a list, the clause cut at its trailing
  // phrase). The first form that passes every check goes on to the judge, and what was
  // done to it is recorded. See clauseForms for why removal is safe to try.
  //
  // A SLOGAN IS TRIED LAST, AFTER EVERY OTHER CANDIDATE AND ITS REPAIRS. The prompt tells
  // the model a slogan "is used only when nothing better is on the page", and the two
  // passes above did not hold that: a slogan that passed as written was reached before a
  // service line that needed one cut, and shipped (the pre-merge review, 2026-10-02). A
  // service line cut by code still says what the firm sells; a slogan whole does not. So
  // the two passes run over every candidate that is not a slogan, and then over the slogans.
  // WHAT A SLOGAN IS RESTS ON THE MODEL'S LABEL: section "tagline" and nothing else. A
  // slogan the model marks "body" or "title" is tried in that place. "title" is not moved
  // with it on purpose: a page title is as often a plain description of the firm.
  const asWritten = (list: typeof checked) => list.map(candidate => ({ candidate, forms: clauseForms(candidate.does).slice(0, 1) }))
  const repaired = (list: typeof checked) => list.map(candidate => ({ candidate, forms: clauseForms(candidate.does).slice(1) }))
  const lines = checked.filter(candidate => candidate.section !== 'tagline')
  const slogans = checked.filter(candidate => candidate.section === 'tagline')
  const attempts = [...asWritten(lines), ...repaired(lines), ...asWritten(slogans), ...repaired(slogans)]
  for (const { candidate, forms } of attempts) {
    const quoteReasons: string[] = []
    if (!quoteIsVerbatim(candidate.quote, page)) quoteReasons.push('quote is not verbatim on the page')
    if (candidate.quote.length > QUOTE_MAX_CHARS) quoteReasons.push('quote too long')
    let passed: { does: string; repair: string } | null = null
    for (const form of forms) {
      const reasons = [...quoteReasons]
      // With its quote: a short form is judged as the quote writes it (checks version 23).
      reasons.push(...checkDoesClause(form.does, page, genericWords, candidate.quote).reasons.map(r => `does: ${r}`))
      // Rule 10, in code: every content word of the clause is in its own quote.
      const absent = findWordsAbsentFromQuote(form.does, candidate.quote)
      if (absent.length > 0) reasons.push(`does: not in the quote: ${absent.join(', ')}`)
      if (reasons.length === 0) {
        passed = form
        break
      }
      allReasons.push(`[${form.does}]${form.repair === 'none' ? '' : ` (${form.repair})`} ${reasons.join('; ')}`)
    }
    if (!passed) continue
    if (passed.repair !== 'none') allReasons.push(`[${candidate.does}] repaired by removal (${passed.repair}) to [${passed.does}]`)
    const c = { ...candidate, does: passed.does }
    chosen = c
    // An unusable {for_whom} does not sink the clause: the offer falls back to slot-free.
    //
    // THE CUSTOMER GROUP IS HELD TO THE QUOTE TOO. It ships in the offer and the subject,
    // so an invented qualifier there is the same fault as one in the clause. Until
    // 2026-10-01 it needed only ONE of its words anywhere on the page: "regional food
    // wholesalers" passed against a page that said "wholesalers" and nothing else.
    if (c.for_whom) {
      const fw = checkForWhom(c.for_whom, page)
      const absentFromQuote = findWordsAbsentFromQuote(c.for_whom, c.quote, { carrierAfterYou: false })
      const fwReasons = [...fw.reasons, ...(absentFromQuote.length > 0 ? [`not in the quote: ${absentFromQuote.join(', ')}`] : [])]
      if (fwReasons.length === 0) forWhom = c.for_whom
      else allReasons.push(`for_whom dropped [${c.for_whom}]: ${fwReasons.join('; ')}`)
    }
    break
  }

  // 3b. THE BROAD LINE, the second rung of the ladder (operator note 6 of the second
  // reading): a simple, true line about what KIND of firm this is, from its own site. It is
  // checked like the clause: its quote is on the page word for word, and every word of the
  // kind is in that quote. It is kept even when the specific clause passed, because the
  // clause can still fail later (the judge, or the real words at composition), and the
  // prospect should then fall one rung, not all the way to the template.
  let kind: { kind: string; verb: KindVerb; quote: string } | null = null
  if (rawKind) {
    const k = {
      // In the case of running prose, BEFORE any check reads it: see sentenceCaseKind.
      kind: typeof rawKind.kind === 'string' ? sentenceCaseKind(ampersandAsAnd(rawKind.kind.trim().replace(/[.]$/, '')), page) : '',
      quote: typeof rawKind.quote === 'string' ? rawKind.quote.trim() : '',
    }
    const reasons: string[] = []
    if (!quoteIsVerbatim(k.quote, page)) reasons.push('quote is not verbatim on the page')
    if (k.quote.length > QUOTE_MAX_CHARS) reasons.push('quote too long')
    reasons.push(...checkFirmKind(k.kind, k.quote, page, genericWords).reasons)
    // THE VERB IS THE EXTRACTION'S, and a kind without one is not a broad line: code does
    // not guess which verb fits a kind. See broadClause.
    const verb = isKindVerb(rawKind.verb) ? rawKind.verb : null
    if (!verb) reasons.push('no verb given for the kind ("run" or "are")')
    if (reasons.length === 0 && verb) kind = { ...k, verb }
    else allReasons.push(`kind dropped [${k.kind}]: ${reasons.join('; ')}`)
  }
  if (!chosen && !kind) {
    return finish(emptyRecord('failed_deterministic_checks', { ...base, check_reasons: allReasons }), extractionUsage, null)
  }
  const peer = peerGroups.find(p => p.id === (chosen?.peer_group ?? topPeer)) ?? null

  // 4. Faithfulness judge: ONE call, sees ONLY the quotes and the statements, and audits
  // both rungs. One call, not two, is what keeps both rungs inside the $0.02 ceiling.
  const items: JudgeItem[] = [
    ...(chosen ? [{ key: 'specific' as const, quote: chosen.quote, clause: chosen.does }] : []),
    ...(kind ? [{ key: 'broad' as const, quote: kind.quote, clause: broadClause(kind.kind, kind.verb) }] : []),
  ]
  const judged = await judgeItems(client, { items, forWhom, peerLabel: peer?.label ?? null })
  const judgeUsage = judged.usage
  if (judged.verdicts === null) {
    // THE KIND IS RECORDED BEFORE THIS RETURN. Composition's veto on the peer rung reads every
    // kind a stored fact holds, a dropped one included, by its "kind dropped [<kind>]:" line,
    // and parses that text. A judge that gave nothing back used to end the run before any
    // such line was written, so the veto could not see the kind (the peer review, 2026-10-02).
    if (kind) allReasons.push(`kind dropped [${kind.kind}]: judge gave no verdict`)
    return finish(emptyRecord(judged.reason, { ...base, check_reasons: allReasons }), extractionUsage, judgeUsage)
  }
  const specific = judged.verdicts.specific ?? null
  const broad = judged.verdicts.broad ?? null
  const specificOk = !!chosen && !!specific && isFaithful(specific)
  const broadOk = !!kind && !!broad && isFaithful(broad)
  if (chosen && !specificOk) allReasons.push(`[${chosen.does}] judge: ${specific ? specific.added_concepts.join(', ') || 'not faithful' : 'no verdict'}`)
  if (kind && !broadOk) allReasons.push(`kind dropped [${kind.kind}]: judge: ${broad ? broad.added_concepts.join(', ') || 'not faithful' : 'no verdict'}`)

  const record = emptyRecord('', {
    ...base,
    does: chosen?.does ?? null,
    quote: chosen?.quote ?? kind?.quote ?? null,
    section: chosen?.section ?? (kind ? 'kind' : null),
    check_reasons: allReasons,
    judge: specific ?? broad,
    judge_broad: broad,
  })
  if (!specificOk && !broadOk) {
    record.reason = 'judge_not_faithful'
    return finish(record, extractionUsage, judgeUsage)
  }
  record.passed = true
  record.reason = null
  record.rung = specificOk ? 'specific' : 'broad'
  if (!specificOk) {
    // The clause did not survive. What ships is the kind, so the record must not offer the
    // clause to composition under any reading.
    record.does = null
    record.quote = kind!.quote
    record.section = 'kind'
  }
  record.for_whom = specificOk && forWhom && specific!.customers_supported ? forWhom : null
  record.kind = broadOk ? kind!.kind : null
  record.kind_verb = broadOk ? kind!.verb : null
  record.kind_quote = broadOk ? kind!.quote : null
  const peerVerdict = specificOk ? specific! : broad!
  if (peer && peerVerdict.peer_group_supported) {
    record.peer_group_id = peer.id
    record.peer_group_label = peer.label
  }
  return finish(record, extractionUsage, judgeUsage)
}

/** Code's reading of a judge verdict: every claim supported and nothing added. */
export function isFaithful(verdict: JudgeVerdict): boolean {
  return verdict.claims.length > 0 && verdict.claims.every(c => c.supported) &&
    !verdict.added_number && !verdict.added_praise && !verdict.added_claim && verdict.added_concepts.length === 0
}

export interface JudgeItem {
  /** Which rung of the ladder this clause is. */
  key: 'specific' | 'broad'
  quote: string
  clause: string
}

type JudgeItemsResult =
  | { verdicts: Partial<Record<JudgeItem['key'], JudgeVerdict>>; usage: TokenCounts | null; reason: null }
  | { verdicts: null; usage: TokenCounts | null; reason: string }

/**
 * One faithfulness judge call over one or two clauses, each against its own quote.
 *
 * verdicts null means the judge gave no usable answer at all; `reason` says why. A clause
 * the answer does not cover has no entry, and no entry is not a pass. Token-counted before
 * sending, like extraction: an uncountable or over-cap request is not submitted.
 */
export async function judgeItems(
  client: Anthropic,
  input: { items: readonly JudgeItem[]; forWhom: string | null; peerLabel: string | null },
): Promise<JudgeItemsResult> {
  const letters = ['A', 'B']
  const judgeUser = [
    ...input.items.flatMap((item, i) => [`ITEM ${letters[i]}`, `QUOTE: ${item.quote}`, `CLAUSE: ${item.clause}`]),
    `CUSTOMERS: ${input.forWhom ?? 'none'}`,
    `PEER GROUP: ${input.peerLabel ?? 'none'}`,
  ].join('\n')
  let usage: TokenCounts | null = null
  try {
    const judgeCount = await countInputTokens(client, FIRM_FACT_JUDGE_MODEL, FIRM_FACT_JUDGE_PROMPT, judgeUser)
    if (judgeCount === null || judgeCount > JUDGE_MAX_INPUT_TOKENS) return { verdicts: null, usage, reason: 'firm_fact_cost_ceiling' }
    const response = await client.messages.create({
      model: FIRM_FACT_JUDGE_MODEL,
      max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: FIRM_FACT_JUDGE_PROMPT,
      messages: [{ role: 'user', content: judgeUser }],
    })
    usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }
    if (response.stop_reason === 'max_tokens') return { verdicts: null, usage, reason: 'judge_truncated' }
    const raw = parseJson(response.content.map(b => (b.type === 'text' ? b.text : '')).join('')) as {
      items?: unknown
      customers_supported?: unknown
      peer_group_supported?: unknown
    }
    const answers = (Array.isArray(raw.items) ? raw.items : []).filter((a): a is RawJudgeItem => !!a && typeof a === 'object')
    const verdicts: Partial<Record<JudgeItem['key'], JudgeVerdict>> = {}
    input.items.forEach((item, i) => {
      // By letter, and by position when the judge left the letter out and answered in order.
      const answer = answers.find(a => a.item === letters[i]) ?? (answers.every(a => typeof a.item !== 'string') ? answers[i] : undefined)
      verdicts[item.key] = readAudit(item.clause, answer ?? {}, raw.customers_supported === true, raw.peer_group_supported === true)
    })
    return { verdicts, usage, reason: null }
  } catch (err) {
    logger.warn('firm-fact: judge call or parse failed', { error: String(err) })
    return { verdicts: null, usage, reason: 'judge_failed' }
  }
}

interface RawJudgeItem {
  item?: unknown
  words?: unknown
  twists_the_quote?: unknown
  added_number?: unknown
  added_praise?: unknown
}

/**
 * Code's reading of the judge's audit of ONE clause.
 *
 * THE JUDGE AUDITS WORD BY WORD, and code reads the audit. A judge asked the open question
 * "what was added?" passed a real added verb on 2026-10-01, with the question in its
 * prompt: the must-fail control caught it. Asked about each word in turn it has nothing to
 * skim. A missing or empty audit is not "nothing added": it is no verdict, and no verdict
 * fails.
 *
 * CODE HOLDS THE SKIP LIST, NOT THE PROMPT. The judge is told which words to skip, and
 * measured on 22 real clauses on 2026-10-01 it audited them anyway: "through", "on". Each
 * came back "not stated" and failed a clause the code check had passed for exactly that
 * word. So an audit entry for a word code itself ignores is dropped here, by the same
 * constant the code check uses.
 *
 * THE VERB AFTER "YOU" IS THE EXCEPTION, AND IT IS THE JUDGE'S. Code cannot tell whether
 * "you provide parcels" is fair for a firm whose page says it builds software that tracks
 * parcels: every noun is in the quote. The same goes for "you run a dental practice"
 * against a quote about the practices a firm sells to. So "help", "provide" and "run" after
 * "you" are exempt from the code check and are NOT dropped here: the judge is asked about
 * them directly.
 */
function readAudit(clause: string, raw: RawJudgeItem, customersSupported: boolean, peerGroupSupported: boolean): JudgeVerdict {
  const skippedByCode = (word: string) => QUOTE_CHECK_STOP_WORDS.includes(word.trim().toLowerCase())
  const words = Array.isArray(raw.words)
    ? (raw.words as Array<{ word?: unknown; stated?: unknown }>)
      .map(w => ({ word: String(w?.word ?? ''), stated: w?.stated === true }))
      .filter(w => w.word.trim() !== '' && !skippedByCode(w.word))
    : []
  const added = words.filter(w => !w.stated).map(w => w.word)
  // THE AUDIT MUST COVER THE CLAUSE. Asked about each word in turn the judge has nothing
  // to skim, but only if code checks that it was asked about each word: an audit of one
  // word of six, all "stated", passed. Every word of the clause that code does not skip
  // must appear in the audit.
  const auditTokens = new Set(words.flatMap(w => w.word.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)))
  //
  // EXCEPT "are" STRAIGHT AFTER "you". The broad line is "you are <kind>" as often as "you
  // run <kind>" now that the extraction gives the verb, and this judge leaves "are" out of
  // its audit as a grammar word: two sound lines of 77 real prospects failed on 2026-10-01
  // for "are (not audited)" and nothing else. An "are" the judge DOES audit as not stated
  // still fails, and twists_the_quote still covers the clause as a whole. "run" is not
  // exempt: it is a claim about the firm, and the judge is asked about it by name.
  const clauseTokens = clause.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const linkingVerbAfterYou = clauseTokens[0]?.toLowerCase() === 'you' && clauseTokens[1]?.toLowerCase() === 'are'
  const unaudited = clauseTokens.filter(t => t.length > 1)
    .filter((t, i) => !(linkingVerbAfterYou && i === 1 && t.toLowerCase() === 'are'))
    .filter(t => !skippedByCode(t) && !auditTokens.has(t.toLowerCase()))
  for (const word of unaudited) added.push(`${word} (not audited)`)
  // A flag that is missing or not a boolean is an unanswered question, not a "no".
  const flags = raw as Record<string, unknown>
  for (const k of ['added_number', 'added_praise', 'twists_the_quote'] as const) {
    if (typeof flags[k] !== 'boolean') added.push(`(the judge did not answer ${k})`)
  }
  if (flags.twists_the_quote === true) added.push('(the clause twists what the quote says)')
  // NOT ASKED: "does the clause read as a sentence". Tried under checks version 12 and
  // withdrawn the same day. This judge failed "you run a dental practice" against "We are
  // a dental practice", which is its own prompt's example of a sound clause, and the
  // broad rung fell from 12 of 77 real prospects to 5. Whether a kind is a whole noun
  // phrase is held in code, by what the page itself writes: see kindInQuote.
  return {
    claims: words.map(w => ({ claim: w.word, supported: w.stated })),
    added_number: flags.added_number === true,
    added_praise: flags.added_praise === true,
    added_claim: words.length === 0 || added.length > 0,
    added_concepts: words.length === 0 ? ['(the judge returned no word audit)', ...added] : added,
    customers_supported: customersSupported,
    peer_group_supported: peerGroupSupported,
  }
}

/**
 * The same call for ONE clause. Kept so stored clause-and-quote pairs can be replayed
 * against the judge without paying for extraction again (scripts/run-firm-fact.ts
 * --recheck), which is how the operator's must-fail controls are run.
 */
export async function judgeFaithfulness(
  client: Anthropic,
  input: { quote: string; does: string; forWhom: string | null; peerLabel: string | null },
): Promise<{ verdict: JudgeVerdict; usage: TokenCounts | null; reason: null } | { verdict: null; usage: TokenCounts | null; reason: string }> {
  const judged = await judgeItems(client, {
    items: [{ key: 'specific', quote: input.quote, clause: input.does }],
    forWhom: input.forWhom,
    peerLabel: input.peerLabel,
  })
  if (judged.verdicts === null) return { verdict: null, usage: judged.usage, reason: judged.reason }
  return { verdict: judged.verdicts.specific!, usage: judged.usage, reason: null }
}

/**
 * Post-call reconciliation (layer 3). Prices what was actually used at full price; over
 * the ceiling, the fact is discarded whatever the checks said.
 */
function finish(record: FirmFactRecord, extraction: TokenCounts | null, judge: TokenCounts | null): FirmFactOutcome {
  record.cost_usd_full_price = actualFirmFactCostUsd(extraction, judge)
  if (record.cost_usd_full_price > FIRM_FACT_CEILING_USD) {
    record.passed = false
    record.reason = 'cost_ceiling_exceeded_after_call'
  }
  return { record, usage: { extraction, judge } }
}

async function countInputTokens(client: Anthropic, model: string, system: string, user: string): Promise<number | null> {
  try {
    const r = await client.messages.countTokens({ model, system, messages: [{ role: 'user', content: user }] })
    return r.input_tokens
  } catch (err) {
    // Uncountable means unknown cost, and unknown cost is not submitted.
    logger.warn('firm-fact: token count failed', { error: String(err) })
    return null
  }
}

// ─── The database side ────────────────────────────────────────────────────────

/**
 * The newest research row for this prospect that holds usable website text, within the
 * age cap. NOT the prospect's current row: 31 of 48 measured prospects had their text in an
 * OLDER row, because the current row reused stored findings (Measured, 30 September).
 */
export async function loadFirmFactSource(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
  now: Date = new Date(),
): Promise<FirmFactSource | null> {
  const since = new Date(now.getTime() - SOURCE_MAX_AGE_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from('prospect_research_results')
    .select('id, created_at, raw_website')
    .eq('organisation_id', organisationId)
    .eq('prospect_id', prospectId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw new Error(`firm-fact: reading research rows failed: ${error.message}`)
  for (const row of (data ?? []) as Array<{ id: string; created_at: string; raw_website: { available?: boolean; content?: string; url?: string } | null }>) {
    const w = row.raw_website
    if (w?.available === true && typeof w.content === 'string' && w.content.trim().length >= 200) {
      return { text: w.content, url: w.url ?? null, fetched_at: row.created_at, research_result_id: row.id }
    }
  }
  return null
}

/** Is extraction allowed at all? A missing or unreadable flag means no (fail closed). */
export async function firmFactExtractionAllowed(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.from('system_flags').select('enabled').eq('key', FIRM_FACT_FLAG_KEY).maybeSingle()
  if (error) {
    logger.warn('firm-fact: could not read the extraction flag, not extracting', { error: error.message })
    return false
  }
  return data?.enabled === true
}

export type FirmFactRunResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; outcome: FirmFactOutcome; persisted: boolean }

/**
 * Run the tier for one prospect: gates, source, extraction, verdict, storage.
 *
 * `persist` false is a DRY RUN: the extraction is paid for and returned, the usage IS
 * recorded (money was spent), and the prospect row is not touched. Used for the reading
 * report on prospects already uploaded, whose row must not change.
 */
export async function runFirmFactForProspect(input: {
  supabase: SupabaseClient
  apiKey: string
  organisationId: string
  prospectId: string
  peerGroups: readonly PeerGroupOption[]
  /** clientGenericWords(brief): what names nothing on this client's list. */
  genericWords: ReadonlySet<string>
  persist: boolean
  usagePath: 'cli' | 'inline' | 'queue' | 'collect'
  force?: boolean
}): Promise<FirmFactRunResult> {
  const { supabase, organisationId, prospectId } = input
  const { data: prospect, error } = await supabase
    .from('prospects')
    .select('id, company_name, personalisation_trigger, outbound_upload_status, firm_fact')
    .eq('organisation_id', organisationId)
    .eq('id', prospectId)
    .maybeSingle()
  if (error || !prospect) return { status: 'skipped', reason: 'prospect_not_found' }
  const p = prospect as { company_name: string | null; personalisation_trigger: string | null; outbound_upload_status: string | null; firm_fact: unknown }

  // Template-bound only: a prospect with a researched trigger never reaches this tier.
  if (p.personalisation_trigger?.trim()) return { status: 'skipped', reason: 'has_research_trigger' }
  if (input.persist && p.outbound_upload_status && p.outbound_upload_status !== 'pending') {
    return { status: 'skipped', reason: 'already_uploaded' }
  }
  // A PAID attempt is never repeated. A free one (no website text, identity mismatch, an
  // unusable page) cost nothing, and a later research run may bring a page that works, so
  // it may run again.
  // ...and only under the CURRENT checks: a verdict from an older version of the checks is
  // not a verdict any more, so that prospect may be extracted again.
  const prior = p.firm_fact as { cost_usd_full_price?: unknown; version?: unknown } | null
  const priorCost = prior?.cost_usd_full_price
  if (
    input.persist && prior && !input.force &&
    prior.version === FIRM_FACT_CHECKS_VERSION && typeof priorCost === 'number' && priorCost > 0
  ) {
    return { status: 'skipped', reason: 'already_attempted' }
  }
  if (!p.company_name?.trim()) return { status: 'skipped', reason: 'no_company_name' }
  if (!(await firmFactExtractionAllowed(supabase))) return { status: 'skipped', reason: 'extraction_halted' }

  const source = await loadFirmFactSource(supabase, organisationId, prospectId)
  const client = new Anthropic({ apiKey: input.apiKey, timeout: 60_000, maxRetries: 1 })
  const outcome = source
    ? await extractFirmFact({ client, companyName: p.company_name, source, peerGroups: input.peerGroups, genericWords: input.genericWords })
    : { record: emptyRecord('no_website_text'), usage: { extraction: null, judge: null } }

  // Usage first: the money is spent whether or not the row is written.
  if (outcome.usage.extraction || outcome.usage.judge) {
    const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 }
    const { error: usageError } = await supabase.from('research_usage').insert({
      organisation_id: organisationId,
      prospect_id: prospectId,
      research_result_id: null,
      arm: 'firm_fact',
      path: input.usagePath,
      synthesis: zero,
      opening: zero,
      followups: null,
      web_search: { input_tokens: 0, output_tokens: 0, model: null, search_count: 0 },
      synthesis_batched: false,
      firm_fact: {
        extraction: outcome.usage.extraction,
        extraction_model: FIRM_FACT_EXTRACTION_MODEL,
        judge: outcome.usage.judge,
        judge_model: FIRM_FACT_JUDGE_MODEL,
        cost_usd_full_price: outcome.record.cost_usd_full_price,
        dry_run: !input.persist,
      },
    })
    if (usageError) logger.error('firm-fact: usage row not written', { prospect_id: prospectId, error: usageError.message })
  }

  if (outcome.record.reason === 'cost_ceiling_exceeded_after_call') {
    // The construction says this cannot happen, so an assumption is wrong. Stop everything.
    logger.error('firm-fact: actual cost exceeded the per-prospect ceiling; extraction halted for every client', {
      prospect_id: prospectId,
      cost_usd_full_price: outcome.record.cost_usd_full_price,
      ceiling_usd: FIRM_FACT_CEILING_USD,
    })
    await supabase.from('system_flags').update({
      enabled: false,
      updated_by: 'firm-fact reconciliation',
      note: `halted ${new Date().toISOString()}: prospect ${prospectId} cost $${outcome.record.cost_usd_full_price.toFixed(4)}`,
    }).eq('key', FIRM_FACT_FLAG_KEY).select('key')
  }

  let persisted = false
  if (input.persist) {
    const { error: writeError } = await supabase
      .from('prospects')
      .update({ firm_fact: outcome.record })
      .eq('organisation_id', organisationId)
      .eq('id', prospectId)
      .eq('outbound_upload_status', 'pending')
    if (writeError) logger.error('firm-fact: record not written', { prospect_id: prospectId, error: writeError.message })
    else persisted = true
  }
  return { status: 'done', outcome, persisted }
}

/**
 * The research pipeline's entry point: called once a prospect's research is stored, on
 * both the inline and the batch-collect paths.
 *
 * Runs only when ALL hold: the opening was not written (the prospect is headed to the
 * template), and the client's messaging document has firm_fact_tier.enabled with a valid
 * brief. When the tier is off, nothing is submitted and nothing is spent (Round 4,
 * decision 3).
 *
 * NEVER THROWS. Research has already been paid for and stored by the time this runs; a
 * failure here must cost the prospect its firm fact, never its research.
 */
export async function maybeRunFirmFactAfterResearch(input: {
  supabase: SupabaseClient
  apiKey: string
  organisationId: string
  prospectId: string
  messagingContent: unknown
  openingWritten: boolean
  usagePath: 'cli' | 'inline' | 'queue' | 'collect'
  /** The client is on writer v2: the firm fact feeds its semi-personalised tier, so it is
   *  extracted whatever the old path's firm_fact_tier switch says. */
  writerV2Enabled?: boolean
}): Promise<void> {
  try {
    if (input.openingWritten) return
    const content = (input.messagingContent ?? {}) as Record<string, unknown>
    if (!input.writerV2Enabled && (content.firm_fact_tier as { enabled?: unknown } | undefined)?.enabled !== true) return
    const read = readBrief(content)
    if (!read.brief) {
      // The tier is switched ON and there is no usable brief. Silent, this read as "nothing
      // to extract" for every prospect of the client.
      logger.warn('firm-fact: the tier is on and the outbound brief is missing or not valid; nothing extracted', {
        organisation_id: input.organisationId, brief_present: read.present, problems: read.problems,
      })
      return
    }
    const brief = read.brief
    const result = await runFirmFactForProspect({
      supabase: input.supabase,
      apiKey: input.apiKey,
      organisationId: input.organisationId,
      prospectId: input.prospectId,
      peerGroups: brief.peer_groups.map(p => ({ id: p.id, label: p.label })),
      genericWords: clientGenericWords(brief),
      persist: true,
      usagePath: input.usagePath,
    })
    logger.info('firm-fact: after research', {
      prospect_id: input.prospectId,
      status: result.status,
      ...(result.status === 'skipped' ? { reason: result.reason } : {
        passed: result.outcome.record.passed,
        reason: result.outcome.record.reason,
        cost_usd_full_price: result.outcome.record.cost_usd_full_price,
      }),
    })
  } catch (err) {
    logger.warn('firm-fact: after-research step failed; the prospect keeps the template', {
      prospect_id: input.prospectId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
