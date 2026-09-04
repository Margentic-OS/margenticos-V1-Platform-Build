// Tests for carrying a global suppression out to the sending provider.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THESE ARE FOR
//
// A suppression that never reaches the provider stops nothing. The bug these cover is not
// "the provider call is wrong" — provider-suppression.ts has its own tests for that. It is
// that the call USED TO depend on the bounce poller still seeing the bounced lead, so an
// address whose campaign was unregistered, deleted or archived was never carried and
// nothing could ever pick it up.
//
// So every test below drives the REAL carryPendingSuppressions / carryOneSuppression and
// asserts on the rows the production code actually wrote. The provider boundary is mocked;
// nothing else is.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FAKE THROWS ON WHAT IT DOES NOT IMPLEMENT
//
// CLAUDE.md records three cases where a fake quietly accepted a filter it did not honour,
// the test still passed, and deleting the filter from the real query failed nothing. So
// this fake honours eq / is / or / order / limit / count, and THROWS on anything else.
// `limit: () => chain` is the failure; a throw is a better fake than a lie.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE STATE CHANGES ARE MADE BY THE CODE, NOT BY THE SEED
//
// A row seeded as already-carried, then asserted not to be re-carried, passes whether or
// not the filter exists — the assertion agrees with the fixture by construction. So the
// "does not carry twice" test RUNS THE SWEEP TWICE and lets the first run produce the
// state the second run must respect. The same applies to the backoff test, which moves the
// clock rather than seeding a stale timestamp.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

// The provider boundary, and the ONLY thing mocked here.
//
// Typed to the FULL result union rather than letting the default implementation narrow it
// to 'confirmed'. Without this the failure cases below are a type error, and vitest does
// not type-check, so the suite would run green over three broken mockImplementation calls.
type ProviderResult = {
  status: 'not_required' | 'confirmed' | 'failed'
  stoppedLeadIds: string[]
  error: string | null
}
const suppressAddressAtProvider = vi.fn<(...args: never[]) => Promise<ProviderResult>>(
  async () => ({ status: 'confirmed', stoppedLeadIds: ['lead-1'], error: null }),
)
vi.mock('./provider-suppression', () => ({
  suppressAddressAtProvider: (...args: unknown[]) => suppressAddressAtProvider(...(args as [])),
}))

import {
  carryOneSuppression,
  carryPendingSuppressions,
  CARRY_RETRY_BACKOFF_MINUTES,
  CARRY_MAX_PER_RUN,
} from './carry'

// ── The store ─────────────────────────────────────────────────────────────────

interface SuppressionRow {
  id: string
  email: string
  source_org_id: string | null
  source_signal_id: string | null
  created_at: string
  revoked_at: string | null
  carry_status: string | null
  carry_attempted_at: string | null
  carry_error: string | null
}

interface SignalRow {
  id: string
  processed: boolean
  processed_at: string | null
}

interface ProspectRow {
  id: string
  email: string
  organisation_id: string
}

function createFakeSupabase(seed: {
  suppressions?: Partial<SuppressionRow>[]
  signals?: Partial<SignalRow>[]
  prospects?: ProspectRow[]
  failUpdateOn?: string
} = {}) {
  const suppressions: SuppressionRow[] = (seed.suppressions ?? []).map((r, i) => ({
    id: r.id ?? `sup-${i}`,
    email: r.email ?? `a${i}@x.test`,
    source_org_id: r.source_org_id === undefined ? 'org-a' : r.source_org_id,
    source_signal_id: r.source_signal_id === undefined ? `sig-${i}` : r.source_signal_id,
    created_at: r.created_at ?? new Date(Date.now() - 86_400_000).toISOString(),
    revoked_at: r.revoked_at ?? null,
    carry_status: r.carry_status ?? null,
    carry_attempted_at: r.carry_attempted_at ?? null,
    carry_error: r.carry_error ?? null,
  }))

  const signals: SignalRow[] = (seed.signals ?? []).map((r, i) => ({
    id: r.id ?? `sig-${i}`,
    processed: r.processed ?? false,
    processed_at: r.processed_at ?? null,
  }))

  const prospects: ProspectRow[] = seed.prospects ?? []

  // Every predicate the chain has accumulated. Applied for real, never dropped.
  type Pred = (row: Record<string, unknown>) => boolean

  function buildChain(table: string, mode: 'select' | 'update', patch?: Record<string, unknown>) {
    const preds: Pred[] = []
    let limitN: number | null = null
    let headCount = false
    let orderField: string | null = null
    let orderNullsFirst = false

    const rowsFor = (): Record<string, unknown>[] => {
      const source =
        table === 'suppressed_emails' ? suppressions
        : table === 'signals' ? signals
        : table === 'prospects' ? prospects
        : (() => { throw new Error(`fake does not implement table ${table}`) })()
      return source as unknown as Record<string, unknown>[]
    }

    const matched = () => rowsFor().filter(r => preds.every(p => p(r)))

    const chain: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        preds.push(r => r[col] === val)
        return chain
      },
      is(col: string, val: unknown) {
        // PostgREST .is(col, null) means IS NULL.
        preds.push(r => (val === null ? r[col] === null || r[col] === undefined : r[col] === val))
        return chain
      },
      or(expr: string) {
        // Only the one expression the production code uses is understood. Anything else
        // throws rather than being silently treated as "match everything", which is how a
        // fake stops testing the filter it appears to test.
        if (expr !== 'carry_status.is.null,carry_status.eq.failed') {
          throw new Error(`fake does not implement .or(${expr})`)
        }
        preds.push(r => r.carry_status === null || r.carry_status === 'failed')
        return chain
      },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        orderField = col
        orderNullsFirst = opts?.nullsFirst === true
        return chain
      },
      limit(n: number) {
        limitN = n
        return chain
      },
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) headCount = true
        return chain
      },
      // Anything the production code might reach for that is not honoured above.
      not() { throw new Error('fake does not implement .not') },
      in() { throw new Error('fake does not implement .in') },
      lt(col: string, val: unknown) {
        preds.push(r => {
          const v = r[col]
          return typeof v === 'string' && typeof val === 'string' && v < val
        })
        return chain
      },
      single() { throw new Error('fake does not implement .single') },
      maybeSingle() { throw new Error('fake does not implement .maybeSingle') },

      then(resolve: (v: unknown) => unknown) {
        if (mode === 'update') {
          const hits = matched()
          if (seed.failUpdateOn && hits.some(h => h.email === seed.failUpdateOn)) {
            return Promise.resolve({ data: null, error: { message: 'update refused' }, count: null })
              .then(resolve)
          }
          for (const row of hits) Object.assign(row, patch)
          return Promise.resolve({ data: hits, error: null, count: hits.length }).then(resolve)
        }

        let out = matched()

        if (orderField) {
          const f = orderField
          out = [...out].sort((a, b) => {
            const av = a[f] as string | null
            const bv = b[f] as string | null
            if (av === null && bv === null) return 0
            if (av === null) return orderNullsFirst ? -1 : 1
            if (bv === null) return orderNullsFirst ? 1 : -1
            return String(av).localeCompare(String(bv))
          })
        }

        const total = out.length
        if (limitN !== null) out = out.slice(0, limitN)

        return Promise.resolve(
          headCount
            ? { data: null, error: null, count: total }
            : { data: out, error: null, count: total },
        ).then(resolve)
      },
    }

    return chain
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
          const c = buildChain(table, 'select') as any
          return c.select(cols, opts)
        },
        update: (patch: Record<string, unknown>) => buildChain(table, 'update', patch),
        insert: () => { throw new Error('fake does not implement .insert') },
      }
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, suppressions, signals }
}

beforeEach(() => {
  suppressAddressAtProvider.mockClear()
  suppressAddressAtProvider.mockImplementation(async () => ({
    status: 'confirmed',
    stoppedLeadIds: ['lead-1'],
    error: null,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Carrying ──────────────────────────────────────────────────────────────────

describe('carrying a suppression to the provider', () => {
  it('carries an address that has never been carried, and records the outcome on the row', async () => {
    // THE BUG, DIRECTLY. Before this existed, a suppression row whose bounced lead the
    // poller can no longer see was never carried by anything.
    const { client, suppressions } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test' }],
      signals: [{ id: 'sig-0' }],
    })

    const verdict = await carryPendingSuppressions(client)

    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(1)
    expect(suppressAddressAtProvider).toHaveBeenCalledWith(client, 'org-a', 'a@x.test')
    expect(verdict.carriedCount).toBe(1)
    expect(verdict.failedCount).toBe(0)
    expect(suppressions[0].carry_status).toBe('confirmed')
    expect(suppressions[0].carry_attempted_at).not.toBeNull()
    expect(suppressions[0].carry_error).toBeNull()
  })

  it('marks the originating signal processed once the carry lands', async () => {
    // The reply branch has always done this and the bounce branch never did, which is why
    // one bounce signal sat at processed = false for seven days while being enforced.
    const { client, signals } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', source_signal_id: 'sig-0' }],
      signals: [{ id: 'sig-0', processed: false }],
    })

    await carryPendingSuppressions(client)

    expect(signals[0].processed).toBe(true)
    expect(signals[0].processed_at).not.toBeNull()
  })

  it('does NOT carry the same address twice — and the state that stops it is written by the first run', async () => {
    // NON-VACUITY. Nothing here is seeded as carried. Run one produces that state and run
    // two must respect it. Delete the .or(carry_status.is.null,...) filter from the real
    // query and this goes red, because run two re-carries.
    const { client } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test' }],
      signals: [{ id: 'sig-0' }],
    })

    const first = await carryPendingSuppressions(client)
    expect(first.carriedCount).toBe(1)
    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(1)

    const second = await carryPendingSuppressions(client)

    expect(second.pendingCount).toBe(0)
    expect(second.carriedCount).toBe(0)
    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(1)
    // The denominator is still reported, so a zero above is distinguishable from a sweep
    // that examined nothing.
    expect(second.activeCount).toBe(1)
    expect(second.detail).toContain('already reached the provider')
  })
})

// ── Failure ───────────────────────────────────────────────────────────────────

describe('when the provider cannot be told', () => {
  it('records the failure WITH a reason, and leaves the signal unprocessed', async () => {
    suppressAddressAtProvider.mockImplementation(async () => ({
      status: 'failed',
      stoppedLeadIds: [],
      error: 'lead could not be stopped',
    }))

    const { client, suppressions, signals } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', source_signal_id: 'sig-0' }],
      signals: [{ id: 'sig-0', processed: false }],
    })

    const verdict = await carryPendingSuppressions(client)

    expect(verdict.failedCount).toBe(1)
    expect(verdict.carriedCount).toBe(0)
    expect(suppressions[0].carry_status).toBe('failed')
    expect(suppressions[0].carry_error).toBe('lead could not be stopped')
    // A signal marked processed on a failed carry would say "handled" about a person the
    // provider may still be mailing.
    expect(signals[0].processed).toBe(false)
    expect(verdict.detail).toContain('may still be in flight')
  })

  it('never writes an empty failure reason, because the CHECK constraint refuses one', async () => {
    suppressAddressAtProvider.mockImplementation(async () => ({
      status: 'failed',
      stoppedLeadIds: [],
      error: '',
    }))

    const { client, suppressions } = createFakeSupabase({ suppressions: [{ email: 'a@x.test' }] })

    await carryPendingSuppressions(client)

    expect(suppressions[0].carry_status).toBe('failed')
    expect(suppressions[0].carry_error).toBeTruthy()
  })

  it('retries a failed carry only after the backoff, and the clock is what moves — not the seed', async () => {
    // NON-VACUITY AGAIN. The failed state is produced by run one. Run two is inside the
    // backoff and must not call the provider. Run three, after the clock moves past it,
    // must. Delete the backoff check and run two goes red; delete the retry selection
    // (carry_status.eq.failed) and run three goes red.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))

    suppressAddressAtProvider.mockImplementation(async () => ({
      status: 'failed',
      stoppedLeadIds: [],
      error: 'provider said no',
    }))

    const { client } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', created_at: '2026-09-01T00:00:00Z' }],
    })

    await carryPendingSuppressions(client)
    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(1)

    // One minute later: inside the backoff.
    vi.setSystemTime(new Date('2026-09-04T12:01:00Z'))
    const inside = await carryPendingSuppressions(client)
    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(1)
    expect(inside.backoffCount).toBe(1)

    // Past the backoff: retried.
    vi.setSystemTime(new Date(Date.now() + (CARRY_RETRY_BACKOFF_MINUTES + 1) * 60_000))
    const after = await carryPendingSuppressions(client)
    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(2)
    expect(after.backoffCount).toBe(0)
  })
})

// ── Rows the sweep must not silently skip ─────────────────────────────────────

describe('rows the sweep cannot action', () => {
  it('does not guess an organisation when the suppression has lost its own, and counts it', async () => {
    // source_org_id is ON DELETE SET NULL on purpose, so that a suppression outlives the
    // organisation that found it. That leaves this case reachable by design.
    const { client } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', source_org_id: null }],
      prospects: [],
    })

    const verdict = await carryPendingSuppressions(client)

    expect(suppressAddressAtProvider).not.toHaveBeenCalled()
    expect(verdict.noOrgCount).toBe(1)
    expect(verdict.detail).toContain('no organisation context')
  })

  it('falls back to a prospect row for the organisation when the suppression has none', async () => {
    const { client } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', source_org_id: null }],
      prospects: [{ id: 'p1', email: 'a@x.test', organisation_id: 'org-b' }],
    })

    const verdict = await carryPendingSuppressions(client)

    expect(suppressAddressAtProvider).toHaveBeenCalledWith(client, 'org-b', 'a@x.test')
    expect(verdict.carriedCount).toBe(1)
  })

  it('never selects a revoked suppression', async () => {
    const { client } = createFakeSupabase({
      suppressions: [
        { email: 'revoked@x.test', revoked_at: '2026-09-01T00:00:00Z' },
        { email: 'active@x.test' },
      ],
    })

    await carryPendingSuppressions(client)

    expect(suppressAddressAtProvider).toHaveBeenCalledTimes(1)
    expect(suppressAddressAtProvider).toHaveBeenCalledWith(client, 'org-a', 'active@x.test')
  })

  it('says so when it hit its per-run ceiling, rather than reporting a floor as a total', async () => {
    const { client } = createFakeSupabase({
      suppressions: Array.from({ length: CARRY_MAX_PER_RUN + 1 }, (_, i) => ({
        email: `a${i}@x.test`,
        source_signal_id: null,
      })),
    })

    const verdict = await carryPendingSuppressions(client)

    expect(verdict.incomplete).toBe(true)
    expect(verdict.pendingCount).toBe(CARRY_MAX_PER_RUN)
    expect(verdict.detail).toContain('a floor, not a total')
  })
})

// ── The single-address entry point ────────────────────────────────────────────

describe('carryOneSuppression', () => {
  it('reports failure rather than success when the outcome cannot be recorded', async () => {
    // The provider may well have been told. We just cannot say so, and claiming the carry
    // landed would be the validate-one-thing-return-another shape this build knows well.
    const { client, signals } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', source_signal_id: 'sig-0' }],
      signals: [{ id: 'sig-0', processed: false }],
      failUpdateOn: 'a@x.test',
    })

    const outcome = await carryOneSuppression(client, {
      email: 'a@x.test',
      organisationId: 'org-a',
    })

    expect(outcome.signalMarkedProcessed).toBe(false)
    expect(signals[0].processed).toBe(false)
  })

  it('refuses a blank address without calling the provider', async () => {
    const { client } = createFakeSupabase({ suppressions: [] })

    const outcome = await carryOneSuppression(client, { email: '   ', organisationId: 'org-a' })

    expect(outcome.status).toBe('failed')
    expect(suppressAddressAtProvider).not.toHaveBeenCalled()
  })

  it('normalises the address before carrying, so case cannot dodge the carry', async () => {
    const { client, suppressions } = createFakeSupabase({
      suppressions: [{ email: 'a@x.test', source_signal_id: null }],
    })

    await carryOneSuppression(client, { email: '  A@X.TEST  ', organisationId: 'org-a' })

    expect(suppressAddressAtProvider).toHaveBeenCalledWith(client, 'org-a', 'a@x.test')
    expect(suppressions[0].carry_status).toBe('confirmed')
  })
})
