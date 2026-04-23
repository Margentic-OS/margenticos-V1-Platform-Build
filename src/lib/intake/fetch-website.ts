// Website content fetcher for intake ingestion.
//
// Fetches the homepage URL and discovers up to 3 inner pages (About, Services,
// Case Studies) by scoring same-domain anchor tags on the homepage.
//
// Extraction: strips script/style/nav/header/footer, then reads <main>, <article>,
// or <body> fallback. Trimmed to MAX_CHARS_PER_PAGE to stay within prompt budgets.
//
// All failures are non-fatal — each page records its own fetch_status.
// A failed homepage does not prevent inner pages from being skipped; it produces
// a single 'failed' row so the agents can see the attempt was made.

import { parse } from 'node-html-parser'
import { logger } from '@/lib/logger'

const FETCH_TIMEOUT_MS = 10_000
const MAX_CHARS_PER_PAGE = 3_000
const INNER_PAGE_DELAY_MS = 500
const MAX_INNER_PAGES = 3

// Keywords used to score anchor tags when looking for inner pages.
// Higher score = stronger match for a useful inner page.
const PAGE_SCORING: { pattern: RegExp; label: string; score: number }[] = [
  { pattern: /\babout\b/i,                          label: 'about',       score: 10 },
  { pattern: /\bservices?\b/i,                      label: 'services',    score: 10 },
  { pattern: /\bwhat.we.do\b/i,                     label: 'services',    score: 9  },
  { pattern: /\bwork\b/i,                           label: 'case_studies', score: 8  },
  { pattern: /\bcase.stud/i,                        label: 'case_studies', score: 10 },
  { pattern: /\bresults?\b/i,                       label: 'case_studies', score: 7  },
  { pattern: /\bclients?\b/i,                       label: 'case_studies', score: 6  },
  { pattern: /\bsolutions?\b/i,                     label: 'services',    score: 6  },
  { pattern: /\bofferings?\b/i,                     label: 'services',    score: 5  },
]

export interface WebsitePage {
  url: string
  page_label: string
  display_order: number
  fetch_status: 'complete' | 'failed'
  extracted_text: string | null
  error_message: string | null
  fetched_at: string
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function fetchWebsitePages(homepageUrl: string): Promise<WebsitePage[]> {
  const normalised = normaliseUrl(homepageUrl)
  if (!normalised) {
    return [{
      url: homepageUrl,
      page_label: 'homepage',
      display_order: 0,
      fetch_status: 'failed',
      extracted_text: null,
      error_message: 'invalid_url',
      fetched_at: new Date().toISOString(),
    }]
  }

  const pages: WebsitePage[] = []

  // Fetch homepage first — also need the HTML to discover inner pages
  const { page: homePage, html: homepageHtml } = await fetchPage(normalised, 'homepage', 0)
  pages.push(homePage)

  if (homepageHtml && pages[0].fetch_status === 'complete') {
    const innerLinks = discoverInnerPages(normalised, homepageHtml)
    let order = 1
    for (const link of innerLinks.slice(0, MAX_INNER_PAGES)) {
      await delay(INNER_PAGE_DELAY_MS)
      const { page } = await fetchPage(link.url, link.label, order)
      pages.push(page)
      order++
    }
  }

  return pages
}

// ─── Fetch a single page ──────────────────────────────────────────────────────

async function fetchPage(
  url: string,
  label: string,
  order: number
): Promise<{ page: WebsitePage; html: string | null }> {
  const fetched_at = new Date().toISOString()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Identify as a real browser to avoid the most common bot blocks
        'User-Agent': 'Mozilla/5.0 (compatible; MargenticOS/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timer)

    if (!res.ok) {
      logger.warn('fetch-website: non-OK response', { url, status: res.status })
      return {
        page: {
          url, page_label: label, display_order: order,
          fetch_status: 'failed',
          extracted_text: null,
          error_message: `http_${res.status}`,
          fetched_at,
        },
        html: null,
      }
    }

    const html = await res.text()
    const extracted = extractText(html)

    return {
      page: {
        url, page_label: label, display_order: order,
        fetch_status: 'complete',
        extracted_text: extracted || null,
        error_message: null,
        fetched_at,
      },
      html,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    logger.warn('fetch-website: fetch error', { url, error: String(err) })
    return {
      page: {
        url, page_label: label, display_order: order,
        fetch_status: 'failed',
        extracted_text: null,
        error_message: isTimeout ? 'timeout' : 'fetch_error',
        fetched_at,
      },
      html: null,
    }
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractText(html: string): string {
  const root = parse(html)

  // Remove noise nodes — scripts, styles, nav chrome, cookie banners
  for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'noscript', 'iframe']) {
    root.querySelectorAll(tag).forEach(n => n.remove())
  }

  // Prefer <main> or <article> for content density; fall back to <body>
  const content =
    root.querySelector('main') ??
    root.querySelector('article') ??
    root.querySelector('body') ??
    root

  const text = content.innerText
    .replace(/\s{2,}/g, ' ')   // collapse whitespace
    .replace(/\n{3,}/g, '\n\n') // collapse blank lines
    .trim()

  return text.slice(0, MAX_CHARS_PER_PAGE)
}

// ─── Inner page discovery ─────────────────────────────────────────────────────

interface ScoredLink { url: string; label: string; score: number }

function discoverInnerPages(baseUrl: string, html: string): ScoredLink[] {
  const root = parse(html)
  const base = new URL(baseUrl)
  const seen = new Set<string>()
  const scored: ScoredLink[] = []

  root.querySelectorAll('a[href]').forEach(el => {
    const href = el.getAttribute('href') ?? ''
    let resolved: URL
    try {
      resolved = new URL(href, base)
    } catch {
      return
    }

    // Same domain only, no fragments, no anchors to the homepage itself
    if (resolved.hostname !== base.hostname) return
    if (resolved.pathname === '/' || resolved.pathname === '') return
    if (resolved.pathname === base.pathname) return

    const canonical = resolved.origin + resolved.pathname
    if (seen.has(canonical)) return
    seen.add(canonical)

    const text = (el.innerText + ' ' + href).toLowerCase()
    let bestScore = 0
    let bestLabel = ''

    for (const { pattern, label, score } of PAGE_SCORING) {
      if (pattern.test(text) && score > bestScore) {
        bestScore = score
        bestLabel = label
      }
    }

    if (bestScore > 0) {
      scored.push({ url: canonical, label: bestLabel, score: bestScore })
    }
  })

  // Sort descending by score; deduplicate by label (keep highest score per label)
  scored.sort((a, b) => b.score - a.score)
  const byLabel = new Map<string, ScoredLink>()
  for (const link of scored) {
    if (!byLabel.has(link.label)) byLabel.set(link.label, link)
  }

  return Array.from(byLabel.values()).sort((a, b) => b.score - a.score)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  const withScheme = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    // Only allow http/https
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
