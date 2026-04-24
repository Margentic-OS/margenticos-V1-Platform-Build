// Website source handler for prospect research agent v2.
// Attempts a direct fetch with a real browser user-agent.
// Falls back to Jina.ai Reader (r.jina.ai) which renders JS-heavy and anti-bot sites.
// Never throws — returns available: false on all failure paths.

import { logger } from '@/lib/logger'
import type { ProspectContext, WebsiteSourceResult } from '../types'

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

function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}

async function fetchDirect(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': pickUserAgent(),
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) return null
  const html = await response.text()
  return extractText(html)
}

async function fetchViaJina(url: string): Promise<string | null> {
  // Jina Reader returns clean markdown — no key needed, no HTML parsing required.
  const jinaUrl = `https://r.jina.ai/${url}`
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/markdown,text/plain',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) return null
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed || trimmed.length < 50) return null
  return trimmed.slice(0, 5000)
}

export async function fetchWebsiteSource(prospect: ProspectContext): Promise<WebsiteSourceResult> {
  if (!prospect.company_name) {
    return { available: false, url: null, content: null, fetch_method: null, error: 'No company name' }
  }

  const url = deriveWebsiteUrl(prospect.company_name)

  // Try direct fetch first.
  try {
    const content = await fetchDirect(url)
    if (content && content.length > 100) {
      logger.debug('research/website: direct fetch succeeded', { url, chars: content.length })
      return { available: true, url, content, fetch_method: 'direct' }
    }
  } catch (err) {
    logger.debug('research/website: direct fetch failed, trying Jina', { url, error: String(err) })
  }

  // Fallback: Jina.ai Reader.
  try {
    const content = await fetchViaJina(url)
    if (content && content.length > 100) {
      logger.debug('research/website: Jina fetch succeeded', { url, chars: content.length })
      return { available: true, url, content, fetch_method: 'jina' }
    }
  } catch (err) {
    logger.debug('research/website: Jina fetch failed', { url, error: String(err) })
  }

  return {
    available: false,
    url,
    content: null,
    fetch_method: null,
    error: `Both direct and Jina fetch failed for ${url}`,
  }
}
