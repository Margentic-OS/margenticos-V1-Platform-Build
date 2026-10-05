import { describe, expect, it } from 'vitest'
import {
  activateRegionalCampaigns,
  awaitsFirstLeads,
  computeDailyLimits,
  type AutomationEntry,
  type CampaignControls,
  type ManagedCampaign,
} from '../regional-activation'

const US: ManagedCampaign = { id: 'us', externalId: 'ext-us', name: 'US', regionCountries: null, dailyLimitShare: null, status: 'active', sentCount: 812, autoActivatedAt: null }
const UKIE: ManagedCampaign = { id: 'ukie', externalId: 'ext-ukie', name: 'UK/IE', regionCountries: ['GB', 'IE'], dailyLimitShare: 15, status: 'paused', sentCount: 0, autoActivatedAt: null }

/** A provider in memory. Every call is recorded in order, so the tests can read the sequence. */
function fakeProvider(limits: Record<string, number | null>, opts: { failSet?: string; failActivate?: string; failRead?: string } = {}) {
  const calls: string[] = []
  const active = new Set<string>()
  const controls: CampaignControls = {
    async readDailyLimit(ext) {
      calls.push(`read ${ext}`)
      if (opts.failRead === ext) throw new Error('HTTP 503')
      return limits[ext] ?? null
    },
    async setDailyLimit(ext, n) {
      calls.push(`set ${ext} ${n}`)
      if (opts.failSet === ext) throw new Error('HTTP 500')
      limits[ext] = n
    },
    async activate(ext) {
      calls.push(`activate ${ext}`)
      if (opts.failActivate === ext) throw new Error('HTTP 500')
      active.add(ext)
    },
  }
  return { controls, calls, limits, active }
}

async function run(campaigns: ManagedCampaign[], receivedLeads: string[], provider: ReturnType<typeof fakeProvider>, cap: number | null = 90) {
  const logged: AutomationEntry[] = []
  const marked: string[] = []
  const returned = await activateRegionalCampaigns({
    cap, campaigns, receivedLeads: new Set(receivedLeads), controls: provider.controls,
    log: async e => { logged.push(e) },
    markActivated: async id => { marked.push(id) },
  })
  expect(returned).toEqual(logged)
  return { logged, marked }
}

describe('computeDailyLimits', () => {
  it('a regional campaign with no leads leaves the catch-all the whole cap', () => {
    const r = computeDailyLimits(90, [US, UKIE], new Set())
    expect(r.ok && Object.fromEntries(r.limits)).toEqual({ us: 90, ukie: 15 })
  })
  it('once the regional campaign is live the catch-all carries the rest', () => {
    const r = computeDailyLimits(90, [US, UKIE], new Set(['ukie']))
    expect(r.ok && Object.fromEntries(r.limits)).toEqual({ us: 75, ukie: 15 })
    const live = computeDailyLimits(90, [US, { ...UKIE, status: 'active' }], new Set())
    expect(live.ok && live.limits.get('us')).toBe(75)
  })
  it('refuses a regional campaign with no share, and shares that leave the catch-all nothing', () => {
    expect(computeDailyLimits(90, [US, { ...UKIE, dailyLimitShare: null }], new Set(['ukie'])).ok).toBe(false)
    expect(computeDailyLimits(15, [US, UKIE], new Set(['ukie'])).ok).toBe(false)
  })
})

describe('awaitsFirstLeads', () => {
  it('only a paused regional campaign that never sent and was never auto-activated', () => {
    expect(awaitsFirstLeads(UKIE)).toBe(true)
    expect(awaitsFirstLeads(US)).toBe(false)
    expect(awaitsFirstLeads({ ...UKIE, sentCount: 3 })).toBe(false)
    expect(awaitsFirstLeads({ ...UKIE, status: 'active' })).toBe(false)
    // An operator paused it after the upload had switched it on: never switched back on.
    expect(awaitsFirstLeads({ ...UKIE, autoActivatedAt: '2026-10-06T08:00:00Z' })).toBe(false)
  })
})

describe('activateRegionalCampaigns', () => {
  it('PLANTED: first leads to UK/IE: US lowered to 75 FIRST, UK/IE checked at 15, then activated, each logged', async () => {
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 15 })
    const { logged, marked } = await run([US, UKIE], ['ukie', 'us'], p)

    expect(p.calls.filter(c => !c.startsWith('read'))).toEqual(['set ext-us 75', 'activate ext-ukie'])
    expect(marked).toEqual(['ukie'])
    expect(logged.map(e => [e.action, e.campaignId, e.fromValue, e.toValue])).toEqual([
      ['daily_limit_set', 'us', '90', '75'],
      ['activated', 'ukie', 'paused', 'active'],
    ])
  })

  it('PLANTED: a decrease is always applied before an increase, so the total never passes the cap', async () => {
    // UK/IE carries a stale limit of 5; it must go up to 15 only after US has come down.
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 5 })
    await run([UKIE, US], ['ukie'], p)
    expect(p.calls.filter(c => c.startsWith('set'))).toEqual(['set ext-us 75', 'set ext-ukie 15'])
    const usAt = p.calls.indexOf('set ext-us 75')
    expect(p.calls.indexOf('set ext-ukie 15')).toBeGreaterThan(usAt)
    expect(p.calls.at(-1)).toBe('activate ext-ukie')
  })

  it('PLANTED: if lowering US fails, UK/IE is NOT activated', async () => {
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 15 }, { failSet: 'ext-us' })
    const { logged, marked } = await run([US, UKIE], ['ukie'], p)
    expect(p.active.size).toBe(0)
    expect(marked).toEqual([])
    expect(logged).toEqual([expect.objectContaining({ action: 'failed', campaignId: 'us', toValue: '75' })])
  })

  it('a failed limit read changes nothing and activates nothing', async () => {
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 15 }, { failRead: 'ext-us' })
    const { logged } = await run([US, UKIE], ['ukie'], p)
    expect(p.calls.some(c => c.startsWith('set') || c.startsWith('activate'))).toBe(false)
    expect(logged[0].action).toBe('failed')
  })

  it('a failed activation is logged and the campaign is not marked activated', async () => {
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 15 }, { failActivate: 'ext-ukie' })
    const { logged, marked } = await run([US, UKIE], ['ukie'], p)
    expect(marked).toEqual([])
    expect(logged.at(-1)).toEqual(expect.objectContaining({ action: 'failed', campaignId: 'ukie' }))
  })

  it('PLANTED: no cap configured: refused and left paused, nothing touched', async () => {
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 15 })
    const { logged } = await run([US, UKIE], ['ukie'], p, null)
    expect(p.calls).toEqual([])
    expect(logged).toEqual([expect.objectContaining({ action: 'refused', campaignId: 'ukie' })])
    expect(logged[0].detail).toMatch(/outbound_daily_cap/)
  })

  it('PLANTED: an upload that gave UK/IE no leads does nothing at all', async () => {
    const p = fakeProvider({ 'ext-us': 90, 'ext-ukie': 15 })
    const { logged } = await run([US, UKIE], ['us'], p)
    expect(p.calls).toEqual([])
    expect(logged).toEqual([])
  })

  it('a campaign already live, or paused by an operator after activation, is never re-activated', async () => {
    for (const ukie of [{ ...UKIE, status: 'active', sentCount: 40 }, { ...UKIE, autoActivatedAt: '2026-10-06T08:00:00Z' }]) {
      const p = fakeProvider({ 'ext-us': 75, 'ext-ukie': 15 })
      const { logged } = await run([US, ukie], ['ukie'], p)
      expect(p.calls).toEqual([])
      expect(logged).toEqual([])
    }
  })

  it('limits already right are not rewritten, and only the activation is logged', async () => {
    const p = fakeProvider({ 'ext-us': 75, 'ext-ukie': 15 })
    const { logged } = await run([US, UKIE], ['ukie'], p)
    expect(p.calls.filter(c => c.startsWith('set'))).toEqual([])
    expect(logged.map(e => e.action)).toEqual(['activated'])
  })
})
