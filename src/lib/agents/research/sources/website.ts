// Website source handler for prospect research agent v2.
// Attempts a direct fetch with a real browser user-agent.
// Falls back to Jina.ai Reader (r.jina.ai) which renders JS-heavy and anti-bot sites.
// Never throws — returns available: false on all failure paths.

import { logger } from '@/lib/logger'
import { readErrorBody, SourceHttpError } from './source-http'
import type { ProspectContext, WebsiteSourceResult, WebsitePost } from '../types'

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
]

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

function deriveWebsiteUrl(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '')
  return `https://www.${slug}.com`
}

function safeSlice(str: string, maxChars: number): string {
  return [...str].slice(0, maxChars).join('')
}

/**
 * THE ONE-LINE DEFECT, fixed here. `fetch('example.com')` does not attempt a request and
 * does not return a status: it throws `TypeError: Failed to parse URL`. 67 of the 68
 * website failures on 2026-09-21 were bare domains, so the direct fetch made ZERO network
 * calls across the whole run (fetch_method was 'jina' on 16 of 16 successes and 'direct'
 * on 0 of 84), and every site fell through to unauthenticated Jina.
 *
 * Re-probed all 67 on 2026-09-23 with the scheme prepended: 63 returned usable text.
 */
export function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

// ─── Following the pages that actually carry dates ───────────────────────────

/**
 * Link text and hrefs worth following from a homepage.
 *
 * NOT A RULE ZERO VIOLATION, and worth saying because it looks like one. These are
 * WEB CONVENTIONS for where a site files dated material, not facts about any client,
 * industry or buyer. "blog" means the same thing on a logistics firm's site as on a
 * consultancy's. Nothing here encodes who the client sells to.
 */
const CONTENT_PATHS = /\b(blog|news|insights|articles|press|updates|events)\b/i

/** How many pages beyond the homepage. Four, as proposed. */
export const MAX_PAGES_FOLLOWED = 4

/** Character caps, PER PAGE rather than per site. */
export const HOMEPAGE_CHARS = 5000
export const FOLLOWED_PAGE_CHARS = 3000

/**
 * Wall-clock ceiling for this source, following included.
 *
 * ═══ WHY A DEADLINE AND NOT A BIGGER BUDGET ══════════════════════════════════
 * MEASURED on 20 real prospect sites, 2026-09-23, under this code: mean 1.38s, median
 * 1.27s, p90 2.50s, slowest 6.30s, and 20 of 20 fetched. So the typical cost of following
 * links is a second, and the research budget is untouched: FRESH_SECONDS_PER_PROSPECT is
 * 46.8s, the four sources run in Promise.all, and this one is not close to the slowest.
 * It is very likely FASTER than before, because the direct fetch now actually runs instead
 * of throwing on a bare domain and falling through to a 15s Jina timeout.
 *
 * The WORST case is the problem, not the typical one. Five pages each failing direct
 * (10s) then Jina (15s) is 125s, which would eat half a 240s batch budget for one
 * prospect. That case never appeared in the sample and does not need to: an unbounded
 * worst case inside a budgeted run is a defect whether or not it has happened yet.
 *
 * So the source stops FOLLOWING when the clock runs out and returns what it has. It never
 * abandons the homepage, because the homepage is the part the run actually needs.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const SOURCE_DEADLINE_MS = 20_000

/**
 * Candidate links from a homepage's raw HTML, absolute, deduplicated, same-host only.
 *
 * Same-host is a constraint, not an optimisation: a homepage's nav often points at a
 * Medium or Substack presence, and following those would spend the page budget off-site
 * on content whose dates we cannot attribute to this company.
 */
export function findContentLinks(html: string, baseUrl: string): string[] {
  const base = new URL(withScheme(baseUrl))
  const out = new Set<string>()

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = m[1]
    const anchorText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!CONTENT_PATHS.test(href) && !CONTENT_PATHS.test(anchorText)) continue
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue
    try {
      const abs = new URL(href, base)
      if (abs.host !== base.host) continue
      abs.hash = ''
      if (abs.href === base.href) continue
      out.add(abs.href)
    } catch { /* an unparseable href is not a link we can follow */ }
  }
  return [...out].slice(0, MAX_PAGES_FOLLOWED)
}

/**
 * Dated entries on a followed page.
 *
 * READS THE DATE OFF THE PAGE AND NEVER INFERS ONE. A post whose date cannot be read is
 * not returned, because the entire value of this is supplying a date the research can
 * trust: a guessed date is worse than no date, and the agent already has one way to
 * assert recency without evidence, which is what the "last 60 days" label was.
 *
 * Returns at most 10 per page. Dates are normalised to YYYY-MM-DD.
 */
export function findDatedPosts(html: string, pageUrl: string): WebsitePost[] {
  const posts: WebsitePost[] = []
  const seen = new Set<string>()

  // <time datetime="..."> is the only machine-readable form and is tried first.
  for (const m of html.matchAll(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/time>/gi)) {
    const d = new Date(m[1])
    if (Number.isNaN(d.getTime())) continue
    const date = d.toISOString().slice(0, 10)
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const key = `${date}|${title}`
    if (seen.has(key)) continue
    seen.add(key)
    posts.push({ page_url: pageUrl, date, title: title.slice(0, 200) })
  }

  // Then dates printed as prose, with the nearest heading as the title.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
  const prose = new RegExp(`\\b(?:(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})|(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4}))\\b`, 'gi')
  for (const m of text.matchAll(prose)) {
    const raw = m[0]
    const d = new Date(raw.replace(/(\d)(st|nd|rd|th)/gi, '$1'))
    if (Number.isNaN(d.getTime())) continue
    const date = d.toISOString().slice(0, 10)
    // The nearest preceding heading or link text is the entry this date belongs to.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 700), m.index ?? 0)
    const heads = [...before.matchAll(/<(?:h[1-4]|a)\b[^>]*>([\s\S]{0,160}?)<\/(?:h[1-4]|a)>/gi)]
    const title = (heads.length ? heads[heads.length - 1][1] : '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!title) continue
    const key = `${date}|${title}`
    if (seen.has(key)) continue
    seen.add(key)
    posts.push({ page_url: pageUrl, date, title: title.slice(0, 200) })
  }

  return posts.slice(0, 10)
}

function extractText(html: string): string {
  return safeSlice(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    4000,
  )
}

/**
 * NOTHING IN THIS FILE CAN ABORT A RUN. Not the prospect's own site, and not Jina.
 *
 * The rule follows from the TIER, not from who owns the server. Website is a
 * record-tier source: its failure is logged, counted and continued past, and a prospect
 * is never held for it. A source that cannot hold one prospect must not be able to stop
 * nine hundred, and a fatal throw from the fallback of a source that does not even hold
 * would be a bigger hammer than the source is allowed to swing.
 *
 * So this function throws SourceHttpError, which carries the status for the record, and
 * every caller catches it. throwIfFatalSource is not imported here at all, which is the
 * cheapest guarantee available: the escalation is not merely unused, it is absent.
 */
async function fetchDirect(url: string, maxChars: number): Promise<{ text: string; html: string } | null> {
  const response = await fetch(withScheme(url), {
    headers: {
      'User-Agent': pickUserAgent(),
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
  })
  // `return null` used to stand here, discarding the status. That is why the 68 website
  // failures of 2026-09-21 all recorded the identical string "Both direct and Jina fetch
  // failed" and not one of them says whether the site 403'd, 404'd, or returned a page
  // with no text in it.
  if (!response.ok) {
    throw new SourceHttpError(`website ${url}`, response.status, await readErrorBody(response))
  }
  const html = await response.text()
  // The RAW html travels alongside the extracted text. extractText strips every tag, so
  // link hrefs and <time datetime> attributes are gone by the time it returns, and those
  // are exactly what the follow step needs.
  return { text: safeSlice(extractText(html), maxChars), html }
}

async function fetchViaJina(url: string, maxChars: number): Promise<{ text: string; html: string } | null> {
  // Jina Reader returns clean markdown. Markdown keeps its links as [text](href), so the
  // link finder still works on it: the <a> pattern misses, and the caller converts.
  const jinaUrl = `https://r.jina.ai/${withScheme(url)}`
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/markdown,text/plain',
    },
    signal: AbortSignal.timeout(15000),
  })
  // JINA'S STATUSES ARE RECORDED AND NEVER FATAL. Reversed 2026-09-23.
  //
  // The first version made 401/402/403 from Jina abort the run, reasoning that Jina is a
  // provider we call and its refusal applies to every remaining prospect. That reasoning
  // is sound about Apify and wrong here, and the difference is the TIER: website is
  // record-tier, so its failure does not even hold ONE prospect. Letting its fallback
  // stop the whole run gave the weakest source in the system the strongest possible
  // veto.
  //
  // It is not hypothetical. Measured on 2026-09-23, unauthenticated r.jina.ai allows
  // `x-ratelimit-limit: 20, 20;w=60` — 20 requests per minute per IP — and returns 429
  // with "Per IP rate limit exceeded". Research runs maxInFlight 20 and now fetches up to
  // 5 pages per prospect, so bursts well past that limit are routine. 429 was always
  // non-fatal, but a provider that switched to 403 for the same condition would have
  // aborted production runs over a rate limit on a source that contributes nothing to a
  // held verdict.
  if (!response.ok) {
    throw new SourceHttpError('Jina Reader', response.status, await readErrorBody(response))
  }
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed || trimmed.length < 50) return null
  return { text: safeSlice(trimmed, maxChars), html: trimmed }
}

/**
 * Fetches one page by whichever method works, direct first then Jina.
 * Returns null when neither did, with each attempt's reason pushed onto `reasons`.
 */
async function fetchPage(
  url: string,
  maxChars: number,
  reasons: string[],
  label: string,
): Promise<{ text: string; html: string; method: 'direct' | 'jina' } | null> {
  try {
    const got = await fetchDirect(url, maxChars)
    if (got && got.text.length > 100) return { ...got, method: 'direct' }
    reasons.push(`${label} direct: 200 but only ${got?.text.length ?? 0} chars of text`)
  } catch (err) {
    reasons.push(`${label} direct: ${err instanceof SourceHttpError ? `HTTP ${err.status}` : String(err)}`)
  }

  try {
    const got = await fetchViaJina(url, maxChars)
    if (got && got.text.length > 100) return { ...got, method: 'jina' }
    reasons.push(`${label} jina: 200 but only ${got?.text.length ?? 0} chars of text`)
  } catch (err) {
    // NO ESCALATION HERE, DELIBERATELY. Every Jina failure, including 401, 402 and 403,
    // is recorded and continued past. See the note on fetchViaJina for why the tier
    // decides this rather than who owns the server.
    reasons.push(`${label} jina: ${err instanceof SourceHttpError ? `HTTP ${err.status}` : String(err)}`)
  }
  return null
}

export async function fetchWebsiteSource(prospect: ProspectContext): Promise<WebsiteSourceResult> {
  if (!prospect.website_url && !prospect.company_name) {
    return { available: false, url: null, content: null, fetch_method: null, error: 'No website URL or company name' }
  }

  const url = prospect.website_url ?? deriveWebsiteUrl(prospect.company_name!)

  // WHY EVERY REASON IS KEPT. The single string this used to return said two things had
  // failed and nothing about why either did, so 68 failures in one run were undiagnosable
  // and it took a live re-probe to discover the direct fetch had never run at all.
  const reasons: string[] = []

  const home = await fetchPage(url, HOMEPAGE_CHARS, reasons, 'homepage')
  if (!home) {
    return {
      available: false,
      url,
      content: null,
      fetch_method: null,
      error: `Website fetch failed for ${url} — ${reasons.join('; ')}`,
    }
  }

  // ── FOLLOW THE PAGES THAT CARRY DATES ────────────────────────────────────
  //
  // A homepage has no dated content, which is why the website contributed 1 candidate in
  // 395 and zero events on 2026-09-21 even for the 16 sites that fetched successfully.
  // The dates are one click away and were never opened.
  //
  // Failures here are recorded and never fatal to the source: the homepage already
  // succeeded, so a blog that 404s means less content, not no content.
  const links = findContentLinks(home.html, url)
  const pages_followed: string[] = []
  const posts: WebsitePost[] = []
  const sections = [home.text]

  const deadline = Date.now() + SOURCE_DEADLINE_MS
  for (const link of links) {
    // Checked BEFORE each fetch rather than after, so the deadline bounds what is
    // STARTED. Checking after would let a 25s page begin one millisecond inside the
    // budget and blow it anyway, which is a deadline that reports rather than limits.
    if (Date.now() > deadline) {
      reasons.push(`followed pages stopped at the ${SOURCE_DEADLINE_MS}ms source deadline, ${links.length - pages_followed.length} link(s) not opened`)
      break
    }
    const page = await fetchPage(link, FOLLOWED_PAGE_CHARS, reasons, `followed ${link}`)
    if (!page) continue
    pages_followed.push(link)
    sections.push(`\n\n--- ${link} ---\n${page.text}`)
    posts.push(...findDatedPosts(page.html, link))
  }

  // Newest first, so the five the model reads are the five that matter.
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  logger.debug('research/website: fetched', {
    url,
    method: home.method,
    pages_followed: pages_followed.length,
    posts_found: posts.length,
    newest_post: posts[0]?.date ?? null,
  })

  return {
    available: true,
    url,
    content: sections.join(''),
    fetch_method: home.method,
    pages_followed,
    posts,
    // Recorded even on success: a homepage that worked while its blog 404'd is worth
    // being able to see later, and `available: true` would otherwise hide it. It goes in
    // its own field rather than `error`, for the reason stated on the type.
    ...(reasons.length ? { partial_reasons: reasons } : {}),
  }
}
