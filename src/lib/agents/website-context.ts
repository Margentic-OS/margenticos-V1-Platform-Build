// Shared helper: fetch successfully-extracted website pages for an organisation.
// Used by ICP, TOV, and Positioning agents to inject website content into prompts.
// Returns pages ordered by display_order, filtered to complete + non-empty text.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export interface WebsitePageContext {
  page_label: string
  url: string
  text: string
  // The stored text was cut at the per-page cap in fetch-website.ts. The agents are told,
  // because a page that stops mid-sentence otherwise reads as a page that had nothing
  // more to say, and the detail that was cut is disproportionately the specific kind:
  // the general description is at the top of a page and the mechanism is further down.
  truncated: boolean
}

export async function fetchWebsiteContext(
  supabase: SupabaseClient,
  organisation_id: string,
  callerName: string
): Promise<WebsitePageContext[]> {
  const { data, error } = await supabase
    .from('intake_website_pages')
    .select('page_label, url, extracted_text, extraction_truncated')
    .eq('organisation_id', organisation_id)
    .eq('fetch_status', 'complete')
    .order('display_order', { ascending: true })

  if (error) {
    logger.warn(`${callerName}: could not fetch website pages — continuing without them`, {
      error: error.message,
    })
    return []
  }

  return (data ?? [])
    .filter(row => typeof row.extracted_text === 'string' && row.extracted_text.trim().length > 0)
    .map(row => ({
      page_label: row.page_label as string,
      url: row.url as string,
      text: row.extracted_text as string,
      truncated: row.extraction_truncated === true,
    }))
}

// Formats website pages into a prompt block.
// Returns an empty string when no pages are available (omitted from prompt entirely).
export function formatWebsiteContextForPrompt(pages: WebsitePageContext[]): string {
  if (pages.length === 0) return ''

  const pageBlocks = pages
    .map(p => {
      const cut = p.truncated
        ? '\n\n[This page was cut at the fetch limit and stops mid-sentence. What is here is ' +
          'genuine and usable. Treat the ending as incomplete rather than as the end of what ' +
          'this client had to say, and do not infer anything from what is absent below it.]'
        : ''
      return `### ${p.page_label} (${p.url})\n\n${p.text}${cut}`
    })
    .join('\n\n---\n\n')

  return `\n\n---\n\n## CLIENT WEBSITE CONTENT\n\n` +
    `The following text was fetched from the client's website at intake time. ` +
    `Use it to inform your understanding of their positioning, language, and offer. ` +
    `Do not treat it as authoritative — intake responses take precedence where they conflict.\n\n` +
    pageBlocks
}

// How many of the supplied pages were cut at the fetch limit. Used by the document agents
// to put the fact in the operator-facing reason on the suggestion, so a thin document has
// a visible candidate explanation rather than looking like the agent simply did poorly.
export function countTruncatedPages(pages: WebsitePageContext[]): number {
  return pages.filter(p => p.truncated).length
}
