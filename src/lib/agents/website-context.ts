// Shared helper: fetch successfully-extracted website pages for an organisation.
// Used by ICP, TOV, and Positioning agents to inject website content into prompts.
// Returns pages ordered by display_order, filtered to complete + non-empty text.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export interface WebsitePageContext {
  page_label: string
  url: string
  text: string
}

export async function fetchWebsiteContext(
  supabase: SupabaseClient,
  organisation_id: string,
  callerName: string
): Promise<WebsitePageContext[]> {
  const { data, error } = await supabase
    .from('intake_website_pages')
    .select('page_label, url, extracted_text')
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
    }))
}

// Formats website pages into a prompt block.
// Returns an empty string when no pages are available (omitted from prompt entirely).
export function formatWebsiteContextForPrompt(pages: WebsitePageContext[]): string {
  if (pages.length === 0) return ''

  const pageBlocks = pages
    .map(p => `### ${p.page_label} (${p.url})\n\n${p.text}`)
    .join('\n\n---\n\n')

  return `\n\n---\n\n## CLIENT WEBSITE CONTENT\n\n` +
    `The following text was fetched from the client's website at intake time. ` +
    `Use it to inform your understanding of their positioning, language, and offer. ` +
    `Do not treat it as authoritative — intake responses take precedence where they conflict.\n\n` +
    pageBlocks
}
