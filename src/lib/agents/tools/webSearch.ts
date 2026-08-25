// Web Search Utility — shared across all document generation agents.
// Entry point for agents that need market research before generation.
//
// Priority order:
//   1. Anthropic native web search (web_search_20250305) — server-side, no loop needed
//   2. Brave Search API — if BRAVE_SEARCH_API_KEY is set
//   3. Graceful degradation — returns limited: true, agents fall back to framework logic
//
// Usage:
//   import { runResearchQueries } from '@/lib/agents/tools/webSearch'
//   const research = await runResearchQueries(['query 1', 'query 2'])
//
// Design constraints:
//   - Stateless: no module-level variables
//   - Never throws: always returns a result, limited or not
//   - TOV agent does not use this utility (works from writing samples only)

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, WebSearchTool20250305 } from '@anthropic-ai/sdk/resources/messages/messages'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WebSearchResult {
  query: string
  /** Synthesised text summary — ready to paste directly into an agent prompt. */
  synthesis: string
  /** Where the result came from. */
  source: 'anthropic_native' | 'brave' | 'none'
  /** True when results were empty, thin, or the search failed entirely. */
  limited: boolean
  /** Human-readable reason for limitation — included in suggestion_reason when true. */
  limitedReason?: string
  /**
   * THE BILLABLE UNIT. How many searches the provider actually ran for this one query.
   *
   * Anthropic bills the server-side web_search tool per SEARCH, not per request, and one
   * request may run several. This number was previously computed and thrown away, so the
   * native path could not be priced at all and was carried at $0 in the project's own
   * estimator while plausibly being the second-largest Anthropic line. See
   * WEB_SEARCH_MAX_USES below.
   *
   * Native: the number of web_search_tool_result blocks in the response.
   * Brave:  always 1, one HTTP call per query.
   * none:   0, nothing ran.
   */
  searchCount: number
  /** How many individual hits those searches returned in total. Quality, not cost. */
  resultCount: number
}

export interface ResearchBundle {
  results: WebSearchResult[]
  /** True if any query returned limited results. */
  anyLimited: boolean
  /**
   * Formatted note for inclusion in document_suggestions.suggestion_reason.
   * Empty string when all searches succeeded.
   */
  limitedNote: string
}

// ─── Anthropic native search ─────────────────────────────────────────────────
// web_search_20250305 is a server-side tool: Anthropic executes the search
// automatically. We send one message and receive synthesis in the text block.
// No tool-result loop required from our side.

/**
 * Ceiling on searches per query. Anthropic bills this tool per search (~$10 per 1,000),
 * and prospect research fires TWO queries per prospect, so the worst case here multiplies
 * by two before it reaches the per-prospect figure.
 *
 * WHY 3 AND NOT 2. Measured 2026-08-25 across 206 stored native texts: 148 of them (72%)
 * contain an explicit "could not find" / "no verifiable". The queries are quoted-name and
 * OR-heavy, so a first pass frequently returns nothing for a small consultancy and the
 * model's natural next move is to drop the quotes or the year and try again. The wins that
 * were actually load-bearing look like that second pass: a UK incorporation date, a dated
 * podcast episode, a retirement with figures. Capping at 2 would leave exactly one
 * reformulation, and cutting the tail that produced those facts to save a cent is the
 * wrong trade while the real distribution is unknown.
 *
 * IT IS UNKNOWN BECAUSE NOTHING RECORDED IT. searchCount above now does. Once a week of
 * real runs is on file, read the distribution and tighten this to 2 if the third search
 * is rarely reached or rarely useful. Do not tighten it on instinct: 3 bounds the tail at
 * 6 searches per prospect, which is the point of the cap. Uncapped was the actual defect.
 */
export const WEB_SEARCH_MAX_USES = 3

async function searchViaNativeAnthropic(query: string): Promise<WebSearchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })

  // Use Haiku for lightweight research synthesis — the main generation uses Opus.
  const webSearchTool: WebSearchTool20250305 = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES,
  }

  const messages: MessageParam[] = [
    {
      role: 'user',
      content:
        `Research this topic and return only factual findings as 4–6 concise bullet points. ` +
        `Focus on what is verifiable and specific. Do not editorialize.\n\nTopic: ${query}`,
    },
  ]

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    tools: [webSearchTool],
    messages,
  })

  // The response content is a sequence, not a single block. With the server-side
  // search tool it looks like:
  //   [ text("I'll search for..."), server_tool_use, web_search_tool_result, text(findings) ]
  // Taking the FIRST text block captures the model's preamble instead of the findings.
  // Take only the text blocks that come AFTER the last search result.
  const blocks = response.content
  const lastResultIdx = blocks.map(b => b.type).lastIndexOf('web_search_tool_result')

  // No search result block at all means the model never actually searched.
  if (lastResultIdx === -1) {
    throw new Error('Anthropic native search: model returned no web_search_tool_result block')
  }

  const synthesis = blocks
    .slice(lastResultIdx + 1)
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map(b => b.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!synthesis) {
    throw new Error('Anthropic native search: search ran but produced no synthesis text')
  }

  // Count the results the search actually returned, so "no results" is distinguishable
  // from "results but a thin summary". searchCount is the separate, BILLABLE number:
  // one web_search_tool_result block is one charged search, however many hits it carried.
  let resultCount = 0
  let searchCount = 0
  for (const b of blocks) {
    if (b.type !== 'web_search_tool_result') continue
    searchCount += 1
    const content = (b as { content?: unknown }).content
    if (Array.isArray(content)) resultCount += content.length
  }

  const limited = resultCount === 0 || !isSubstantive(synthesis)

  return {
    query,
    synthesis,
    source: 'anthropic_native',
    limited,
    limitedReason: limited
      ? (resultCount === 0
          ? 'Search executed but returned zero results'
          : 'Search returned results but no substantive findings')
      : undefined,
    searchCount,
    resultCount,
  }
}

const NEGATIVE_MARKERS = [
  'unable to find', 'could not find', 'no specific', 'no verifiable',
  'i was unable', 'limited verifiable information', 'no results',
  "i'll search", 'i will search', 'let me search',
]

// The marker list above catches how the model opens a negative. It does NOT catch how the
// model fills the BULLETS of one, and that is where most of the volume is. Measured over
// 60 stored texts: extending the sentence test with only the marker list changed exactly
// ZERO verdicts, because the bullets say "No podcast, interview, article or published
// content attributable to X" and "The company's website contains no evidence of media
// appearances", none of which contain a listed marker.
const NEGATIVE_PATTERNS = [
  /^\s*(?:[•\-*]\s*)?(?:no|none|neither|nothing)\b/i,
  /\bno (?:evidence|record|mention|trace|indication|public|published|dated|other|available)\b/i,
  /\b(?:does|do|did) not (?:appear|show|return|contain|indicate)\b/i,
  /\bnone (?:show|of the|appear|are|is)\b/i,
  /\bnot (?:find|found|available|verifiable|publicly)\b/i,
]

function isNegativeStatement(sentence: string): boolean {
  const lower = sentence.toLowerCase()
  return NEGATIVE_MARKERS.some(marker => lower.includes(marker))
    || NEGATIVE_PATTERNS.some(pattern => pattern.test(sentence))
}

/** Length of the real characters, ignoring bullet glyphs and whitespace. */
function contentLength(text: string): number {
  return text.replace(/[•\-*\s]/g, '').length
}

const SUBSTANTIVE_MIN_CHARS = 60

/**
 * How much of a text must be non-negative for it to count as a finding.
 *
 * TUNED ON REAL DATA, 2026-08-25, over 60 stored native search texts. The positive-share
 * distribution is bimodal: 7 texts sit below 40%, then the mass runs from 40% to 100%.
 * Cutting at the gap rejects 4 of the 57 that previously passed. Cutting at 0.5 instead
 * rejects 12, but starts taking texts whose surviving half is a real role or headcount
 * fact, so 0.4 is the conservative edge of the gap rather than the middle of the data.
 *
 * BE HONEST ABOUT THE SIZE OF THIS. The often-quoted figure is that 72% of stored native
 * texts carry an explicit negative marker, which is true, and it is tempting to read that
 * as "72% is waste". It is not: most of those texts also carry a genuine positive fact
 * about the person or company, and only the share below this threshold is mostly-negative
 * by volume. This gate removes that tail. It does not remove the duplication between web
 * search's role/headcount output and Apollo's, which is a different problem and cannot be
 * solved here, because this utility is shared with the document agents and cannot know
 * what Apollo returned.
 *
 * search_count and providers are now persisted per run, so revisit this on real data
 * rather than on instinct.
 */
const SUBSTANTIVE_MIN_POSITIVE_SHARE = 0.4

// A synthesis is substantive when it carries actual findings, not a stub or a
// "could not find anything" note. Guards against storing a bare bullet character
// or a one-line apology as if it were research.
//
// THE 220-CHARACTER CEILING THIS REPLACES WAS THE BUG. The old rule disqualified a
// negative marker only when the WHOLE text was under 220 characters, so a verbose negative
// simply outgrew the test and was stored as successful research, then fed to the Sonnet
// synthesis call as paid input tokens.
//
// The old comment already stated the right rule: "a negative marker only disqualifies when
// the text is mostly that statement". It measured "mostly" with a length constant, which
// is exactly the kind of constant a model's prose grows past. Measuring the SHARE of the
// text that is not a negative statement tests "mostly" directly, and leaves no number for
// prose to outgrow.
//
// Mixed text is the case that matters and it still passes: "No verifiable 2026 press
// releases found. The company registered a UK entity on 19 March 2026." keeps sentence two,
// which is the finding that was load-bearing in three shipped openings.
export function isSubstantive(text: string): boolean {
  if (contentLength(text) < SUBSTANTIVE_MIN_CHARS) return false

  // Split on sentence ends AND newlines, so a bulleted list is judged bullet by bullet
  // rather than as one blob. A run-on negative with no terminator stays a single sentence
  // and is dropped whole, which is the correct reading of it.
  const positiveText = text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(sentence => !isNegativeStatement(sentence))
    .join(' ')

  const positiveChars = contentLength(positiveText)
  if (positiveChars < SUBSTANTIVE_MIN_CHARS) return false

  return positiveChars / Math.max(contentLength(text), 1) >= SUBSTANTIVE_MIN_POSITIVE_SHARE
}

// ─── Brave Search fallback ────────────────────────────────────────────────────

interface BraveWebResult {
  title?: string
  description?: string
  url?: string
}

async function searchViaBrave(query: string): Promise<WebSearchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY not set')

  const url =
    `https://api.search.brave.com/res/v1/web/search` +
    `?q=${encodeURIComponent(query)}&count=6&freshness=pm6`

  const response = await fetch(url, {
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    },
  })

  if (!response.ok) {
    throw new Error(`Brave Search API returned ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as { web?: { results?: BraveWebResult[] } }
  const results = data?.web?.results ?? []

  if (results.length === 0) {
    return {
      query,
      synthesis: '',
      source: 'brave',
      limited: true,
      limitedReason: 'Brave Search returned no results for this query',
      // One HTTP call was made and returned nothing. It is a search that happened, so it
      // counts; Brave's free tier is metered on calls, not on useful calls.
      searchCount: 1,
      resultCount: 0,
    }
  }

  // Format into bullet-point synthesis for inclusion in agent prompts.
  const synthesis = results
    .slice(0, 5)
    .map(r => `- ${r.title ?? 'Untitled'}: ${r.description ?? '(no description)'}`)
    .join('\n')

  return {
    query,
    synthesis,
    source: 'brave',
    limited: results.length < 3,
    limitedReason:
      results.length < 3 ? `Only ${results.length} result(s) found` : undefined,
    searchCount: 1,
    resultCount: results.length,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a single web search query.
 * Tries Anthropic native first, falls back to Brave, degrades gracefully.
 * Never throws.
 */
export async function webSearch(query: string): Promise<WebSearchResult> {
  // Try Anthropic native search first.
  try {
    const result = await searchViaNativeAnthropic(query)
    logger.debug('Web search: Anthropic native succeeded', { query, source: result.source })
    return result
  } catch (err) {
    // Same rule as synthesis: a billing or auth failure will not resolve on the next
    // query, and silently degrading to Brave hides the fact that the account is dead.
    throwIfFatal(err, 'Anthropic web search')
    logger.warn('Web search: Anthropic native failed, trying Brave', {
      query,
      error: String(err),
    })
  }

  // Fallback: Brave Search API.
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const result = await searchViaBrave(query)
      logger.debug('Web search: Brave succeeded', { query })
      return result
    } catch (err) {
      logger.warn('Web search: Brave also failed', { query, error: String(err) })
    }
  }

  // Both paths failed — return graceful degradation.
  logger.warn('Web search: all search methods unavailable, continuing without results', { query })
  return {
    query,
    synthesis: '',
    source: 'none',
    limited: true,
    limitedReason: 'Web search unavailable — neither Anthropic native search nor Brave Search API succeeded',
    // A native attempt that threw may still have run, and been billed for, searches we
    // never saw: the exception carries no response body. Recording 0 here is a floor on
    // spend, not a claim that nothing was charged.
    searchCount: 0,
    resultCount: 0,
  }
}

/**
 * Run multiple research queries in parallel.
 * Returns a ResearchBundle ready for inclusion in an agent prompt.
 * The limitedNote field is formatted for document_suggestions.suggestion_reason.
 */
export async function runResearchQueries(queries: string[]): Promise<ResearchBundle> {
  // Per-query timeout: 8 seconds. If a search times out, return limited result and continue.
  const RESEARCH_TIMEOUT_MS = 8000

  const results = await Promise.all(
    queries.map(q => webSearchWithTimeout(q, RESEARCH_TIMEOUT_MS))
  )

  const anyLimited = results.some(r => r.limited)
  const limitedQueries = results.filter(r => r.limited).map(r => r.query)

  const limitedNote = anyLimited
    ? ` ⚠️ Research note: web search returned limited or no results for the following ` +
      `${limitedQueries.length === 1 ? 'query' : 'queries'}: ` +
      limitedQueries.map(q => `"${q}"`).join(', ') +
      '. ICP sections informed by this research may rely more heavily on framework logic than live market data.'
    : ''

  return { results, anyLimited, limitedNote }
}

/**
 * Wraps webSearch with a timeout. If the search takes longer than timeoutMs,
 * returns a limited result instead of hanging. Never throws.
 */
async function webSearchWithTimeout(query: string, timeoutMs: number): Promise<WebSearchResult> {
  return Promise.race([
    webSearch(query),
    new Promise<WebSearchResult>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Research query timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]).catch((err) => {
    logger.warn('webSearchWithTimeout: search timed out or failed', {
      query,
      error: String(err),
    })
    return {
      query,
      synthesis: '',
      source: 'none' as const,
      limited: true,
      limitedReason: `Web search timed out after ${timeoutMs}ms — proceeding without results`,
      // A timeout abandons the request; it does not cancel searches the provider already
      // ran and billed. Same floor-not-truth caveat as the both-paths-failed return above.
      searchCount: 0,
      resultCount: 0,
    }
  })
}

/**
 * Format a ResearchBundle into a prompt section string.
 * Returns an empty string if all results were limited (caller falls back to framework logic).
 */
export function formatResearchForPrompt(bundle: ResearchBundle): string {
  const useful = bundle.results.filter(r => !r.limited && r.synthesis.trim().length > 0)
  if (useful.length === 0) return ''

  const sections = useful
    .map(r => `### Research: ${r.query}\n\n${r.synthesis}`)
    .join('\n\n')

  return `## WEB RESEARCH (current market intelligence)\n\n${sections}`
}
