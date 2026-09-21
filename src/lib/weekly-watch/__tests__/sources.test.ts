// The collectors, tested at the seam where a failure turns into a reading.
//
// THE FAKES THROW ON ANYTHING THEY DO NOT IMPLEMENT. A fake that silently returns its
// chain for an unimplemented filter cannot test that filter, and CLAUDE.md records three
// separate guards that shipped unprotected behind exactly that. If a collector starts
// calling a new method, these tests fail loudly rather than passing against a stub.

import { describe, expect, it } from 'vitest'
import {
  collectAccounts,
  collectBounces,
  collectBurnPerWeek,
  collectInventory,
  collectLeadCapacity,
  collectWarmupCanary,
  fetchCampaign,
  findLiveCampaign,
  rampFrom,
} from '../sources'
import type { ProviderAccount, ProviderWarmup, WatchProvider } from '../types'

/** A provider whose unimplemented methods throw rather than returning something plausible. */
function fakeProvider(overrides: Partial<WatchProvider>): WatchProvider {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`fake provider does not implement ${name} — the collector changed`)
  }
  return {
    fetchWarmupPlacement:   overrides.fetchWarmupPlacement   ?? refuse('fetchWarmupPlacement'),
    fetchAccountStatuses:   overrides.fetchAccountStatuses   ?? refuse('fetchAccountStatuses'),
    fetchCampaignShape:     overrides.fetchCampaignShape     ?? refuse('fetchCampaignShape'),
    fetchPlanId:            overrides.fetchPlanId            ?? refuse('fetchPlanId'),
    fetchCampaignLeadCounts: overrides.fetchCampaignLeadCounts ?? refuse('fetchCampaignLeadCounts'),
  } as WatchProvider
}

function warmup(sent: number, inbox: number, spam: number, health: number | null = 100): ProviderWarmup {
  return { sent, landedInbox: inbox, landedSpam: spam, healthScore: health }
}

function account(active: boolean, warmupActive = true): ProviderAccount {
  return { active, warmupActive }
}

/** Minimal thenable Supabase chain; throws on any method the collector did not declare. */
function chain(result: Record<string, unknown>) {
  // 'not' is here because applySendGate uses it. It THROWS on anything else, deliberately:
  // a chainable proxy that silently returned itself would accept a filter that never ran
  // and prove only that the code path executed.
  const allowed = new Set(['select', 'eq', 'gte', 'lte', 'order', 'limit', 'not'])
  const proxy: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
      if (allowed.has(prop)) return () => proxy
      throw new Error(`fake supabase does not implement .${prop}()`)
    },
  })
  return proxy
}

function fakeDb(...results: Record<string, unknown>[]) {
  let i = 0
  return { from: () => chain(results[Math.min(i++, results.length - 1)]) } as never
}

describe('collectWarmupCanary', () => {
  it('reports a mailbox the provider did not return as missing, never as zero spam', async () => {
    const provider = fakeProvider({
      fetchWarmupPlacement: async () => new Map([['a@x.com', warmup(70, 70, 0)]]),
    })

    const r = await collectWarmupCanary(provider, ['a@x.com', 'b@x.com'])

    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.value.missing).toEqual(['b@x.com'])
    // b@x.com contributes nothing rather than contributing a comforting zero.
    expect(r.value.mailboxes).toHaveLength(1)
  })

  it('totals landed_spam across mailboxes', async () => {
    const provider = fakeProvider({
      fetchWarmupPlacement: async () => new Map([
        ['a@x.com', warmup(70, 68, 2)],
        ['b@x.com', warmup(70, 69, 1)],
      ]),
    })
    const r = await collectWarmupCanary(provider, ['a@x.com', 'b@x.com'])
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.value.totalLandedSpam).toBe(3)
  })

  it('is unknown, not zero, when the provider throws', async () => {
    const provider = fakeProvider({
      fetchWarmupPlacement: async () => { throw new Error('HTTP 503: upstream exploded') },
    })
    const r = await collectWarmupCanary(provider, ['a@x.com'])
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('503')
  })

  it('is unknown when no mailbox in the list came back usable', async () => {
    const provider = fakeProvider({ fetchWarmupPlacement: async () => new Map() })
    const r = await collectWarmupCanary(provider, ['a@x.com'])
    expect(r.status).toBe('unknown')
  })

  it('is unknown when there are no mailboxes to ask about', async () => {
    const r = await collectWarmupCanary(fakeProvider({}), [])
    expect(r.status).toBe('unknown')
  })
})

describe('collectBounces', () => {
  const NOW = new Date('2026-09-17T13:00:00.000Z')
  const ROW = { stat_date: '2026-09-15', sending_domain: 'a.com', sends: 12, bounces: 0 }

  it('is unknown when the stats table has stopped being written to', async () => {
    const stale = '2026-09-10T00:00:00.000Z' // 7 days old, past the 48h limit
    const db = fakeDb(
      { data: [{ ...ROW, fetched_at: stale }], error: null },
      { data: [{ fetched_at: stale }], error: null },
    )
    const r = await collectBounces(db, NOW)
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('stale')
    expect(r.reason).toContain('means nothing')
  })

  it('is unknown when the query errors, rather than reporting no bounces', async () => {
    const db = fakeDb({ data: null, error: { code: '42501', message: 'permission denied' } })
    const r = await collectBounces(db, NOW)
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('42501')
  })

  it('is unknown when the sync has never run at all', async () => {
    const db = fakeDb({ data: [], error: null }, { data: [], error: null })
    const r = await collectBounces(db, NOW)
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('never run')
  })

  it('reads fresh rows and keeps insufficient_sends distinct from clean', async () => {
    const fresh = '2026-09-17T12:00:00.000Z'
    const db = fakeDb(
      { data: [{ ...ROW, fetched_at: fresh }], error: null },
      { data: [{ fetched_at: fresh }], error: null },
    )
    const r = await collectBounces(db, NOW)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // 12 sends is under the 50 floor: not healthy, not a breach.
    expect(r.value.verdict.state).toBe('insufficient_sends')
  })
})

describe('collectBurnPerWeek', () => {
  it('returns null, not zero, when nothing was uploaded in the lookback', async () => {
    const r = await collectBurnPerWeek(fakeDb({ count: 0, error: null }), new Date(), 'org-1')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // Zero burn would divide into infinite runway, the most reassuring number on the report.
    expect(r.value).toBeNull()
  })

  it('converts a 28-day count into a weekly rate', async () => {
    const r = await collectBurnPerWeek(fakeDb({ count: 120, error: null }), new Date(), 'org-1')
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.value).toBe(30)
  })

  it('is unknown when the query errors', async () => {
    const r = await collectBurnPerWeek(fakeDb({ count: null, error: { code: 'PGRST301', message: 'jwt expired' } }), new Date(), 'org-1')
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('PGRST301')
  })
})

describe('collectInventory', () => {
  it('is unknown when the query errors rather than reporting zero pending', async () => {
    const r = await collectInventory(fakeDb({ count: null, error: { code: '08006', message: 'connection failure' } }), 30, 'org-1')
    expect(r.status).toBe('unknown')
  })

  it('leaves weeksOfInventory null when burn is unknown', async () => {
    const r = await collectInventory(fakeDb({ count: 197, error: null }), null, 'org-1')
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.value.pending).toBe(197)
    expect(r.value.weeksOfInventory).toBeNull()
  })
})

describe('collectLeadCapacity', () => {
  it('refuses to report a limit when the plan is not the one it was measured for', async () => {
    const provider = fakeProvider({ fetchPlanId: async () => 'pid_hg_v1' })
    const r = await collectLeadCapacity(provider, 30)
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('pid_hg_v1')
    expect(r.reason).toContain('Re-measure')
  })

  it('sums leads across campaigns on the measured plan', async () => {
    const provider = fakeProvider({
      fetchPlanId: async () => 'pid_g_v2',
      fetchCampaignLeadCounts: async () => [95, 5],
    })
    const r = await collectLeadCapacity(provider, 30)
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.value.used).toBe(100)
    expect(r.value.remaining).toBe(900)
    expect(r.value.weeksRemaining).toBe(30)
  })

  it('is unknown when the plan call fails', async () => {
    const provider = fakeProvider({ fetchPlanId: async () => { throw new Error('HTTP 500') } })
    expect((await collectLeadCapacity(provider, 30)).status).toBe('unknown')
  })
})

describe('collectAccounts', () => {
  it('reports a campaign sender the provider never listed as missing', async () => {
    const provider = fakeProvider({
      fetchAccountStatuses: async () => new Map([['a@x.com', account(true)]]),
    })
    const r = await collectAccounts(provider, ['a@x.com', 'gone@x.com'])
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.value.missing).toEqual(['gone@x.com'])
  })

  it('flags an inactive sender', async () => {
    const provider = fakeProvider({
      fetchAccountStatuses: async () => new Map([['a@x.com', account(false)]]),
    })
    const r = await collectAccounts(provider, ['a@x.com'])
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.value.inactive).toEqual(['a@x.com'])
  })

  it('is unknown when the provider throws', async () => {
    const provider = fakeProvider({
      fetchAccountStatuses: async () => { throw new Error('HTTP 401') },
    })
    expect((await collectAccounts(provider, ['a@x.com'])).status).toBe('unknown')
  })

  it('is unknown when the provider listed none of the senders', async () => {
    const provider = fakeProvider({ fetchAccountStatuses: async () => new Map() })
    expect((await collectAccounts(provider, ['a@x.com'])).status).toBe('unknown')
  })
})

describe('fetchCampaign and rampFrom', () => {
  it('turns a provider throw into a stated reason', async () => {
    const provider = fakeProvider({
      fetchCampaignShape: async () => { throw new Error('HTTP 404: campaign not found') },
    })
    const r = await fetchCampaign(provider, 'abc')
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('404')
  })

  it('derives per-mailbox and per-domain figures from the sender list', () => {
    const ramp = rampFrom({
      dailyLimit: 40,
      senders: [
        'a@one.com', 'b@one.com', 'a@two.com', 'b@two.com', 'a@three.com',
        'b@three.com', 'a@four.com', 'b@four.com', 'a@five.com', 'b@five.com',
      ],
    })
    expect(ramp.mailboxCount).toBe(10)
    expect(ramp.domainCount).toBe(5)
    expect(ramp.perMailboxPerDay).toBe(4)
    expect(ramp.perDomainPerWeek).toBe(40)
    expect(ramp.rung).toBe(2)
    expect(ramp.nextRung).toBe(55)
  })
})

describe('findLiveCampaign', () => {
  it('is unknown when more than one active campaign exists, rather than picking one', async () => {
    const db = fakeDb({
      data: [{ external_id: 'a', name: 'A', status: 'active' }, { external_id: 'b', name: 'B', status: 'active' }],
      error: null,
    })
    const r = await findLiveCampaign(db)
    expect(r.status).toBe('unknown')
    if (r.status !== 'unknown') return
    expect(r.reason).toContain('cannot choose')
  })

  it('is unknown when the query errors', async () => {
    const db = fakeDb({ data: null, error: { code: '42P01', message: 'relation does not exist' } })
    expect((await findLiveCampaign(db)).status).toBe('unknown')
  })

  it('is unknown when there is no active campaign', async () => {
    expect((await findLiveCampaign(fakeDb({ data: [], error: null }))).status).toBe('unknown')
  })
})

// ─── The supply number is scoped and gated ────────────────────────────────────
//
// collectInventory counted `outbound_upload_status = 'pending'` across EVERY organisation
// and with none of the send gate, so it answered "how many prospect rows exist" and
// printed it as this client's remaining supply. Measured platform-wide it reported 176
// pending where none were actually sendable.
//
// The fake above cannot test this: it returns the same result whatever is filtered, so a
// test written against it would pass with every filter deleted. That is the exact shape
// CLAUDE.md warns about. This one RECORDS the filters instead, so the assertions are
// about the query that was built rather than about the number handed back.

function recordingDb(result: Record<string, unknown>) {
  const calls: { method: string; args: unknown[] }[] = []
  const allowed = new Set(['select', 'eq', 'gte', 'lte', 'order', 'limit', 'not'])
  const proxy: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
      if (allowed.has(prop)) {
        return (...args: unknown[]) => { calls.push({ method: prop, args }); return proxy }
      }
      throw new Error(`fake supabase does not implement .${prop}()`)
    },
  })
  return { db: { from: () => proxy } as never, calls }
}

const applied = (calls: { method: string; args: unknown[] }[], method: string) =>
  calls.filter(c => c.method === method).map(c => c.args)

describe('collectInventory scopes and gates the supply number', () => {
  it('filters to the campaign organisation', async () => {
    const { db, calls } = recordingDb({ count: 12, error: null })
    const r = await collectInventory(db, 4, 'org-under-test')
    expect(r.status).toBe('ok')
    // CONTROL: the recorder saw the query being built at all. Without this, every
    // assertion below would also pass against a fake that recorded nothing.
    expect(calls.length).toBeGreaterThan(0)
    expect(applied(calls, 'eq')).toContainEqual(['organisation_id', 'org-under-test'])
  })

  it('applies the send gate rather than counting every pending row', async () => {
    const { db, calls } = recordingDb({ count: 12, error: null })
    await collectInventory(db, 4, 'org-under-test')
    const eqs = applied(calls, 'eq')
    // The clauses applySendGate owns. Asserted individually so a partial gate fails.
    expect(eqs).toContainEqual(['outbound_upload_status', 'pending'])
    expect(eqs).toContainEqual(['email_send_eligible', true])
    expect(eqs).toContainEqual(['client_review_status', 'approved'])
    expect(eqs).toContainEqual(['suppressed', false])
    expect(applied(calls, 'not')).toContainEqual(['email', 'is', null])
  })

  it('scopes the burn rate to the same organisation, so the ratio is one population', async () => {
    // weeksOfInventory divides pending by burn. An org-scoped numerator over a
    // platform-wide denominator is the mixed-unit fault in a different coat.
    const { db, calls } = recordingDb({ count: 28, error: null })
    await collectBurnPerWeek(db, new Date(), 'org-under-test')
    expect(calls.length).toBeGreaterThan(0)
    expect(applied(calls, 'eq')).toContainEqual(['organisation_id', 'org-under-test'])
  })
})
