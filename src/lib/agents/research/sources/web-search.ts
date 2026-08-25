// Web search source handler for prospect research agent v2.
// Two-pass: person-specific (recent content/appearances) + company-specific (news/growth).
// Wraps the existing webSearch utility — Anthropic native first, Brave fallback.
// Never throws.

import { webSearch } from '@/lib/agents/tools/webSearch'
import { logger } from '@/lib/logger'
import type { ProspectContext, WebSearchSourceResult } from '../types'

export async function fetchWebSearchSource(prospect: ProspectContext): Promise<WebSearchSourceResult> {
  const fullName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ')
  const company = prospect.company_name ?? ''
  const year = new Date().getFullYear()

  if (!fullName && !company) {
    return {
      available: false,
      person_search: null,
      company_search: null,
      combined: null,
      error: 'No name or company to search',
      // Nothing was called, so nothing was billed. This is the one zero here that is a
      // fact rather than a floor.
      providers: [],
      search_count: 0,
      result_count: 0,
    }
  }

  // Person query: finds podcast appearances, articles, interviews, LinkedIn activity.
  const personQuery = fullName
    ? `"${fullName}" ${company} podcast OR interview OR article OR published OR "wrote about" ${year}`
    : `${company} founder OR CEO news ${year}`

  // Company query: finds growth signals, announcements, hiring.
  const companyQuery = company
    ? `"${company}" growth OR hiring OR launched OR news OR announcement ${year}`
    : `${fullName} company news ${year}`

  try {
    const [personResult, companyResult] = await Promise.all([
      webSearch(personQuery),
      webSearch(companyQuery),
    ])

    // A query that came back `limited` produced no substantive findings. Treating it
    // as content is what let the model's own preamble ("I'll search for information
    // about...") be stored as research and counted as a successful source.
    const personText  = !personResult.limited  ? (personResult.synthesis.trim()  || null) : null
    const companyText = !companyResult.limited ? (companyResult.synthesis.trim() || null) : null

    const available = !!(personText || companyText)

    const combined = [personText, companyText]
      .filter(Boolean)
      .join('\n\n')
      .trim() || null

    // Spend and provenance are recorded whether or not the content was usable. A query
    // that ran, cost money and returned nothing is exactly the case worth counting: it is
    // the majority case on the native path, and it was invisible until now.
    const providers = [...new Set([personResult.source, companyResult.source])]
    const searchCount = personResult.searchCount + companyResult.searchCount
    const resultCount = personResult.resultCount + companyResult.resultCount

    if (available) {
      logger.debug('research/web-search: succeeded', {
        person: !!personText,
        company: !!companyText,
        providers,
        search_count: searchCount,
        result_count: resultCount,
      })
    } else {
      logger.debug('research/web-search: no substantive findings', {
        person_reason:  personResult.limitedReason  ?? 'none',
        company_reason: companyResult.limitedReason ?? 'none',
        providers,
        // Searches that were paid for and yielded nothing usable. Watch this number.
        search_count: searchCount,
        result_count: resultCount,
      })
    }

    return {
      available,
      person_search: personText,
      company_search: companyText,
      combined,
      error: available
        ? undefined
        : `No substantive findings. person: ${personResult.limitedReason ?? 'empty'}; company: ${companyResult.limitedReason ?? 'empty'}`,
      providers,
      search_count: searchCount,
      result_count: resultCount,
    }
  } catch (err) {
    logger.warn('research/web-search: failed', { error: String(err) })
    return {
      available: false,
      person_search: null,
      company_search: null,
      combined: null,
      error: String(err),
      // The throw loses both responses, so any searches the provider already ran are
      // unrecoverable from here. Zero is a floor on what was billed, not a statement
      // that nothing was.
      providers: [],
      search_count: 0,
      result_count: 0,
    }
  }
}
