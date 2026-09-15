// The halfway email fires inside a WINDOW, not for every warmup ever started.
//
// The original query was `warmup_started_at <= now - 17 days` with no upper bound, so it
// selected every warmup more than 17 days old. Measured against production on 2026-09-15,
// that was MargenticOS, warmup started 2026-06-22, about 85 days earlier, for a campaign
// that had already contacted all 95 of its prospects. It would have been told its domains
// were "about halfway through their warming cycle, on schedule", with a first-send date in
// the past.
//
// THE FAKE HONOURS THE FILTERS. That is the whole point of this file. A fake that recorded
// .gte() and returned every row regardless would pass whether or not the upper bound
// existed, which is the "a fake that does not honour a filter cannot test that filter"
// shape from CLAUDE.md. This one applies them, and THROWS on any method it does not
// implement rather than returning itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async (..._args: unknown[]) => ({ id: 'sent' }))
vi.mock('@/lib/email/send', () => ({ sendTransactionalEmail: (...a: unknown[]) => sendTransactionalEmail(...a) }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

interface Org { id: string; name: string; warmup_started_at: string | null; archived_at: string | null }

let ORGS: Org[] = []
const selectedOrgIds: string[] = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      if (table === 'organisations') {
        let rows = [...ORGS]
        const chain: Record<string, unknown> = {
          select: () => chain,
          is: (col: string, val: null) => { rows = rows.filter(r => (r as never)[col] === val); return chain },
          not: (col: string, _op: string, _v: null) => { rows = rows.filter(r => (r as never)[col] !== null); return chain },
          lte: (col: string, v: string) => { rows = rows.filter(r => String((r as never)[col]) <= v); return chain },
          gte: (col: string, v: string) => { rows = rows.filter(r => String((r as never)[col]) >= v); return chain },
          then: (res: (x: unknown) => unknown) => {
            selectedOrgIds.push(...rows.map(r => r.id))
            return Promise.resolve({ data: rows, error: null }).then(res)
          },
        }
        return chain
      }
      if (table === 'notifications_log') {
        return { insert: async () => ({ error: null }) }
      }
      if (table === 'users') {
        const chain: Record<string, unknown> = {
          select: () => chain, eq: () => chain,
          maybeSingle: async () => ({ data: { email: 'client@example.test' }, error: null }),
          single: async () => ({ data: { email: 'client@example.test' }, error: null }),
        }
        return chain
      }
      throw new Error(`fake: table "${table}" is not implemented`)
    },
  }),
}))

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

async function run() {
  const { POST } = await import('../route')
  const req = new Request('https://example.test/api/cron/warmup-halfway', {
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(req as any)
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  ORGS = []
  selectedOrgIds.length = 0
  sendTransactionalEmail.mockClear()
  vi.resetModules()
})

afterEach(() => { vi.restoreAllMocks() })

function org(id: string, startedDaysAgo: number | null): Org {
  return { id, name: `Org ${id}`, warmup_started_at: startedDaysAgo === null ? null : daysAgo(startedDaysAgo), archived_at: null }
}

describe('the halfway window', () => {
  it('selects a warmup inside the window', async () => {
    ORGS = [org('in-window', 19)]
    await run()
    expect(selectedOrgIds).toContain('in-window')
  })

  it('EXCLUDES a warmup that finished long ago, which is the bug this guards', async () => {
    // 85 days: MargenticOS on 2026-09-15, the real row that would have been emailed.
    ORGS = [org('long-finished', 85)]
    await run()
    expect(selectedOrgIds).not.toContain('long-finished')
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('excludes a warmup that has not reached halfway yet', async () => {
    ORGS = [org('too-early', 5)]
    await run()
    expect(selectedOrgIds).not.toContain('too-early')
  })

  it('picks only the in-window organisation out of a mixed set', async () => {
    ORGS = [org('too-early', 3), org('in-window', 18), org('just-past', 25), org('long-finished', 85)]
    await run()
    expect(selectedOrgIds).toEqual(['in-window'])
  })

  it('ignores an organisation with no warmup recorded', async () => {
    ORGS = [org('never-started', null)]
    await run()
    expect(selectedOrgIds).toEqual([])
  })
})
