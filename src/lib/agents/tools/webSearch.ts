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

async function searchViaNativeAnthropic(query: string): Promise<WebSearchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })

  // Use Haiku for lightweight research synthesis — the main generation uses Opus.
  const webSearchTool: WebSearchTool20250305 = {
    type: 'web_search_20250305',
    name: 'web_search',
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
  // from "results but a thin summary".
  let resultCount = 0
  for (const b of blocks) {
    if (b.type !== 'web_search_tool_result') continue
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
  }
}

// A synthesis is substantive when it carries actual findings, not a stub or a
// "could not find anything" note. Guards against storing a bare bullet character
// or a one-line apology as if it were research.
function isSubstantive(text: string): boolean {
  const stripped = text.replace(/[•\-*\s]/g, '')
  if (stripped.length < 60) return false

  const lower = text.toLowerCase()
  const NEGATIVE_MARKERS = [
    'unable to find', 'could not find', 'no specific', 'no verifiable',
    'i was unable', 'limited verifiable information', 'no results',
    "i'll search", 'i will search', 'let me search',
  ]
  // A negative marker only disqualifies when the text is mostly that statement.
  if (NEGATIVE_MARKERS.some(m => lower.includes(m)) && stripped.length < 220) return false

  return true
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
