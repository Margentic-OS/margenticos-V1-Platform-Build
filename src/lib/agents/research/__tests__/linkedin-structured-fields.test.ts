// POSITIVE CONTROLS for the structured fields the formatter used to drop.
//
// Every fixture is a real shape from the 2026-09-23 payloads.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isReshare } from '../sources/linkedin'

const OK = (posts: unknown[]) => ({
  ok: true, status: 200, text: async () => '[]', json: async () => posts,
})

async function formatOf(posts: unknown[]): Promise<string> {
  const { fetchLinkedInSource } = await import('../sources/linkedin')
  const r = await fetchLinkedInSource({ id: 'p', linkedin_url: 'https://linkedin.com/in/x' } as never)
  return String(r.formatted ?? '')
}

describe('a job share reaches the model with its role', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { process.env.APIFY_API_KEY = 't' })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it('THE MEASURED CASE: prose was "We\'re hiring!" and the role was dropped', async () => {
    // Measured 2026-09-23. The model saw `Post (2026-08-13): We're hiring!` and wrote the
    // candidate "a hiring announcement ... WITH NO ROLE SPECIFIED IN THE AVAILABLE EXCERPT".
    // It was accurate about what it could see. He went to template.
    globalThis.fetch = vi.fn(async () => OK([{
      content: "We're hiring!",
      postedAt: { date: '2026-08-13T20:32:52.018Z' },
      job: { title: 'Controller Engagement Manager', location: 'Baltimore' },
    }])) as never

    const out = await formatOf([])
    expect(out).toContain("We're hiring!")
    expect(out).toContain('role advertised: Controller Engagement Manager')
    expect(out).toContain('Baltimore')
  })

  it('a post whose ONLY content is the job is no longer skipped entirely', async () => {
    // The old guard was `if (!text) continue`, so a job share with no prose vanished.
    globalThis.fetch = vi.fn(async () => OK([{
      postedAt: { date: '2026-07-23T00:00:00Z' },
      job: { title: 'Human Resources Consultant' },
    }])) as never
    const out = await formatOf([])
    expect(out).toContain('role advertised: Human Resources Consultant')
  })

  it('carries article, document and newsletter titles too', async () => {
    globalThis.fetch = vi.fn(async () => OK([
      { content: 'a', postedAt: { date: '2026-08-01T00:00:00Z' }, article: { title: 'The Article Title' } },
      { content: 'b', postedAt: { date: '2026-08-02T00:00:00Z' }, document: { title: 'The Guide Title' } },
      { content: 'c', postedAt: { date: '2026-08-03T00:00:00Z' }, newsletterTitle: 'The Newsletter' },
    ])) as never
    const out = await formatOf([])
    expect(out).toContain('article: The Article Title')
    expect(out).toContain('document: The Guide Title')
    expect(out).toContain('newsletter: The Newsletter')
  })
})

describe('a reshare is never presented as the prospect\'s own post', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { process.env.APIFY_API_KEY = 't' })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  // MEASURED 2026-09-21: on one prospect, 2 of 5 posts were reshares and synthesis built a
  // candidate from each, both phrased as "<name> posted that ...". Both credit the prospect
  // with writing something they only amplified. An opening built on that is confidently
  // wrong about the reader's own life in its first line.
  //
  // The prospect, their company and the reshared partner were named here until 2026-09-23.
  // None of it was load-bearing and this repository is public.
  it.each([
    { repost: true },
    { repostId: 'abc123' },
    { repostedAt: '2026-08-01T00:00:00Z' },
    { repostedBy: { name: 'Someone Else' } },
  ])('detects the reshape shape %j', shape => {
    expect(isReshare({ content: 'x', ...shape })).toBe(true)
  })

  it('an original post is not flagged', () => {
    expect(isReshare({ content: 'x', postedAt: { date: '2026-08-01T00:00:00Z' } })).toBe(false)
    expect(isReshare({ content: 'x', repost: false })).toBe(false)
  })

  it('MARKS rather than drops it, because what they amplify is still a fact about them', async () => {
    globalThis.fetch = vi.fn(async () => OK([{
      content: 'Somebody else wrote this',
      postedAt: { date: '2026-08-01T00:00:00Z' },
      repost: true,
    }])) as never
    const out = await formatOf([])
    expect(out).toContain('Somebody else wrote this')
    expect(out).toContain('RESHARE')
    expect(out).toContain('not their own')
  })

  it('and an original post carries no such mark', async () => {
    globalThis.fetch = vi.fn(async () => OK([{
      content: 'I wrote this myself', postedAt: { date: '2026-08-01T00:00:00Z' },
    }])) as never
    expect(await formatOf([])).not.toContain('RESHARE')
  })
})
