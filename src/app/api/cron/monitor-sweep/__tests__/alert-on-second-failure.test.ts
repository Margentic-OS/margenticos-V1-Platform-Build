import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * WHY THIS TEST EXISTS.
 *
 * Overnight 2026-09-10 to 09-11, six checks went PROBLEM and back to OK nineteen times, each
 * transition raising a Sentry error and an email, for zero standing faults. The sweep now
 * RECORDS the first PROBLEM reading at once and ALERTS only on the second consecutive one.
 * See alert-policy.ts.
 *
 * What this holds, in the order it matters:
 *   1. One failure sends nothing, and is still recorded, so the dashboard shows it.
 *   2. Two failures in a row send, exactly once.
 *   3. A check that cannot read its input is recorded as UNKNOWN, never OK, and a sweep that
 *      cannot read the view at all resolves nothing and sends nothing.
 *   4. Two overlapping sweeps cannot both send the same alert.
 *
 * THE FAKE. A stateful stand-in for the database that persists across calls to POST, so a
 * test can run two sweeps and watch the second act on what the first wrote. It honours every
 * filter the sweep applies to monitor_events (eq, order, limit, and the COLUMN LIST in
 * select, so a column the sweep forgets to select really is missing), and it throws on a
 * column the table does not have. The route catches a throw and counts it as an error, so
 * every sweep meant to be clean asserts errors === 0: without that, a fake missing a method
 * would pass as a check that was quietly skipped.
 */

type Row = {
  id: number
  check_code: string
  state: string
  detail: string | null
  created_at: string
  resolved_at: string | null
  acknowledged_at: string | null
  acknowledged_note: string | null
  alert_pending: boolean
}

type ViewResult = {
  data: { check_code: string; state: string; detail: string | null } | null
  error: { message: string } | null
}

const { captureMessage, fake } = vi.hoisted(() => {
  const COLUMNS = [
    'id', 'check_code', 'state', 'detail', 'created_at', 'resolved_at',
    'acknowledged_at', 'acknowledged_note', 'alert_pending',
  ]
  const state = {
    events: [] as Row[],
    view: null as ViewResult | null,
    nextId: 1,
    clock: 0,
  }

  const assertColumn = (c: string) => {
    if (!COLUMNS.includes(c)) throw new Error(`fake: monitor_events has no column ${c}`)
  }
  const pick = (row: Row, cols: string) => {
    const out: Record<string, unknown> = {}
    for (const c of cols.split(',').map(s => s.trim())) {
      assertColumn(c)
      out[c] = row[c as keyof Row]
    }
    return out
  }
  const matches = (row: Row, filters: Array<[string, unknown]>) =>
    filters.every(([c, v]) => row[c as keyof Row] === v)
  const tick = () => new Date(Date.UTC(2026, 8, 11, 0, 0, state.clock++)).toISOString()

  const row = (values: Partial<Row>): Row => ({
    id: state.nextId++,
    check_code: 'MON-900',
    state: 'OK',
    detail: null,
    created_at: tick(),
    resolved_at: null,
    acknowledged_at: null,
    acknowledged_note: null,
    alert_pending: false, // the column default
    ...values,
  })

  const monitorEvents = {
    select(cols: string) {
      const filters: Array<[string, unknown]> = []
      let order: { col: string; ascending: boolean } | null = null
      let limit = Infinity
      const query = {
        eq(c: string, v: unknown) { assertColumn(c); filters.push([c, v]); return query },
        order(c: string, o: { ascending: boolean }) { assertColumn(c); order = { col: c, ascending: o.ascending }; return query },
        limit(n: number) { limit = n; return query },
        maybeSingle() {
          let rows = state.events.filter(r => matches(r, filters))
          if (order) {
            const { col, ascending } = order
            rows = [...rows].sort((a, b) => {
              const x = String(a[col as keyof Row]), y = String(b[col as keyof Row])
              return ascending ? x.localeCompare(y) : y.localeCompare(x)
            })
          }
          rows = rows.slice(0, limit)
          if (rows.length > 1) return Promise.resolve({ data: null, error: { message: 'more than one row' } })
          return Promise.resolve({ data: rows[0] ? pick(rows[0], cols) : null, error: null })
        },
      }
      return query
    },
    insert(values: Partial<Row>) {
      Object.keys(values).forEach(assertColumn)
      if (!['OK', 'PROBLEM', 'UNKNOWN'].includes(String(values.state))) {
        return Promise.resolve({ data: null, error: { message: 'violates check constraint on state' } })
      }
      state.events.push(row(values))
      return Promise.resolve({ data: null, error: null })
    },
    update(patch: Partial<Row>) {
      Object.keys(patch).forEach(assertColumn)
      const filters: Array<[string, unknown]> = []
      const apply = () => {
        const hit = state.events.filter(r => matches(r, filters))
        hit.forEach(r => Object.assign(r, patch))
        return hit
      }
      const builder = {
        eq(c: string, v: unknown) { assertColumn(c); filters.push([c, v]); return builder },
        select(cols: string) {
          return Promise.resolve({ data: apply().map(r => pick(r, cols)), error: null })
        },
        then(onFulfilled: (v: { data: null; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
          apply()
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected)
        },
      }
      return builder
    },
  }

  const client = {
    from(table: string) {
      if (table === 'mon_900') {
        return { select: () => ({ single: () => Promise.resolve(state.view) }) }
      }
      if (table === 'monitor_events') return monitorEvents
      if (table === 'cron_heartbeats') {
        return { insert: () => ({ throwOnError: () => Promise.resolve({ data: null, error: null }) }) }
      }
      throw new Error(`fake: no table ${table}`)
    },
  }

  const reset = () => {
    state.events = []
    state.view = null
    state.nextId = 1
    state.clock = 0
  }

  return { captureMessage: vi.fn(), fake: { state, client, row, reset } }
})

vi.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  flush: () => Promise.resolve(true),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fake.client }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../monitors', () => ({ MONITORS: [['MON-900', 'mon_900']] }))

import { POST } from '../route'
import { planSweepStep, type MonitorState } from '../alert-policy'

const SECRET = 'test-secret-alerts'

type SweepBody = { ok: boolean; checked: number; state_changes: number; errors: number }

async function post(): Promise<SweepBody> {
  const response = await POST(new NextRequest('http://localhost:3000/api/cron/monitor-sweep', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  }))
  return response.json()
}

async function sweep(reading: MonitorState | 'READ_ERROR', detail = 'probe detail'): Promise<SweepBody> {
  fake.state.view = reading === 'READ_ERROR'
    ? { data: null, error: { message: 'Gateway Timeout' } }
    : { data: { check_code: 'MON-900', state: reading, detail }, error: null }
  return post()
}

const events = () => fake.state.events

describe('monitor sweep: record the first failure, alert on the second', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    fake.reset()
    captureMessage.mockClear()
  })

  it('records the first PROBLEM reading at once and sends nothing', async () => {
    const body = await sweep('PROBLEM')
    expect(body.errors, 'the sweep hit something the fake does not implement').toBe(0)
    expect(body.state_changes).toBe(1)
    expect(captureMessage).not.toHaveBeenCalled()
    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ state: 'PROBLEM', resolved_at: null, alert_pending: true })
  })

  it('sends on the second consecutive PROBLEM reading, exactly once', async () => {
    await sweep('PROBLEM')
    const body = await sweep('PROBLEM')
    expect(body.errors).toBe(0)
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(String(captureMessage.mock.calls[0][0])).toMatch(/MON-900.*two consecutive sweeps/)
    expect(captureMessage.mock.calls[0][1]).toBe('error')
    // No new row, because the state did not change, and nothing is owed any more.
    expect(events()).toHaveLength(1)
    expect(events()[0].alert_pending).toBe(false)

    await sweep('PROBLEM')
    expect(captureMessage, 'a third reading must not send again').toHaveBeenCalledTimes(1)
  })

  it('drops the alert when the check recovers first, and keeps the failure in the history', async () => {
    await sweep('PROBLEM')
    await sweep('OK')
    expect(captureMessage).not.toHaveBeenCalled()
    expect(events().map(e => e.state)).toEqual(['PROBLEM', 'OK'])
    expect(events()[0].resolved_at).not.toBeNull()
    expect(events()[0].alert_pending).toBe(false)

    // A later failure starts its own count.
    await sweep('PROBLEM')
    expect(captureMessage).not.toHaveBeenCalled()
    await sweep('PROBLEM')
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('treats a sweep that cannot read the view as no reading: nothing resolved, recorded or sent', async () => {
    await sweep('PROBLEM')
    const body = await sweep('READ_ERROR')
    expect(body.errors).toBe(1)
    expect(captureMessage).not.toHaveBeenCalled()
    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ state: 'PROBLEM', resolved_at: null, alert_pending: true })

    // The next real reading is the second consecutive one.
    await sweep('PROBLEM')
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('records a check that cannot read its input as UNKNOWN, never as OK, and never alerts on it', async () => {
    await sweep('PROBLEM')
    await sweep('UNKNOWN')
    await sweep('UNKNOWN')
    expect(captureMessage).not.toHaveBeenCalled()
    expect(events().map(e => e.state)).toEqual(['PROBLEM', 'UNKNOWN'])
    expect(events().some(e => e.state === 'OK')).toBe(false)
  })

  it('sends nothing for a PROBLEM row written before this change', async () => {
    // The deployed sweep alerts on the spot and does not know alert_pending, so its rows take
    // the column default, false. None of them may send a second email after this deploys.
    fake.state.events.push(fake.row({ state: 'PROBLEM' }))
    await sweep('PROBLEM')
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('sends once when two sweeps overlap on the second reading', async () => {
    await sweep('PROBLEM')
    const [a, b] = await Promise.all([post(), post()])
    expect(a.errors + b.errors).toBe(0)
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })
})

describe('planSweepStep', () => {
  const pending = { state: 'PROBLEM' as const, alert_pending: true }
  const sent = { state: 'PROBLEM' as const, alert_pending: false }

  it.each([
    ['first PROBLEM, no history',     'PROBLEM', null,                                    { record: true,  resolvePrevious: false, alertPending: true,  alertNow: false }],
    ['second PROBLEM, alert owed',    'PROBLEM', pending,                                 { record: false, resolvePrevious: false, alertPending: false, alertNow: true  }],
    ['third PROBLEM, alert sent',     'PROBLEM', sent,                                    { record: false, resolvePrevious: false, alertPending: false, alertNow: false }],
    ['recovered before confirming',   'OK',      pending,                                 { record: true,  resolvePrevious: true,  alertPending: false, alertNow: false }],
    ['cannot read its input',         'UNKNOWN', pending,                                 { record: true,  resolvePrevious: true,  alertPending: false, alertNow: false }],
    ['PROBLEM after OK',              'PROBLEM', { state: 'OK' as const, alert_pending: false }, { record: true,  resolvePrevious: false, alertPending: true,  alertNow: false }],
  ] as const)('%s', (_label, current, previous, expected) => {
    expect(planSweepStep(current, previous)).toEqual(expected)
  })
})
