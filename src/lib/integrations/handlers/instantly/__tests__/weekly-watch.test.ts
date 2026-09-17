// The Instantly side of the weekly watch: the quirks that only exist because of this
// vendor, kept here so src/lib/weekly-watch/ never has to know about them.

import { describe, expect, it, vi, afterEach } from 'vitest'
import { createInstantlyWatchProvider } from '../weekly-watch'

const ACCESS = { apiKey: 'test-key', baseUrl: 'https://api.test/v2' }

afterEach(() => { vi.unstubAllGlobals() })

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init)))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('fetchWarmupPlacement', () => {
  it('DERIVES landed_spam when the provider omits it, because it omits it at zero', async () => {
    stubFetch(() => json({ aggregate_data: { 'a@x.com': { sent: 70, landed_inbox: 65, health_score: 90 } } }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchWarmupPlacement(['a@x.com'])
    // The five unaccounted-for sends surface instead of the mailbox reading clean.
    expect(got.get('a@x.com')?.landedSpam).toBe(5)
  })

  it('reads a genuine zero as zero', async () => {
    stubFetch(() => json({ aggregate_data: { 'a@x.com': { sent: 70, landed_inbox: 70 } } }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchWarmupPlacement(['a@x.com'])
    expect(got.get('a@x.com')?.landedSpam).toBe(0)
  })

  it('prefers an explicit landed_spam over the derived one', async () => {
    stubFetch(() => json({ aggregate_data: { 'a@x.com': { sent: 70, landed_inbox: 70, landed_spam: 3 } } }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchWarmupPlacement(['a@x.com'])
    expect(got.get('a@x.com')?.landedSpam).toBe(3)
  })

  it('omits a mailbox whose figures are unusable rather than inventing them', async () => {
    stubFetch(() => json({ aggregate_data: { 'a@x.com': { landed_inbox: 70 } } }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchWarmupPlacement(['a@x.com'])
    expect(got.has('a@x.com')).toBe(false)
  })

  it('throws on a non-2xx so the collector can state the reason', async () => {
    stubFetch(() => json({ message: 'nope' }, 503))
    await expect(createInstantlyWatchProvider(ACCESS).fetchWarmupPlacement(['a@x.com'])).rejects.toThrow('503')
  })
})

describe('fetchAccountStatuses', () => {
  it('TERMINATES ON AN EMPTY PAGE, because a cursor is returned even on the last page', async () => {
    let calls = 0
    stubFetch(() => {
      calls += 1
      return calls === 1
        ? json({ items: [{ email: 'a@x.com', status: 1, warmup_status: 1 }], next_starting_after: 'cursor' })
        : json({ items: [], next_starting_after: 'cursor' })
    })
    const got = await createInstantlyWatchProvider(ACCESS).fetchAccountStatuses()
    expect(calls).toBe(2)
    expect(got.get('a@x.com')).toEqual({ active: true, warmupActive: true })
  })

  it('treats any status other than 1 as inactive', async () => {
    stubFetch(() => json({ items: [{ email: 'a@x.com', status: 2, warmup_status: 0 }] }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchAccountStatuses()
    expect(got.get('a@x.com')).toEqual({ active: false, warmupActive: false })
  })

  it('lowercases the key so a differently-cased sender still matches', async () => {
    stubFetch(() => json({ items: [{ email: 'A@X.com', status: 1, warmup_status: 1 }] }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchAccountStatuses()
    expect(got.has('a@x.com')).toBe(true)
  })
})

describe('fetchCampaignShape', () => {
  it('throws when the campaign carries no numeric daily_limit', async () => {
    stubFetch(() => json({ email_list: ['a@x.com'] }))
    await expect(createInstantlyWatchProvider(ACCESS).fetchCampaignShape('id')).rejects.toThrow('daily_limit')
  })

  it('throws on an empty sender list rather than returning one', async () => {
    stubFetch(() => json({ daily_limit: 40, email_list: [] }))
    await expect(createInstantlyWatchProvider(ACCESS).fetchCampaignShape('id')).rejects.toThrow('empty email_list')
  })

  it('returns the limit and senders', async () => {
    stubFetch(() => json({ daily_limit: 40, email_list: ['a@x.com', 'b@x.com'] }))
    const got = await createInstantlyWatchProvider(ACCESS).fetchCampaignShape('id')
    expect(got).toEqual({ dailyLimit: 40, senders: ['a@x.com', 'b@x.com'] })
  })
})

describe('fetchPlanId and fetchCampaignLeadCounts', () => {
  it('throws when the workspace carries no plan_id', async () => {
    stubFetch(() => json({ name: 'w' }))
    await expect(createInstantlyWatchProvider(ACCESS).fetchPlanId()).rejects.toThrow('plan_id')
  })

  it('accepts a bare array of analytics rows', async () => {
    stubFetch(() => json([{ leads_count: 95 }, { leads_count: 5 }]))
    expect(await createInstantlyWatchProvider(ACCESS).fetchCampaignLeadCounts()).toEqual([95, 5])
  })

  it('accepts a { result: [] } wrapper, so a wrapper change is not an outage', async () => {
    stubFetch(() => json({ result: [{ leads_count: 7 }] }))
    expect(await createInstantlyWatchProvider(ACCESS).fetchCampaignLeadCounts()).toEqual([7])
  })

  it('throws rather than counting a row with no numeric leads_count as zero', async () => {
    stubFetch(() => json([{ leads_count: 95 }, { campaign_id: 'x' }]))
    await expect(createInstantlyWatchProvider(ACCESS).fetchCampaignLeadCounts()).rejects.toThrow('leads_count')
  })
})
