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

    const personText = personResult.synthesis.trim() || null
    const companyText = companyResult.synthesis.trim() || null

    const available = !!(personText || companyText)

    const combined = [personText, companyText]
      .filter(Boolean)
      .join('\n\n')
      .trim() || null

    if (available) {
      logger.debug('research/web-search: succeeded', {
        person: !!personText,
        company: !!companyText,
      })
    }

    return {
      available,
      person_search: personText,
      company_search: companyText,
      combined,
      error: available ? undefined : 'Both queries returned no results',
    }
  } catch (err) {
    logger.warn('research/web-search: failed', { error: String(err) })
    return {
      available: false,
      person_search: null,
      company_search: null,
      combined: null,
      error: String(err),
    }
  }
}
