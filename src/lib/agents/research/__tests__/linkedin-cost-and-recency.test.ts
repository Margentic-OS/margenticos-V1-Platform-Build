// POSITIVE CONTROLS for the LinkedIn cost and recency fixes.
//
// Every assertion here is written against a DEFECT THAT SHIPPED, named in the comment, so
// a future reader can tell what each one is holding shut.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MAX_POSTS, POSTED_WITHIN_DAYS, postedDate } from '../sources/linkedin'
import { COST_APIFY } from '../cost-constants'

// The actor's published pay-per-event prices, read from the Apify API on 2026-09-23.
const PRICE_ACTOR_START = 0.00005
const PRICE_PER_POST    = 0.002

describe('what we pay for is what we read', () => {
  it('COST_APIFY is the ceiling implied by MAX_POSTS, not a stale price', () => {
    // THE DEFECT: COST_APIFY was 0.002, citing a per-dataset-item price the actor stopped
    // using on 2026-03-09. Measured actual was $0.0795, so every cost model built on it
    // was 20x low. This ties the constant to the setting that determines it, so the two
    // cannot drift again without a test going red.
    expect(COST_APIFY).toBeCloseTo(PRICE_ACTOR_START + MAX_POSTS * PRICE_PER_POST, 6)
  })

  it('MAX_POSTS is what the formatter reads, so nothing is bought and discarded', () => {
    // THE DEFECT: maxPosts was unset, the actor returned up to 50, and formatPostsData
    // used posts.slice(0, 5). 90% of the spend bought posts nothing read.
    expect(MAX_POSTS).toBe(5)
  })

  it('the old price would now fail this test', () => {
    // A control on the control: proves the assertion above can actually discriminate.
    expect(0.002).not.toBeCloseTo(PRICE_ACTOR_START + MAX_POSTS * PRICE_PER_POST, 6)
  })
})

describe('the post date survives the formatter', () => {
  it('reads the real date out of the postedAt OBJECT', () => {
    // THE DEFECT: postedAt is { date, timestamp, postedAgoText } and was interpolated
    // straight into a template literal, so every line read `Post ([object Object])`.
    // Measured: all 5,174 stored posts carry a real date, and the model saw none of them.
    const post = { postedAt: { date: '2026-08-25T16:01:20.163Z', timestamp: 1787673680163, postedAgoText: '3 weeks ago' } }
    expect(postedDate(post)).toBe('2026-08-25')
    expect(String(postedDate(post))).not.toContain('[object Object]')
  })

  it('falls back to the timestamp, then to flatter shapes', () => {
    expect(postedDate({ postedAt: { timestamp: 1787673680163 } })).toBe('2026-08-25')
    expect(postedDate({ postedDate: '2026-07-04' })).toBe('2026-07-04')
    expect(postedDate({ date: '2026-07-04T00:00:00Z' })).toBe('2026-07-04')
    expect(postedDate({ postedAt: '2026-07-04' })).toBe('2026-07-04')
  })

  it('returns null rather than a plausible-looking wrong date', () => {
    // An undated post must not be handed a placeholder. `new Date({})` is Invalid Date
    // rather than a throw, which is exactly how the original defect stayed silent.
    expect(postedDate({})).toBeNull()
    expect(postedDate({ postedAt: { postedAgoText: '3 weeks ago' } })).toBeNull()
    expect(postedDate({ postedAt: 'not a date at all' })).toBeNull()
  })
})

describe('the recency window is sent, not asserted', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { process.env.APIFY_API_KEY = 'test-token' })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it('sends maxPosts and a postedLimitDate computed from POSTED_WITHIN_DAYS', async () => {
    // THE DEFECT: the output said "(last 60 days)" as a hardcoded string while no date
    // filter was ever sent. 82% of the posts pulled were older than 90 days.
    let sentBody: any = null
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => '[]', json: async () => ([
        { text: 'a post', postedAt: { date: '2026-09-01T00:00:00Z' } },
      ]) }
    }) as never

    const { fetchLinkedInSource } = await import('../sources/linkedin')
    const result = await fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never)

    expect(sentBody.maxPosts).toBe(MAX_POSTS)
    expect(sentBody.postedLimitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const cutoff = new Date(sentBody.postedLimitDate).getTime()
    const expected = Date.now() - POSTED_WITHIN_DAYS * 86_400_000
    expect(Math.abs(cutoff - expected)).toBeLessThan(2 * 86_400_000)

    // And the LABEL names the window that was sent, rather than a different one.
    expect(result.formatted).toContain(`last ${POSTED_WITHIN_DAYS} days`)
    expect(result.formatted).not.toContain('last 60 days')
    expect(result.formatted).toContain('(2026-09-01)')
    expect(result.formatted).not.toContain('[object Object]')
  })
})
