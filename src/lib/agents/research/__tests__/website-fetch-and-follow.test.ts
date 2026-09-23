// POSITIVE CONTROLS for the website fetcher.
//
// Each block names the shipped defect it holds shut. No network: every fetch is stubbed,
// so this runs in the deterministic tier.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withScheme, findContentLinks, findDatedPosts,
  MAX_PAGES_FOLLOWED, HOMEPAGE_CHARS, FOLLOWED_PAGE_CHARS,
} from '../sources/website'

describe('the URL always carries a scheme', () => {
  it('prepends https:// to a bare domain', () => {
    // THE DEFECT, and it is the whole 81% failure rate. fetch('example.com') throws
    // TypeError: Failed to parse URL — it does not attempt a request and returns no
    // status. 67 of 68 failing URLs on 2026-09-21 were bare domains, so the direct path
    // made zero network calls all run: fetch_method was 'jina' 16/16 and 'direct' 0/84.
    expect(withScheme('dentalconsultingco.com')).toBe('https://dentalconsultingco.com')
    expect(withScheme('82i.co')).toBe('https://82i.co')
  })

  it('leaves an existing scheme alone, including http', () => {
    expect(withScheme('https://x.com')).toBe('https://x.com')
    expect(withScheme('http://x.com')).toBe('http://x.com')
  })

  it('a bare domain really does throw from fetch, which is why this matters', async () => {
    // The control that proves the premise, rather than asserting it in a comment.
    await expect(fetch('dentalconsultingco.com')).rejects.toThrow(/Failed to parse URL/)
  })
})

describe('following the pages that carry dates', () => {
  const HOME = `
    <a href="/about">About us</a>
    <a href="/blog">Blog</a>
    <a href="/news/">Latest news</a>
    <a href="/resources/insights">Insights</a>
    <a href="/contact">Contact</a>
    <a href="https://medium.com/@someone/blog">Our blog on Medium</a>
    <a href="mailto:x@y.com">blog us</a>
    <a href="/press">Press</a>
    <a href="/events">Events</a>
  `

  it('finds content links by href or anchor text, and caps them', () => {
    const links = findContentLinks(HOME, 'example.com')
    expect(links.length).toBeLessThanOrEqual(MAX_PAGES_FOLLOWED)
    expect(links.every(l => l.startsWith('https://example.com/'))).toBe(true)
    expect(links.some(l => l.includes('/blog'))).toBe(true)
  })

  it('never leaves the host, and never follows mailto', () => {
    // Off-host links would spend the page budget on content whose dates cannot be
    // attributed to this company.
    const links = findContentLinks(HOME, 'example.com')
    expect(links.some(l => l.includes('medium.com'))).toBe(false)
    expect(links.some(l => l.startsWith('mailto:'))).toBe(false)
  })

  it('ignores a page with no content links at all', () => {
    expect(findContentLinks('<a href="/contact">Contact</a>', 'example.com')).toEqual([])
  })

  it('does not follow the homepage back to itself', () => {
    expect(findContentLinks('<a href="/">blog</a>', 'example.com')).toEqual([])
  })
})

describe('dates are read off the page and never inferred', () => {
  it('reads <time datetime>', () => {
    const html = '<h2>Scaling without hiring</h2><time datetime="2026-08-14T00:00:00Z">14 Aug</time>'
    const posts = findDatedPosts(html, 'https://example.com/blog')
    expect(posts[0].date).toBe('2026-08-14')
    expect(posts[0].page_url).toBe('https://example.com/blog')
  })

  it('reads a prose date and takes the nearest heading as the title', () => {
    const html = '<h3>Our new operating model</h3><p>Posted on March 4, 2026 by the team.</p>'
    const posts = findDatedPosts(html, 'https://example.com/news')
    expect(posts[0].date).toBe('2026-03-04')
    expect(posts[0].title).toContain('operating model')
  })

  it('reads day-first dates too', () => {
    const html = '<h3>A note on pricing</h3><p>4 March 2026</p>'
    expect(findDatedPosts(html, 'p')[0].date).toBe('2026-03-04')
  })

  it('RETURNS NOTHING when there is no date, rather than guessing one', () => {
    // A guessed date is worse than no date: the agent already had one way to assert
    // recency without evidence, and that was the hardcoded "last 60 days" label.
    expect(findDatedPosts('<h2>A post with no date at all</h2><p>body</p>', 'p')).toEqual([])
  })

  it('drops an ORPHAN date that belongs to no entry', () => {
    // FOUND BY MUTATION, 2026-09-23: deleting the title requirement left every test green.
    // A footer line like "Last updated March 4, 2026", or a date sitting under no heading
    // at all, would otherwise be emitted as a post with an empty title, and the research
    // would read it as a dated event. A date is only evidence when it is a date FOR
    // something, and a post we cannot name is not a post.
    expect(findDatedPosts('<p>Last updated March 4, 2026</p>', 'p')).toEqual([])
    expect(findDatedPosts('<div>Site refreshed 12 January 2026</div>', 'p')).toEqual([])
    // And the positive control, so this is not passing because the parser is broken:
    // give the same date a heading and it IS a post.
    expect(findDatedPosts('<h3>A real entry</h3><p>March 4, 2026</p>', 'p')).toHaveLength(1)
  })

  it('drops a date it cannot parse rather than emitting Invalid Date', () => {
    expect(findDatedPosts('<time datetime="not-a-date">x</time>', 'p')).toEqual([])
  })

  it('deduplicates and caps at 10 per page', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      `<h3>Post ${i}</h3><time datetime="2026-0${(i % 9) + 1}-01">d</time>`).join('')
    expect(findDatedPosts(many, 'p').length).toBeLessThanOrEqual(10)
  })
})

describe('the fetcher end to end, with the network stubbed', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it('fetches the homepage, follows links, and returns dated posts', async () => {
    const pages: Record<string, string> = {
      'https://example.com': `<html><body>${'homepage text '.repeat(20)}
        <a href="/blog">Blog</a><a href="/news">News</a></body></html>`,
      'https://example.com/blog': `<html><body>${'blog text '.repeat(20)}
        <h2>Scaling without hiring</h2><time datetime="2026-09-10">Sep 10</time></body></html>`,
      'https://example.com/news': `<html><body>${'news text '.repeat(20)}
        <h2>New office</h2><time datetime="2026-07-02">Jul 2</time></body></html>`,
    }
    globalThis.fetch = vi.fn(async (u: string) => {
      const body = pages[String(u).replace(/\/$/, '')]
      if (!body) return { ok: false, status: 404, text: async () => 'not found' }
      return { ok: true, status: 200, text: async () => body }
    }) as never

    const { fetchWebsiteSource } = await import('../sources/website')
    const r = await fetchWebsiteSource({ id: 'p1', website_url: 'example.com', company_name: 'Example' } as never)

    expect(r.available).toBe(true)
    expect(r.fetch_method).toBe('direct')       // was 0 of 84 before the scheme fix
    expect(r.pages_followed).toHaveLength(2)
    expect(r.posts?.map(p => p.date)).toEqual(['2026-09-10', '2026-07-02'])  // newest first
    expect(r.content).toContain('homepage text')
    expect(r.content).toContain('blog text')
  })

  it('a blog that 404s does not fail the source, and is recorded', async () => {
    globalThis.fetch = vi.fn(async (u: string) => {
      if (String(u).includes('/blog')) return { ok: false, status: 404, text: async () => 'gone' }
      return { ok: true, status: 200, text: async () => `<body>${'home '.repeat(40)}<a href="/blog">Blog</a></body>` }
    }) as never
    const { fetchWebsiteSource } = await import('../sources/website')
    const r = await fetchWebsiteSource({ id: 'p1', website_url: 'example.com' } as never)

    expect(r.available).toBe(true)
    expect(r.pages_followed).toEqual([])
    expect(r.partial_reasons?.join(' ')).toContain('404')
    // NOT in `error`: buildSourceTracking reads that field even on success.
    expect(r.error).toBeUndefined()
  })

  it('caps per page, not per site', async () => {
    const big = 'x'.repeat(50_000)
    globalThis.fetch = vi.fn(async (u: string) => ({
      ok: true, status: 200,
      text: async () => String(u).includes('/blog')
        ? `<body>${big}</body>`
        : `<body>${big}<a href="/blog">Blog</a></body>`,
    })) as never
    const { fetchWebsiteSource } = await import('../sources/website')
    const r = await fetchWebsiteSource({ id: 'p1', website_url: 'example.com' } as never)
    // Homepage cap + one followed page cap, plus the separator line.
    expect(r.content!.length).toBeGreaterThan(HOMEPAGE_CHARS)
    expect(r.content!.length).toBeLessThan(HOMEPAGE_CHARS + FOLLOWED_PAGE_CHARS + 200)
  })
})

describe('the source is bounded in wall clock, so one slow site cannot eat the batch', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.useRealTimers() })

  it('stops following once the deadline passes, and says so', async () => {
    const { SOURCE_DEADLINE_MS } = await import('../sources/website')
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    globalThis.fetch = vi.fn(async (u: string) => {
      // Each followed page "takes" longer than the whole deadline.
      if (!String(u).endsWith('example.com')) now += SOURCE_DEADLINE_MS + 1
      return {
        ok: true, status: 200,
        text: async () => String(u).endsWith('example.com')
          ? `<body>${'home '.repeat(40)}<a href="/blog">Blog</a><a href="/news">News</a><a href="/press">Press</a></body>`
          : `<body>${'page '.repeat(40)}</body>`,
      }
    }) as never

    const { fetchWebsiteSource } = await import('../sources/website')
    const r = await fetchWebsiteSource({ id: 'p1', website_url: 'example.com' } as never)

    // The homepage is never abandoned; it is the part the run needs.
    expect(r.available).toBe(true)
    // One page opened, then the clock stopped the rest.
    expect(r.pages_followed!.length).toBeLessThan(3)
    expect(r.partial_reasons?.join(' ')).toContain('deadline')
    expect(r.partial_reasons?.join(' ')).toContain('not opened')
  })
})
