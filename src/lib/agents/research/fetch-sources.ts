// Fetching the four research sources for one prospect.
//
// EXTRACTED, NOT REWRITTEN. Moved out of runProspectResearchAgentV2 on 2026-08-26 so the
// batch path's phase 1 fetches sources with the SAME code rather than a copy. This is
// the block where every source-side pound is spent (Apify, Apollo, the website fetch and
// two Brave searches), so a second copy drifting is a second copy spending differently.
//
// The stored-findings branch deliberately did NOT come with it. That branch produces four
// skip stubs and makes no calls, and it belongs to the caller's control flow: the inline
// agent uses it to reuse findings, and phase 1 of the batch path never reaches it at all,
// because a prospect with usable stored findings needs no synthesis call and therefore no
// batch. See prospect-research-sources-agent.ts.

import { logger } from '@/lib/logger'
import { fetchLinkedInSource } from './sources/linkedin'
import { fetchApolloSource, apolloSourceFromRow } from './sources/apollo'
import { fetchWebsiteSource } from './sources/website'
import { fetchWebSearchSource } from './sources/web-search'
import type { ProspectContext, RawSourceData } from './types'
import type { ProspectRowExtras } from './prospect-context'

/**
 * Run all four sources in parallel. Failures are isolated per source: each returns an
 * `available: false` result with its own error rather than rejecting, so one dead
 * provider never costs the other three.
 *
 * THIS IS THE PAID CALL. Everything in the queue's spend machinery exists for this line.
 */
export async function fetchAllSources(
  ctx: ProspectContext,
  extras: ProspectRowExtras,
): Promise<RawSourceData> {
  const [linkedIn, apollo, website, webSearch] = await Promise.all([
    fetchLinkedInSource(ctx),
    // ── APOLLO: ROW FIRST, LIVE CALL ONLY AS FALLBACK ──────────────────
    //
    // Enrichment already bought this person via bulk_match and, since
    // 2026-08-24, stores the named subset on the prospect row. Calling
    // people/match here as well bought the SAME person a second time,
    // largely to recover employment_history, which enrichment had parsed
    // and thrown away.
    //
    // Measured: employment_history produces 38 of research's 40 winning
    // Apollo candidates, and Apollo is the strongest source in the system
    // at 40 of 92 wins against Apify's 8. So the call could not be removed,
    // only served from the row. About 113 duplicate paid calls per 244
    // researched prospects.
    //
    // The fallback stays for prospects enrichment never matched: the live
    // match rate is 46.3%, so a live call is still the only route for the
    // rest, and for anything enriched before this change shipped.
    (async () => {
      const stored = apolloSourceFromRow(extras.apollo_enrichment_data)
      if (stored) {
        logger.debug('research/fetch-sources: Apollo served from the prospect row, no call made', {
          prospect_id: ctx.id,
        })
        return stored
      }
      return fetchApolloSource(ctx)
    })(),
    fetchWebsiteSource(ctx),
    fetchWebSearchSource(ctx),
  ])

  return {
    linkedin:   linkedIn,
    apollo:     apollo,
    website:    website,
    web_search: webSearch,
  }
}
