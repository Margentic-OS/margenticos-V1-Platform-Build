// Web search source handler for prospect research agent v2.
//
// ONE query, capped at ONE billable search. Reduced from two queries at up to three
// searches each on 2026-08-25.
//
// Wraps the existing webSearch utility — Anthropic native first, Brave fallback.
// Never throws.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY REDUCED AND NOT DELETED
//
// Deleting it was the decision on the table, and the case looked strong: web search is
// ~35% of Anthropic cost per prospect, won 0 of 11 clean shipped openings, and has the
// worst six-test pass rate of the five sources at 11.4%.
//
// THE CORPUS BEHIND THOSE THREE FIGURES, because a rate without one is not a fact.
// The cost share and the 0 of 11 come from the 2026-08-25 console day, reconciled against
// the invoice and recorded in docs/BACKLOG.md, which also states plainly that N=11 IS SMALL
// and that the contaminated cohort implied a 22.8% touch rate.
// THE 11.4% DENOMINATOR IS UNVERIFIED. The six-test pass rates for the other sources come
// from the 105 fresh research runs on file (see sources/linkedin.ts, which states its
// corpus), and this figure is quoted alongside them in BACKLOG, but the number of web
// search CANDIDATES it was computed over is recorded nowhere. Do not requote 11.4% as
// though its denominator were known. Re-measure it before it decides anything.
//
// It survives because those numbers measure CONVERSION and the argument for keeping it is
// about COVERAGE. This is the only source that reports what the outside world says about
// a prospect. Apollo has employment history, LinkedIn has what they post themselves, the
// website has how they describe themselves. None of them finds a podcast appearance or a
// company incorporation dated last quarter. Deleting the source removes that entire
// category of signal, not merely its conversion rate, and a category with a low hit rate
// is not the same thing as a category with no value.
//
// So the spend is cut by roughly two thirds and the category is kept.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY ONE MERGED QUERY RATHER THAN KEEPING THE BETTER OF THE TWO
//
// The old shape fired a PERSON query and a COMPANY query. Dropping either one would have
// contradicted the reason for keeping the source at all: a podcast appearance is a person
// signal and an incorporation is a company signal, and both were named as things nothing
// else finds. Choosing between them would have deleted half the category to save a query.
//
// A merged query keeps both. That works here specifically because of how this API behaves:
// the string below is not sent to a search engine as a literal query. It is handed to a
// model as a TOPIC, and the model issues its own searches against it (see
// searchViaNativeAnthropic). So a topic naming the person AND the company reads naturally
// and lets the model spend its one search where there is actually something to find.
//
// THE TRADE-OFF, STATED PLAINLY: one search cannot cover both as well as up to six could.
// This is a deliberate reduction in depth, not a free optimisation. Expect fewer findings.
// Confirm the real saving from raw_web_search.search_count and the Anthropic console after
// the next research run rather than trusting the estimate. The estimate is $0.084 down to
// about $0.03 per prospect; the console is the ground truth, per CLAUDE.md.

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

  // ONE topic covering both halves of what this source is for: what the PERSON has said
  // or appeared on, and what the COMPANY has done. Written as a natural-language topic
  // rather than a boolean search string, because the model reads it and decides what to
  // search for.
  const subject = fullName && company
    ? `${fullName} of ${company}`
    : (fullName || company)

  const query =
    `${subject}, in ${year}: any podcast appearances, interviews, published articles or ` +
    `press coverage, and any company news such as funding, incorporation, hiring, ` +
    `launches or announcements.`

  try {
    // ONE SEARCH. The budget is passed per caller: the ICP and positioning document
    // agents keep the default of 3, because they run once per client and richer search is
    // worth paying for there. This runs on every prospect in every batch, which is where
    // the volume is.
    const result = await webSearch(query, { maxUses: 1 })

    // A query that came back `limited` produced no substantive findings. Treating it
    // as content is what let the model's own preamble ("I'll search for information
    // about...") be stored as research and counted as a successful source.
    const text = !result.limited ? (result.synthesis.trim() || null) : null

    const available = !!text
    const combined = text

    // Spend and provenance are recorded whether or not the content was usable. A query
    // that ran, cost money and returned nothing is exactly the case worth counting: it is
    // the majority case on the native path, and it was invisible until now.
    const providers = [...new Set([result.source])]
    const searchCount = result.searchCount
    const resultCount = result.resultCount

    if (available) {
      logger.debug('research/web-search: succeeded', {
        providers,
        search_count: searchCount,
        result_count: resultCount,
      })
    } else {
      logger.debug('research/web-search: no substantive findings', {
        reason: result.limitedReason ?? 'none',
        providers,
        // Searches that were paid for and yielded nothing usable. Watch this number.
        search_count: searchCount,
        result_count: resultCount,
      })
    }

    return {
      available,
      // person_search KEEPS THE SINGLE MERGED RESULT and company_search is always null.
      // The fields stay in the shape because consumers and stored rows already read them;
      // collapsing them to one field is a schema change for no gain. person_search is the
      // one that carries content because it is the field downstream code already prefers.
      person_search: text,
      company_search: null,
      combined,
      error: available
        ? undefined
        : `No substantive findings: ${result.limitedReason ?? 'empty'}`,
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
