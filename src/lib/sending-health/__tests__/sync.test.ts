import { describe, it, expect, vi } from 'vitest'
import { fetchWindow, resolveSendingHealthProvider, syncSendingHealth } from '../sync'
import { chunkDateRange } from '@/lib/integrations/handlers/instantly/sending-health'
import { FETCH_LOOKBACK_DAYS, PROVIDER_MAX_RANGE_DAYS } from '../thresholds'

/**
 * The sync layer, with the database and the provider both faked.
 *
 * Idempotency is DEMONSTRATED against the live table by running the backfill three times
 * and comparing a fingerprint; see the session report. What is tested here is the thing
 * that makes that possible: the upsert targets the (stat_date, mailbox) constraint, and
 * the verdict is recomputed from the whole window rather than from the rows just fetched.
 */

const NOW = new Date('2026-08-27T12:00:00.000Z')

// ── A minimal Supabase double ────────────────────────────────────────────────
interface Captured {
  upserts: Array<{ table: string; payload: unknown; options: unknown }>
}

function fakeSupabase(opts: {
  registry?: { tool_name: string; is_active: boolean } | null
  windowRows?: Array<{ stat_date: string; sending_domain: string; sends: number; bounces: number }>
  captured: Captured
}) {
  const { registry = { tool_name: 'instantly', is_active: true }, windowRows = [], captured } = opts

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq:     () => builder,
        gte:    () => builder,
        lte:    () => builder,
        maybeSingle: async () =>
          table === 'integrations_registry' ? { data: registry, error: null } : { data: null, error: null },
        upsert: async (payload: unknown, options: unknown) => {
          captured.upserts.push({ table, payload, options })
          return { error: null }
        },
        then: undefined,
      }
      // The window read is awaited directly off the chain rather than via maybeSingle.
      if (table === 'sending_mailbox_daily_stats') {
        builder.lte = () => Promise.resolve({ data: windowRows, error: null })
      }
      return builder
    },
  } as never
}

describe('fetchWindow', () => {
  it(`covers ${FETCH_LOOKBACK_DAYS} days inclusive, ending today`, () => {
    expect(fetchWindow(NOW)).toEqual({ start: '2026-08-25', end: '2026-08-27' })
  })

  it('is three days, not one, so a late-attributed bounce still lands', () => {
    // A bounce can be attributed to the day the SEND happened rather than the day it
    // arrived. A one-day lookback would never revisit that day and would lose it.
    expect(FETCH_LOOKBACK_DAYS).toBeGreaterThanOrEqual(3)
  })

  it('respects an explicit lookback', () => {
    expect(fetchWindow(NOW, 1)).toEqual({ start: '2026-08-27', end: '2026-08-27' })
  })
})

describe('chunkDateRange', () => {
  it('returns a single chunk when the range fits', () => {
    expect(chunkDateRange('2026-08-21', '2026-08-27')).toEqual([{ start: '2026-08-21', end: '2026-08-27' }])
  })

  it(`splits at the provider's ${PROVIDER_MAX_RANGE_DAYS}-day ceiling`, () => {
    // Measured, not assumed: the live API answered HTTP 400 "range cannot exceed 31 days".
    const chunks = chunkDateRange('2026-01-01', '2026-03-31')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      const days = (Date.parse(c.end) - Date.parse(c.start)) / 86_400_000 + 1
      expect(days).toBeLessThanOrEqual(PROVIDER_MAX_RANGE_DAYS)
    }
  })

  it('covers the whole range with no gaps and no overlaps', () => {
    const chunks = chunkDateRange('2026-01-01', '2026-03-31')
    expect(chunks[0].start).toBe('2026-01-01')
    expect(chunks[chunks.length - 1].end).toBe('2026-03-31')
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = Date.parse(chunks[i - 1].end)
      const thisStart = Date.parse(chunks[i].start)
      expect(thisStart - prevEnd).toBe(86_400_000)  // exactly one day, so contiguous
    }
  })

  it('returns nothing when the range is inverted', () => {
    expect(chunkDateRange('2026-03-31', '2026-01-01')).toEqual([])
  })

  it('throws on an unparseable date rather than silently fetching nothing', () => {
    expect(() => chunkDateRange('not-a-date', '2026-01-01')).toThrow()
  })
})

describe('resolveSendingHealthProvider', () => {
  it('returns null when no tool is registered', async () => {
    const captured: Captured = { upserts: [] }
    const provider = await resolveSendingHealthProvider(fakeSupabase({ registry: null, captured }))
    expect(provider).toBeNull()
  })

  it('returns null when the registered tool is inactive', async () => {
    const captured: Captured = { upserts: [] }
    const provider = await resolveSendingHealthProvider(
      fakeSupabase({ registry: { tool_name: 'instantly', is_active: false }, captured })
    )
    expect(provider).toBeNull()
  })

  it('throws loudly for a registered tool with no handler, rather than falling back', async () => {
    // A silent default would produce numbers from the wrong place with nothing to say so.
    const captured: Captured = { upserts: [] }
    await expect(
      resolveSendingHealthProvider(fakeSupabase({ registry: { tool_name: 'some-other-tool', is_active: true }, captured }))
    ).rejects.toThrow(/no handler is wired/)
  })
})

describe('syncSendingHealth', () => {
  it('upserts on the constraint that makes it idempotent, and recomputes from the WHOLE window', async () => {
    vi.resetModules()
    // Fake the tool handler so the capability resolves without a network or a key.
    vi.doMock('@/lib/integrations/handlers/instantly/sending-health', () => ({
      fetchSendingHealth: async () => ({
        // Three days fetched...
        rows: [
          { mailbox: 'a@d1.com', statDate: '2026-08-27', domain: 'd1.com', sends: 5, bounces: 0 },
        ],
        mailboxCount: 1,
        dropped: [],
      }),
    }))
    vi.doMock('@/lib/integrations/handlers/instantly/auth', () => ({
      getInstantlyApiKey: async () => 'test-key',
      getInstantlyApiActive: async () => true,
    }))
    vi.doMock('@/lib/integrations/handlers/instantly/constants', () => ({
      resolveInstantlyBaseUrl: () => 'https://example.invalid',
    }))

    const { syncSendingHealth: sync } = await import('../sync')

    const captured: Captured = { upserts: [] }
    // ...but SEVEN days already in the table. 60 sends clears the 50 floor, so the verdict
    // must be 'healthy'. If the recompute judged only the fetched rows it would see 5
    // sends, fall under the floor, and say 'insufficient_sends' instead.
    const supabase = fakeSupabase({
      captured,
      windowRows: [
        { stat_date: '2026-08-22', sending_domain: 'd1.com', sends: 55, bounces: 1 },
        { stat_date: '2026-08-27', sending_domain: 'd1.com', sends: 5,  bounces: 0 },
      ],
    })

    const result = await sync(supabase, { now: NOW })

    expect(result.errors).toEqual([])
    expect(result.verdict).toBe('healthy')

    const statsUpsert = captured.upserts.find(u => u.table === 'sending_mailbox_daily_stats')
    expect(statsUpsert, 'daily stats were never upserted').toBeDefined()
    // THE IDEMPOTENCY GUARANTEE, asserted at the call site rather than assumed.
    expect(statsUpsert!.options).toEqual({ onConflict: 'stat_date,mailbox' })

    const snapUpsert = captured.upserts.find(u => u.table === 'sending_health_snapshot')
    expect(snapUpsert, 'verdict was never written').toBeDefined()
    expect(snapUpsert!.options).toEqual({ onConflict: 'id' })
    expect((snapUpsert!.payload as { id: number }).id).toBe(1)

    vi.doUnmock('@/lib/integrations/handlers/instantly/sending-health')
    vi.doUnmock('@/lib/integrations/handlers/instantly/auth')
    vi.doUnmock('@/lib/integrations/handlers/instantly/constants')
  })

  it('never throws, so it cannot abort the poll it rides along with', async () => {
    const captured: Captured = { upserts: [] }
    const supabase = fakeSupabase({ registry: { tool_name: 'broken-tool', is_active: true }, captured })
    const result = await syncSendingHealth(supabase, { now: NOW })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.attempted).toBe(false)
  })

  it('reports not-attempted when nothing is registered, without erroring', async () => {
    const captured: Captured = { upserts: [] }
    const result = await syncSendingHealth(fakeSupabase({ registry: null, captured }), { now: NOW })
    expect(result.attempted).toBe(false)
    expect(result.errors).toEqual([])
  })
})
