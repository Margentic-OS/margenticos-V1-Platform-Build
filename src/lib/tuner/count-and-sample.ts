// The tuner's own provider call: count a population, and optionally take a sample.
//
// ─── WHY THE EXISTING PATH CANNOT BE REUSED ──────────────────────────────────
//
// apolloHandler.execute() is the sourcing path and it is wrong here in two ways that
// cannot be patched around from outside it:
//
//   1. IT DISCARDS THE COUNT. `total_entries` is read inside execute() purely to decide
//      whether to fetch another page and is never returned. The count is the single most
//      useful free number the provider gives, and the whole loop is built on it.
//   2. IT REFUSES AN INCOMPLETE SEARCH. buildApolloRequest throws unless industries, job
//      titles, both country axes and a headcount range are all present. That refusal is
//      correct for sourcing, where an underspecified search would quietly mail the wrong
//      people. It is exactly wrong for differencing, whose entire method is issuing the
//      query with one part deliberately removed.
//
// So this module speaks to the provider directly. It is the ONLY place in the tuner that
// does. It writes nothing, and it never asks for a page beyond the first.
//
// ─── COST ────────────────────────────────────────────────────────────────────
//
// None. The people-search endpoint consumes no credits: the provider documents it as
// "Credit usage: 0 credits", the account's credit counters carry no search-credit line,
// and the repository's own filter-proof harness records the same. The only budget is the
// rate limit, which is why every call here is counted and a 429 is a terminal state rather
// than something to retry into.

import { logger } from '@/lib/logger'

const ENDPOINT = 'https://api.apollo.io/api/v1/mixed_people/api_search'

/**
 * Throttle between calls. The provider documents 600 requests/hour and enforces a
 * separate short-window burst limit; 320ms is the interval the sourcing handler already
 * uses between pages and it has not been rate limited in production.
 */
const THROTTLE_MS = 320

/** How long one provider call may take before the tuner gives up on it. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Raised when the provider rate limits. Carried as its own class so the loop can reach
 * the `rate_limit_reached` terminal state rather than reporting a generic failure, which
 * would be indistinguishable from a search that found nothing.
 */
export class ProviderRateLimited extends Error {
  constructor(readonly retryAfter: string | null) {
    super(`Provider rate limited. Retry-After: ${retryAfter ?? 'not provided'}`)
    this.name = 'ProviderRateLimited'
  }
}

/**
 * One row as the provider actually returns it at search time.
 *
 * MEASURED AGAINST THE PROVIDER 2026-09-08, and this shape is the whole constraint on the
 * judge. Only three fields carry a value: first name, job title, employer name. Everything
 * else the response holds is a boolean presence flag — whether the employer HAS an
 * industry, a revenue, an employee count — never what any of them is. So a question about
 * what a company does, how big it is, or where it sits cannot be answered from a search
 * row at all, by the judge or by anything else.
 */
export interface SampleRow {
  sourceId: string
  firstName: string | null
  jobTitle: string | null
  companyName: string | null
}

export interface CountResult {
  total: number
  rows: SampleRow[]
}

/** Counts provider calls across a whole run, so the record and the rate limit agree. */
export class ProviderBudget {
  private used = 0
  constructor(private readonly limit: number) {}
  get calls(): number { return this.used }
  get remaining(): number { return Math.max(0, this.limit - this.used) }
  spend(): void { this.used += 1 }
  get exhausted(): boolean { return this.used >= this.limit }
}

interface ProviderResponse {
  total_entries?: number
  people?: {
    id?: string
    first_name?: string | null
    title?: string | null
    organization?: { name?: string | null } | null
  }[]
}

/**
 * Issue one search and return the population, plus up to `sampleSize` rows.
 *
 * `sampleSize` of 0 asks for a count only and sends per_page=1, which is what differencing
 * uses. Nothing here paginates: a count needs one row and a sample needs one page.
 *
 * The request is passed as a plain object rather than built here, because differencing
 * needs to hand over a request with a part deliberately missing and no builder in this
 * codebase will produce one.
 */
export async function countAndSample(
  request: Record<string, unknown>,
  budget: ProviderBudget,
  sampleSize = 0,
): Promise<CountResult> {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) throw new Error('Sourcing tuner: APOLLO_API_KEY is not set')

  if (budget.exhausted) throw new ProviderRateLimited(null)

  if (budget.calls > 0) await new Promise(r => setTimeout(r, THROTTLE_MS))
  budget.spend()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ ...request, page: 1, per_page: Math.max(1, sampleSize) }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 429) {
    throw new ProviderRateLimited(response.headers.get('Retry-After'))
  }
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Sourcing tuner: provider returned ${response.status}: ${body.slice(0, 200)}`)
  }

  const data = (await response.json()) as ProviderResponse

  // A response with no total is not a population of zero. Treating a missing field as 0
  // would report "this audience does not exist" on a malformed response, which is the
  // single most expensive wrong answer this module can give.
  if (typeof data.total_entries !== 'number') {
    throw new Error('Sourcing tuner: provider response carried no total_entries')
  }

  const rows: SampleRow[] = sampleSize > 0
    ? (data.people ?? []).slice(0, sampleSize).map(p => ({
        sourceId: String(p.id ?? ''),
        firstName: p.first_name ?? null,
        jobTitle: p.title ?? null,
        companyName: p.organization?.name ?? null,
      }))
    : []

  logger.debug('tuner: provider count', {
    total: data.total_entries,
    sample_returned: rows.length,
    provider_calls_so_far: budget.calls,
  })

  return { total: data.total_entries, rows }
}
