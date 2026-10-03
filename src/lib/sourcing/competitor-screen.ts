// The competitor screen: a prospect that sells what the client sells is not a buyer.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR
//
// Operator rule 7 of the second reading (2026-10-01). Each client's outbound brief lists
// COMPETITOR CATEGORIES: kinds of company that sell the same service the client sells. A
// prospect in one of them is excluded BEFORE research is paid for. Writing to a competitor
// costs the research, the sending slot and a reply that is at best a polite no.
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO STEPS, AND WHY THE FIRST ONE CANNOT DECIDE ALONE
//
//   1. PHRASES, in code, free. Each category carries phrases. They are looked for in what
//      the data provider records about the company: its name, its industry labels, and
//      EVERY tag it is listed under. A company with no phrase is never judged, never
//      written to, and never costs a model call.
//
//   2. ONE MODEL QUESTION, only for a company that carried a phrase: does this company
//      sell the category's service as a core part of its business. The model is shown the
//      provider's record AND the top of the company's own homepage (research text already
//      on file, else a free fetch made for this check). The phrase alone cannot answer that, and getting it wrong in
//      the wide direction removes buyers. Measured on the live client 2026-10-01: 44 of 660
//      prospects carry a phrase from the category list, and only 5 carry three or more. A
//      general agency lists the service among fifty other tags; the brief says in `not_this`
//      that such a company STAYS in scope. Excluding on the phrase would have removed it.
//
// The model is asked for evidence copied from what it was shown, and CODE checks the copy.
// A "yes" must rest on at least two different pieces that code found AND that say the
// category's work: a label or tag carrying one of the category's phrases, or a run of words
// from the homepage. Otherwise it stands as "unclear", which stays in scope.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE OUTCOMES FOR A JUDGED COMPANY, AND WHICH WAY EACH ONE FAILS
//
//   excluded   the model said yes, with enough evidence found by code. The prospect loses
//              its tier (sourced_tier NULL, tiering_reason 'competitor'), which is the shape
//              every paid stage already refuses. See tier-verdict.ts.
//   clear      the model said no, or said it could not tell, or said yes and could not show
//              enough for it. UNCLEAR STAYS IN SCOPE, on purpose: the operator's stated
//              risk is a category drawn too wide.
//   held       no usable verdict came back: the call failed, the reply did not parse, this
//              run's call budget ran out, or the homepage could not be read on the FIRST
//              try. The prospect is NOT researched this run, and the next run asks again.
//              A missing verdict never reads as "not a competitor".
//
// THE HOMEPAGE GETS ONE RETRY. Measured 2026-10-01: judged on the provider's record alone,
// the screen excluded nobody; every exclusion rests mainly on the homepage. So a "no" given
// without the homepage is weak, and storing it would clear a competitor for good because a
// fetch failed once. The first such "no" is held and a marker is left on the row. On the
// next run, if the homepage still cannot be read, the record-only answer is accepted: a
// site that never loads must not hold a buyer forever.
//
// ═════════════════════════════════════════════════════════════════════════════
// A VERDICT IS FROZEN, SO IT SAYS WHAT IT WAS JUDGED AGAINST
//
// The stored check carries a fingerprint of the category list. A stored verdict is reused
// only while the list is unchanged; editing a category, its phrases or its `not_this`
// retires it and the company is judged again. Without that, narrowing a category would
// leave every earlier exclusion standing with nothing to say so (ADR-034, ADR-037).
//
// An excluded prospect is no longer selected for research, so nothing here reaches it
// again by itself. scripts/run-competitor-screen.ts --rescreen-excluded does. Under a
// changed list an excluded prospect is RESTORED in two ways: it still carries a phrase and
// the model now answers no, or it carries no phrase any more, because the phrase or the
// whole category was taken off the list. The second needs no model. Either way its removal
// reason is cleared and the next tiering run gives it a tier again.
//
// ═════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC OR MODEL (ADR-018)
//
// The phrase step is deterministic. The main-business question is a reading of a noisy
// record and is the one place a model is used: claude-haiku-4-5, temperature 0, one call
// per company that carried a phrase, never repeated under the same list.

import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { readCompetitorCategories, type CompetitorCategory } from '@/lib/outbound-brief/brief'
import { COMPETITOR_REMOVAL_REASON, isCompetitorExcluded } from './competitor-verdict'
import { decodePageText, unusablePageReason } from '@/lib/agents/research/firm-fact-checks'
import { loadFirmFactSource } from '@/lib/agents/research/firm-fact'
import { fetchHomepageText } from '@/lib/agents/research/sources/website'

export { COMPETITOR_REMOVAL_REASON, isCompetitorExcluded }

/** Bump when a change to this file changes what a stored verdict means. */
export const COMPETITOR_SCREEN_VERSION = 1

export const COMPETITOR_JUDGE_MODEL = 'claude-haiku-4-5-20251001'
export const COMPETITOR_JUDGE_MAX_TOKENS = 220
/** Measured maximum is 113 tags on one company. The cap bounds the input, nothing more. */
export const TAGS_SHOWN_MAX = 150
/** How much of the company's own homepage the model is shown. The top of a homepage says what a company sells. */
export const SITE_TEXT_SHOWN_CHARS = 2_500
/** The shortest piece of homepage text that counts as evidence, in words. One word proves nothing. */
export const SITE_EVIDENCE_MIN_WORDS = 3
/**
 * The most model questions one run asks. A run that meets more companies carrying a phrase
 * HOLDS the rest: they are not researched this run and are asked about on the next one.
 * It bounds the time a screen can add in front of an operator's click.
 */
export const MAX_JUDGE_CALLS_PER_RUN = 60
const JUDGE_CONCURRENCY = 5


// ─── What the provider records about a company ───────────────────────────────

export interface CompanyRecord {
  name: string | null
  industry: string | null
  other_industries: string[]
  /** EVERY tag on file. Not the first 25 the research judge is shown. */
  tags: string[]
}

export interface CompetitorScreenRow {
  id: string
  company_name?: string | null
  company_industry?: string | null
  website_url?: string | null
  apollo_enrichment_data?: unknown
  competitor_check?: unknown
  outbound_upload_status?: string | null
  tiering_reason?: string | null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter((s): s is string => s !== null) : [])

function distinct(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter(v => (seen.has(v.toLowerCase()) ? false : (seen.add(v.toLowerCase()), true)))
}

/**
 * The record for one prospect row, or null when the provider holds nothing about the
 * company. NULL MEANS "CANNOT BE SCREENED", and the caller counts it; it never means "not
 * a competitor".
 *
 * Reads the stored enrichment directly, not through companyFactsFromRow: that reader keeps
 * the first 25 tags of a measured median of 53, so a phrase at position 26 would be
 * invisible through it.
 */
export function companyRecordFromRow(row: CompetitorScreenRow): CompanyRecord | null {
  const stored = row.apollo_enrichment_data
  const org = stored && typeof stored === 'object'
    ? ((stored as Record<string, unknown>).organization as Record<string, unknown> | undefined) ?? null
    : null
  const industry = text(row.company_industry)
  const listed = distinct([...strings(org?.industries), ...strings(org?.secondary_industries)])
  const record: CompanyRecord = {
    name: text(row.company_name),
    industry,
    other_industries: industry ? listed.filter(i => i.toLowerCase() !== industry.toLowerCase()) : listed,
    tags: distinct(strings(org?.keywords)),
  }
  const empty = !record.name && !record.industry && record.other_industries.length === 0 && record.tags.length === 0
  return empty ? null : record
}

// ─── Step 1: phrases, in code ────────────────────────────────────────────────

/** Lower case, every run of anything that is not a letter or digit becomes one space. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export interface PhraseHit {
  category_id: string
  phrase: string
  /** The name, label or tag it was found in, as recorded. */
  found_in: string
}

/**
 * Every place a category phrase appears in the record, as WHOLE WORDS.
 *
 * Whole words because a phrase is matched inside tags the provider wrote: "testing" must
 * not be found in "contesting". Hyphens and case are folded, so "Vehicle-Repair" meets the
 * phrase "vehicle repair".
 */
export function findPhraseHits(record: CompanyRecord, categories: readonly CompetitorCategory[]): PhraseHit[] {
  const fields = [record.name, record.industry, ...record.other_industries, ...record.tags]
    .filter((f): f is string => typeof f === 'string' && f.trim() !== '')
  const hits: PhraseHit[] = []
  for (const category of categories) {
    for (const phrase of category.phrases) {
      const needle = normalise(phrase)
      if (!needle) continue
      for (const field of fields) {
        if (` ${normalise(field)} `.includes(` ${needle} `)) {
          hits.push({ category_id: category.id, phrase, found_in: field })
          break   // one hit per phrase is enough; the count of PHRASES is what is reported
        }
      }
    }
  }
  return hits
}

/**
 * What a stored verdict was judged against. Any change to a category's wording, phrases or
 * `not_this`, or to this file's version, produces a different value and retires the verdict.
 */
export function categoriesFingerprint(categories: readonly CompetitorCategory[]): string {
  const stable = [...categories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(c => ({
      id: c.id,
      statement: c.statement.trim(),
      phrases: [...c.phrases].map(p => normalise(p)).sort(),
      not_this: (c.not_this ?? '').trim(),
    }))
  return createHash('sha256')
    .update(JSON.stringify({ version: COMPETITOR_SCREEN_VERSION, categories: stable }))
    .digest('hex')
    .slice(0, 16)
}

// ─── The stored verdict ──────────────────────────────────────────────────────

export interface CompetitorCheck {
  version: number
  fingerprint: string
  checked_at: string
  outcome: 'excluded' | 'clear'
  /** The model's own word: yes, no or unclear. `unclear` is stored as outcome clear. */
  in_category: 'yes' | 'no' | 'unclear'
  /** The category that said yes, or the first one asked when none did. */
  category_id: string
  /** Every category the model was asked about for this verdict. */
  categories_asked: string[]
  phrase_hits: string[]
  main_business: string | null
  /** What the answer rests on, each piece found by code and saying the category's work. */
  evidence: string[]
  /** The model said yes and code found too little of its evidence, so it stands as unclear. */
  downgraded: boolean
  /** Where the homepage text came from: research already on file, a fetch made for this check, or none. */
  site_text: 'stored' | 'fetched' | 'none'
  /** True when an earlier exclusion was lifted because the company carries no phrase any more. */
  restored?: boolean
  model: string
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * Left on a row when the first answer was "not a competitor" and the homepage could not be
 * read. NOT a verdict: storedVerdictFor rejects it and tiering ignores it. It records only
 * that one attempt without the homepage has been made under this list, so the next one may
 * stand. See THE HOMEPAGE GETS ONE RETRY in the header.
 */
export interface PendingSiteMarker {
  version: number
  fingerprint: string
  checked_at: string
  outcome: 'pending_site'
}

function hasPendingSiteMarker(check: unknown, fingerprint: string): boolean {
  if (!check || typeof check !== 'object') return false
  const c = check as Partial<PendingSiteMarker>
  return c.outcome === 'pending_site' && c.version === COMPETITOR_SCREEN_VERSION && c.fingerprint === fingerprint
}

/**
 * The stored verdict when it was judged against THIS list and covers THESE categories,
 * else null.
 *
 * `hitCategoryIds` is every category whose phrases the company carries now. A stored
 * "clear" is reused only when the model was asked about all of them: a company cleared on
 * one category has not been cleared on another. An exclusion needs no such test, because one
 * yes is enough.
 */
export function storedVerdictFor(check: unknown, fingerprint: string, hitCategoryIds: readonly string[] = []): CompetitorCheck | null {
  if (!check || typeof check !== 'object') return null
  const c = check as Partial<CompetitorCheck>
  if (c.version !== COMPETITOR_SCREEN_VERSION || c.fingerprint !== fingerprint) return null
  if (c.outcome !== 'excluded' && c.outcome !== 'clear') return null
  if (c.outcome === 'clear') {
    const asked = Array.isArray(c.categories_asked) ? c.categories_asked : (c.category_id ? [c.category_id] : [])
    if (!hitCategoryIds.every(id => asked.includes(id))) return null
  }
  return c as CompetitorCheck
}

// ─── Step 2: one model question per category ─────────────────────────────────

/** The most pieces of evidence the model is asked for, and the longest each may be. They keep a "yes" inside the reply's token limit. */
export const EVIDENCE_MAX_ITEMS = 4
export const EVIDENCE_MAX_WORDS = 15

export const COMPETITOR_JUDGE_SYSTEM_PROMPT = `You decide whether a company sells a given category of service as a core part of its own business.

You are shown:
- CATEGORY: the kind of company in question.
- NOT IN THE CATEGORY: neighbouring kinds of company that are outside it, when any are named.
- RECORD: what a data provider holds about one company: its name, its industry labels and the tags it is listed under.
- FROM THE COMPANY'S OWN WEBSITE: the top of its homepage, when it could be read.

How to decide:
- What the company says about itself on its own website outweighs the provider's tags. A homepage that says the company does the category's work for its customers is the strongest evidence there is.
- Tags are noisy. A company is listed under many things it touches, uses, advises on or offers on the side. One tag naming the category does not put the company in it.
- The company is IN the category when doing the category's work for its own customers is its main business, or one of a small number of main service lines.
- The company is NOT in the category when the category is mentioned once or twice among many other services.
- The company is NOT in the category when it advises on, trains people in, or sells tools for the category's work, and nothing shows it doing that work for customers.
- A company that fits the NOT IN THE CATEGORY description is NOT in the category.
- When what you are shown does not let you tell, answer "unclear". Do not guess.

Reply with JSON only, no other text:
{"main_business": "<what the company mainly sells, in eight words or fewer>", "in_category": "yes" | "no" | "unclear", "evidence": ["<copied exactly>"]}

"evidence" lists what shows the company doing the category's work for customers. Each item is copied exactly and is one of two things: a label, a tag or the company name THAT NAMES THE CATEGORY'S WORK, or a run of consecutive words from the website text. A tag about something else is not evidence, and neither is a name that does not name the work. Give at most ${EVIDENCE_MAX_ITEMS} items, each at most ${EVIDENCE_MAX_WORDS} words. For "yes" give at least two different items. For "no" or "unclear" it may be empty.`

export function buildCompetitorJudgeMessage(record: CompanyRecord, category: CompetitorCategory, siteText: string | null = null): string {
  const tags = record.tags.slice(0, TAGS_SHOWN_MAX)
  const lines = [
    `CATEGORY: ${category.statement.trim()}`,
    `NOT IN THE CATEGORY: ${category.not_this?.trim() || '(none named)'}`,
    '',
    'RECORD',
    `Name: ${record.name ?? '(not recorded)'}`,
    `Industry: ${record.industry ?? '(not recorded)'}`,
  ]
  if (record.other_industries.length) lines.push(`Also listed under: ${record.other_industries.join(', ')}`)
  lines.push(
    tags.length
      ? `Tags (${tags.length}${record.tags.length > tags.length ? ` of ${record.tags.length}` : ''}): ${tags.join(', ')}`
      : 'Tags: (none recorded)',
  )
  lines.push('', "FROM THE COMPANY'S OWN WEBSITE", siteText ? siteText.slice(0, SITE_TEXT_SHOWN_CHARS) : '(could not be read)')
  return lines.join('\n')
}

export interface JudgeReply {
  in_category: 'yes' | 'no' | 'unclear'
  main_business: string | null
  /** Only the cited parts that code FOUND and that count. See readJudgeReply. */
  evidence: string[]
  /** True when the model said yes and could not show enough for it. */
  downgraded: boolean
}

/**
 * How many different pieces a "yes" must rest on, each found by code.
 *
 * Two, because one is the phrase that got the company asked about in the first place. A
 * general firm carries the phrase once among fifty tags; a company that does the work as a
 * main line says so in several places.
 */
export const MIN_EVIDENCE_FOR_YES = 2

/** Does this label, tag or name carry one of the category's phrases, as whole words? */
function carriesPhrase(normalisedField: string, category: CompetitorCategory): boolean {
  return category.phrases.some(phrase => {
    const needle = normalise(phrase)
    return needle !== '' && ` ${normalisedField} `.includes(` ${needle} `)
  })
}

/**
 * Reads the model's reply. null when it is not a usable verdict at all.
 *
 * The model's word is not taken for what the company is. Each piece of evidence is looked
 * for by code, and it COUNTS only when it is one of two things:
 *
 *   - a label, a tag or the company name that is in the record AND carries one of the
 *     category's phrases. A tag that merely exists proves nothing about the category: the
 *     first version counted any tag in the record, so "batteries" beside the one phrase tag
 *     made two pieces, and the rule could never fire on the case it was written for.
 *   - a run of at least three consecutive words found in the homepage text the model was
 *     shown.
 *
 * Pieces are counted once, on their folded form, so the same tag cited twice in two
 * spellings is one piece.
 *
 * THE LIMIT, STATED. A tag that names the category's work in words that are not on the
 * brief's phrase list does not count. A real competitor described that way, with a homepage
 * that cannot be read, stands as "unclear" and stays in scope. That is the direction the
 * operator asked for; the remedy is to add the phrase to the brief.
 */
export function readJudgeReply(
  raw: string,
  record: CompanyRecord,
  category: CompetitorCategory,
  siteText: string | null = null,
): JudgeReply | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const reply = parsed as Record<string, unknown>
  const answer = reply.in_category
  if (answer !== 'yes' && answer !== 'no' && answer !== 'unclear') return null

  const fields = new Set(
    [record.name, record.industry, ...record.other_industries, ...record.tags]
      .filter((f): f is string => typeof f === 'string')
      .map(normalise),
  )
  // The website text the model was actually shown, and no more of it.
  const site = siteText ? ` ${normalise(siteText.slice(0, SITE_TEXT_SHOWN_CHARS))} ` : null
  const counted = new Map<string, string>()   // folded form -> as cited
  for (const cited of strings(reply.evidence)) {
    const n = normalise(cited)
    if (n === '' || counted.has(n)) continue
    const inRecord = fields.has(n) && carriesPhrase(n, category)
    const inSite = site !== null && n.split(' ').length >= SITE_EVIDENCE_MIN_WORDS && site.includes(` ${n} `)
    if (inRecord || inSite) counted.set(n, cited)
  }
  const evidence = [...counted.values()]
  // A "yes" that cannot show enough is not a yes. It is recorded as "unclear", which stays
  // in scope, and NOT as "no verdict": a held prospect is asked about again on every run,
  // and a model that answers the same way each time would leave it permanently neither
  // researched nor excluded.
  if (answer === 'yes' && evidence.length < MIN_EVIDENCE_FOR_YES) {
    return { in_category: 'unclear', main_business: text(reply.main_business), evidence, downgraded: true }
  }
  return { in_category: answer, main_business: text(reply.main_business), evidence, downgraded: false }
}

/** The one method of the SDK client this file uses, so a test can stand one in. */
export interface CompetitorJudgeClient {
  messages: {
    create(body: {
      model: string
      max_tokens: number
      temperature: number
      system: string
      messages: Array<{ role: 'user'; content: string }>
    }): Promise<{
      content: Array<{ type: string; text?: string }>
      usage: { input_tokens: number; output_tokens: number }
      stop_reason?: string | null
    }>
  }
}

type Usage = { input_tokens: number; output_tokens: number }

/**
 * One question about one company and one category. null when no usable verdict came back.
 *
 * A REPLY CUT OFF AT THE TOKEN LIMIT IS ASKED AGAIN ONCE, WITH ROOM. A cut-off reply has no
 * closing brace, so it reads as no verdict, the prospect is held, and at temperature 0 the
 * next run asks the same question and is cut off at the same place: a prospect held on
 * every run with nothing to break the loop. The usage of both calls is returned, because
 * both were billed.
 */
async function judgeCompany(
  client: CompetitorJudgeClient,
  record: CompanyRecord,
  category: CompetitorCategory,
  siteText: string | null,
): Promise<{ reply: JudgeReply | null; usage: Usage }> {
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }
  try {
    for (const maxTokens of [COMPETITOR_JUDGE_MAX_TOKENS, COMPETITOR_JUDGE_MAX_TOKENS * 2]) {
      const response = await client.messages.create({
        model: COMPETITOR_JUDGE_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system: COMPETITOR_JUDGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildCompetitorJudgeMessage(record, category, siteText) }],
      })
      usage.input_tokens += response.usage.input_tokens
      usage.output_tokens += response.usage.output_tokens
      if (response.stop_reason === 'max_tokens') continue
      const raw = response.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')
      return { reply: readJudgeReply(raw, record, category, siteText), usage }
    }
    logger.warn('competitor-screen: the reply was cut off twice; the prospect is held, not passed', { category_id: category.id })
    return { reply: null, usage }
  } catch (err) {
    logger.warn('competitor-screen: the model call failed; the prospect is held, not passed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { reply: null, usage }
  }
}

// ─── The screen ──────────────────────────────────────────────────────────────

export type ScreenOutcome = 'no_phrase' | 'unscreenable' | 'clear' | 'excluded' | 'held'

export interface ScreenDetail {
  prospect_id: string
  outcome: ScreenOutcome
  category_id: string | null
  phrase_hits: string[]
  main_business: string | null
  evidence: string[]
  /** The model's own word, or null where no model was asked. */
  in_category: 'yes' | 'no' | 'unclear' | null
  /** True when the verdict came from the row and no model was asked this run. */
  from_stored: boolean
  held_reason: 'no_verdict' | 'call_budget' | 'no_api_key' | 'site_unreadable' | null
  /** True when an earlier exclusion was lifted this run. */
  restored?: boolean
}

export interface CompetitorScreenResult {
  ok: true
  /** False when the client's messaging document names no competitor list: nothing was screened. */
  screened: boolean
  /** Ids free to be researched: no phrase, cannot be screened, or judged clear. */
  cleared: string[]
  excluded: string[]
  /** No verdict this run. NOT researched, and asked about again next time. */
  held: string[]
  /** Earlier exclusions lifted this run. A subset of `cleared`. */
  restored: string[]
  unscreenable: number
  judge_calls: number
  usage: Usage
  details: ScreenDetail[]
  problems: string[]
}

export type CompetitorScreenOutcome = CompetitorScreenResult | { ok: false; error: string }

export interface CompetitorScreenInput {
  supabase: SupabaseClient
  organisationId: string
  prospectIds: string[]
  /**
   * The client's ACTIVE messaging document content, when the caller already holds it.
   * Omitted, the screen reads it. The competitor list is read from the live document and
   * never from a pending suggestion: a list nobody approved must not remove anybody.
   */
  messagingContent?: unknown
  /** Write verdicts and exclusions. False is a dry run: every answer, no write. */
  persist: boolean
  apiKey?: string | null
  client?: CompetitorJudgeClient
  maxJudgeCalls?: number
  /** Judge again even where a verdict under this list is stored. Used by the script. */
  ignoreStored?: boolean
  /**
   * How the homepage text of a company about to be judged is obtained. The default reads
   * research already on file and otherwise fetches the homepage. A test supplies its own.
   */
  loadSiteText?: SiteTextLoader
}

export type SiteTextLoader = (row: CompetitorScreenRow) => Promise<{ text: string; origin: 'stored' | 'fetched' } | null>

/**
 * What the company says about itself: the website text research already holds for this
 * prospect, else the homepage, fetched now. null when neither can be read. NEVER THROWS.
 *
 * WHY THE SCREEN READS A WEBSITE AT ALL. The first version judged the provider's record
 * only, and on 2026-10-01 it cleared the one firm the operator had flagged: its record
 * carries the category's phrase once among general tags, while its own homepage says in a
 * sentence that it sells exactly that. The record says what a company is listed under. The
 * homepage says what it sells.
 *
 * It costs nothing: the fetch is the same free one research uses, and it is made only for
 * a company that carried a phrase, which is a few per run.
 */
function defaultSiteTextLoader(supabase: SupabaseClient, organisationId: string): SiteTextLoader {
  return async row => {
    try {
      const onFile = await loadFirmFactSource(supabase, organisationId, row.id)
      if (onFile) {
        const page = decodePageText(onFile.text)
        if (unusablePageReason(page) === null) return { text: page, origin: 'stored' }
      }
    } catch {
      // Falls through to a fetch. A research row that cannot be read is not a reason to
      // judge without the homepage.
    }
    const enrichment = row.apollo_enrichment_data
    const org = enrichment && typeof enrichment === 'object'
      ? ((enrichment as Record<string, unknown>).organization as Record<string, unknown> | undefined) ?? null
      : null
    const url = text(row.website_url) ?? text(org?.website_url)
    if (!url) return null
    const fetched = await fetchHomepageText(url)
    if (!fetched) return null
    const page = decodePageText(fetched)
    return unusablePageReason(page) === null ? { text: page, origin: 'fetched' } : null
  }
}

async function loadActiveMessagingContent(supabase: SupabaseClient, organisationId: string): Promise<unknown | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('content')
    .eq('organisation_id', organisationId)
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`could not read the messaging document: ${error.message}`)
  const rows = (data ?? []) as Array<{ content: unknown }>
  return rows.length > 0 ? rows[0].content : null
}

interface ToJudge {
  row: CompetitorScreenRow
  record: CompanyRecord
  /** Categories whose phrases the company carries, most phrases first. Asked in this order. */
  categories: Array<{ category: CompetitorCategory; phrases: string[] }>
}

const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 }

/**
 * Screens a selection of prospects before research. NEVER THROWS: a fault is returned as
 * `ok: false` with a sentence, and the caller refuses the run with it. A screen that could
 * not look is not a screen that found nothing.
 *
 * THREE STATES OF THE LIST, and they are not the same:
 *
 *   no list in the document         the client has nothing to screen for. Every id comes
 *                                   back cleared, no row is read and no model is asked.
 *   a list, with nothing usable     REFUSED. Somebody wrote a list and none of it can be
 *                                   applied. Passing the run would research every company
 *                                   the list was written to stop, with a warning in a log.
 *   a list, empty and well-formed   screened against nothing: nobody is excluded, and a
 *                                   prospect excluded under an earlier list is restored.
 */
export async function screenCompetitors(input: CompetitorScreenInput): Promise<CompetitorScreenOutcome> {
  const { supabase, organisationId, prospectIds, persist } = input
  const empty: CompetitorScreenResult = {
    ok: true, screened: false, cleared: [...prospectIds], excluded: [], held: [], restored: [],
    unscreenable: 0, judge_calls: 0, usage: { ...ZERO_USAGE }, details: [], problems: [],
  }
  if (prospectIds.length === 0) return empty

  try {
    const content = input.messagingContent !== undefined
      ? input.messagingContent
      : await loadActiveMessagingContent(supabase, organisationId)
    const read = readCompetitorCategories(content)
    if (!read.present) return empty
    if (read.categories.length === 0 && read.problems.length > 0) {
      return {
        ok: false,
        error: `The competitor list in the outbound brief cannot be used, so nobody can be checked against it: ${read.problems.join('; ')}.`,
      }
    }
    if (read.problems.length > 0) {
      logger.warn('competitor-screen: a competitor category in the brief is not usable and was skipped', {
        organisation_id: organisationId, problems: read.problems,
      })
    }

    const categories = read.categories
    const fingerprint = categoriesFingerprint(categories)
    const byId = new Map(categories.map(c => [c.id, c]))

    // Read in pages: an id list in a URL has a length limit, and a selection can be 5,000.
    const rows: CompetitorScreenRow[] = []
    for (let i = 0; i < prospectIds.length; i += 200) {
      const { data, error } = await supabase
        .from('prospects')
        .select('id, company_name, company_industry, website_url, apollo_enrichment_data, competitor_check, outbound_upload_status, tiering_reason')
        .eq('organisation_id', organisationId)
        .in('id', prospectIds.slice(i, i + 200))
      if (error) return { ok: false, error: `Could not read the selection to check it for competitors: ${error.message}` }
      rows.push(...((data ?? []) as CompetitorScreenRow[]))
    }
    const rowById = new Map(rows.map(r => [r.id, r]))

    const details: ScreenDetail[] = []
    const toJudge: ToJudge[] = []
    const toRestore: CompetitorScreenRow[] = []
    let unscreenable = 0
    const blank = { category_id: null, phrase_hits: [] as string[], main_business: null, evidence: [] as string[], in_category: null, from_stored: false, held_reason: null }

    for (const id of prospectIds) {
      const row = rowById.get(id)
      const record = row ? companyRecordFromRow(row) : null
      if (!row || !record) {
        unscreenable++
        details.push({ prospect_id: id, outcome: 'unscreenable', ...blank })
        continue
      }
      const hits = findPhraseHits(record, categories)
      if (hits.length === 0) {
        // NO PHRASE NOW, AND EXCLUDED BEFORE: the phrase or the category that excluded this
        // company has been taken off the list. Nothing else would ever lift the exclusion,
        // because tiering honours a stored "excluded" whatever list it was judged against.
        if (isCompetitorExcluded(row.competitor_check)) toRestore.push(row)
        else details.push({ prospect_id: id, outcome: 'no_phrase', ...blank })
        continue
      }
      // The categories whose phrases the company carries, most phrases first.
      const phrasesBy = new Map<string, string[]>()
      for (const h of hits) phrasesBy.set(h.category_id, [...(phrasesBy.get(h.category_id) ?? []), h.phrase])
      const ordered = [...phrasesBy.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([categoryId, phrases]) => ({ category: byId.get(categoryId)!, phrases }))

      const stored = input.ignoreStored ? null : storedVerdictFor(row.competitor_check, fingerprint, ordered.map(o => o.category.id))
      if (stored) {
        details.push({
          prospect_id: id, outcome: stored.outcome, category_id: stored.category_id,
          phrase_hits: stored.phrase_hits, main_business: stored.main_business, evidence: stored.evidence,
          in_category: stored.in_category ?? null, from_stored: true, held_reason: null,
        })
        continue
      }
      toJudge.push({ row, record, categories: ordered })
    }

    // ── Restores: no model, no homepage ──────────────────────────────────────
    for (const row of toRestore) {
      const check: CompetitorCheck = {
        version: COMPETITOR_SCREEN_VERSION, fingerprint, checked_at: new Date().toISOString(),
        outcome: 'clear', in_category: 'no',
        category_id: (row.competitor_check as { category_id?: string } | null)?.category_id ?? '',
        categories_asked: [], phrase_hits: [], main_business: null, evidence: [], downgraded: false,
        site_text: 'none', restored: true, model: 'none', usage: { ...ZERO_USAGE },
      }
      if (persist && !(await writeVerdict(supabase, organisationId, row, check))) {
        // Not lifted, and said so: the exclusion still stands on the row.
        details.push({ prospect_id: row.id, outcome: 'excluded', ...blank, from_stored: true })
        continue
      }
      details.push({ prospect_id: row.id, outcome: 'clear', ...blank, restored: true })
    }

    const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null
    const client: CompetitorJudgeClient | null = input.client
      ?? (toJudge.length > 0 && apiKey ? (new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 }) as unknown as CompetitorJudgeClient) : null)
    const budget = input.maxJudgeCalls ?? MAX_JUDGE_CALLS_PER_RUN
    const loadSiteText = input.loadSiteText ?? defaultSiteTextLoader(supabase, organisationId)
    const usage: Usage = { ...ZERO_USAGE }
    let judgeCalls = 0

    const hold = (item: ToJudge, reason: NonNullable<ScreenDetail['held_reason']>) => {
      details.push({
        prospect_id: item.row.id, outcome: 'held', category_id: item.categories[0].category.id,
        phrase_hits: item.categories.flatMap(c => c.phrases), main_business: null, evidence: [],
        in_category: null, from_stored: false, held_reason: reason,
      })
    }

    const judgeOne = async (item: ToJudge): Promise<void> => {
      if (!client) { hold(item, 'no_api_key'); return }
      // Checked and counted in one synchronous step, so two companies running side by side
      // cannot both take the last question.
      if (judgeCalls >= budget) { hold(item, 'call_budget'); return }
      judgeCalls++   // the first question, reserved before anything is awaited
      const site = await loadSiteText(item.row).catch(() => null)

      // EACH CATEGORY THE COMPANY CARRIES PHRASES FOR IS ASKED ABOUT, most phrases first,
      // stopping at the first yes. The first version asked about one category only and
      // stored the "no" for the whole list, so a company that belonged to a second category
      // was cleared without ever being asked about it.
      const asked: string[] = []
      const itemUsage: Usage = { ...ZERO_USAGE }
      let last: { reply: JudgeReply; category: CompetitorCategory; phrases: string[] } | null = null
      for (const [position, { category, phrases }] of item.categories.entries()) {
        if (position > 0) {
          if (judgeCalls >= budget) { hold(item, 'call_budget'); return }
          judgeCalls++
        }
        const judged = await judgeCompany(client, item.record, category, site?.text ?? null)
        itemUsage.input_tokens += judged.usage.input_tokens
        itemUsage.output_tokens += judged.usage.output_tokens
        usage.input_tokens += judged.usage.input_tokens
        usage.output_tokens += judged.usage.output_tokens
        if (!judged.reply) { hold(item, 'no_verdict'); return }
        asked.push(category.id)
        last = { reply: judged.reply, category, phrases }
        if (judged.reply.in_category === 'yes') break
      }
      if (!last) { hold(item, 'no_verdict'); return }

      const outcome: 'excluded' | 'clear' = last.reply.in_category === 'yes' ? 'excluded' : 'clear'

      // THE HOMEPAGE GETS ONE RETRY. See the header. A "not a competitor" given without the
      // homepage is held the first time, with a marker left on the row, and accepted the
      // second time.
      if (outcome === 'clear' && site === null && !hasPendingSiteMarker(item.row.competitor_check, fingerprint)) {
        if (persist) {
          const marker: PendingSiteMarker = {
            version: COMPETITOR_SCREEN_VERSION, fingerprint, checked_at: new Date().toISOString(), outcome: 'pending_site',
          }
          const { error } = await supabase.from('prospects').update({ competitor_check: marker })
            .eq('organisation_id', organisationId).eq('id', item.row.id)
          if (error) logger.warn('competitor-screen: the retry marker was not written; the prospect is held again next run', { prospect_id: item.row.id, error: error.message })
        }
        hold(item, 'site_unreadable')
        return
      }

      const check: CompetitorCheck = {
        version: COMPETITOR_SCREEN_VERSION,
        fingerprint,
        checked_at: new Date().toISOString(),
        outcome,
        in_category: last.reply.in_category,
        category_id: outcome === 'excluded' ? last.category.id : item.categories[0].category.id,
        categories_asked: asked,
        phrase_hits: outcome === 'excluded' ? last.phrases : item.categories.flatMap(c => c.phrases),
        main_business: last.reply.main_business,
        evidence: last.reply.evidence,
        downgraded: last.reply.downgraded,
        site_text: site?.origin ?? 'none',
        model: COMPETITOR_JUDGE_MODEL,
        usage: itemUsage,
      }
      const wasExcluded = isCompetitorExcluded(item.row.competitor_check)
      if (persist && !(await writeVerdict(supabase, organisationId, item.row, check))) { hold(item, 'no_verdict'); return }
      details.push({
        prospect_id: item.row.id, outcome, category_id: check.category_id,
        phrase_hits: check.phrase_hits, main_business: check.main_business, evidence: check.evidence,
        in_category: check.in_category, from_stored: false, held_reason: null,
        ...(outcome === 'clear' && wasExcluded ? { restored: true } : {}),
      })
    }

    for (let i = 0; i < toJudge.length; i += JUDGE_CONCURRENCY) {
      await Promise.all(toJudge.slice(i, i + JUDGE_CONCURRENCY).map(judgeOne))
    }

    const idsWith = (...outcomes: ScreenOutcome[]) =>
      details.filter(d => outcomes.includes(d.outcome)).map(d => d.prospect_id)
    const result: CompetitorScreenResult = {
      ok: true,
      screened: true,
      cleared: idsWith('no_phrase', 'unscreenable', 'clear'),
      excluded: idsWith('excluded'),
      held: idsWith('held'),
      restored: details.filter(d => d.restored).map(d => d.prospect_id),
      unscreenable,
      judge_calls: judgeCalls,
      usage,
      details,
      problems: read.problems,
    }

    const payload = {
      organisation_id: organisationId,
      selected: prospectIds.length,
      cleared: result.cleared.length,
      excluded: result.excluded.length,
      held: result.held.length,
      restored: result.restored.length,
      unscreenable,
      judge_calls: judgeCalls,
      persisted: persist,
    }
    // warn when anybody was removed or held: a run that silently researches fewer
    // prospects than were selected is the invisible behaviour this log exists to prevent.
    if (result.excluded.length > 0 || result.held.length > 0) logger.warn('competitor-screen: prospects were excluded or held', payload)
    else logger.info('competitor-screen: complete', payload)
    return result
  } catch (err) {
    return {
      ok: false,
      error: `Could not check the selection for competitors: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Stores one verdict. An exclusion also removes the tier, which is what every paid stage
 * reads; on a prospect that is already uploaded the tier is left alone, because our gates
 * govern upload and nothing here can recall an email already sent (ADR-034).
 *
 * A prospect that was excluded and now reads clear has its removal reason cleared, so the
 * next tiering run gives it a tier again. ONLY WHEN THAT REASON IS THE COMPETITOR ONE: a row
 * removed for something else since keeps the reason tiering gave it.
 */
async function writeVerdict(
  supabase: SupabaseClient,
  organisationId: string,
  row: CompetitorScreenRow,
  check: CompetitorCheck,
): Promise<boolean> {
  const update: Record<string, unknown> = { competitor_check: check }
  const uploaded = row.outbound_upload_status !== null && row.outbound_upload_status !== undefined
    && row.outbound_upload_status !== 'pending'
  if (check.outcome === 'excluded' && !uploaded) {
    update.sourced_tier = null
    update.fit_score = null
    update.tiering_reason = COMPETITOR_REMOVAL_REASON
  }
  if (
    check.outcome === 'clear' && isCompetitorExcluded(row.competitor_check) && !uploaded
    && row.tiering_reason === COMPETITOR_REMOVAL_REASON
  ) {
    update.tiering_reason = null
  }
  const { error } = await supabase
    .from('prospects')
    .update(update)
    .eq('organisation_id', organisationId)
    .eq('id', row.id)
  if (error) {
    logger.error('competitor-screen: verdict not written; the prospect is held', {
      prospect_id: row.id, error: error.message,
    })
    return false
  }
  return true
}

/** One sentence for the operator, or null when the screen changed nothing and found no fault. */
export function describeCompetitorScreen(result: CompetitorScreenResult): string | null {
  const parts: string[] = []
  if (result.excluded.length > 0) {
    parts.push(
      `${result.excluded.length} excluded as ${result.excluded.length === 1 ? 'a competitor' : 'competitors'} ` +
      '(they sell what this client sells, by the list in the outbound brief)',
    )
  }
  if (result.held.length > 0) {
    parts.push(
      `${result.held.length} held because the competitor check gave no answer this run ` +
      '(they will be checked again on the next run)',
    )
  }
  // A category that could not be used was skipped, and companies in it were NOT checked.
  // That has to reach the operator, not only a log.
  if (result.problems.length > 0) {
    parts.push(`part of the competitor list could not be used and was skipped (${result.problems.join('; ')})`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}
