// Tests for pagination inside a poll run.
//
// The bug these lock out, confirmed 2026-08-21: parseInstantlyResponse read
// json.pagination.next_starting_after. Instantly returns next_starting_after at the TOP
// LEVEL, as a sibling of items, with no pagination object. The path did not exist, so
// nextCursor was null on every response and all three resources stopped after page one.
// At 15 leads that changed nothing. At 500 prospects it silently caps reply collection.
//
// Every test here drives the REAL pollInstantlyReplies or pollInstantlyLeadStatus
// against real HTTP response bodies. The only inputs are those bodies. The assertions
// are on the rows the production code wrote and the polling_cursors row it upserted.
//
// TWO SEPARATE THINGS ARE UNDER TEST AND THEY ARE NOT THE SAME SET:
//   paging within a run   — all three resources loop until the cursor is absent
//   persisting across runs — only 'replies' writes polling_cursors.last_cursor
// The final describe block asserts exactly that split, in both directions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

import {
  pollInstantlyReplies,
  pollInstantlyLeadStatus,
  INSTANTLY_LEAD_STATUS_BOUNCED,
  INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
} from './instantly'

// The cap the poller enforces. Asserted against the real thing by counting list calls,
// not read from the module, so a change to the constant fails these tests loudly.
const EXPECTED_MAX_PAGES = 20

const CAMPAIGN = {
  id: 'internal-a',
  organisation_id: 'org-a',
  external_id: 'instantly-campaign-a',
}

// ── Fake Supabase ─────────────────────────────────────────────────────────────
// Serves campaigns, polling_cursors, signals and suppressed_emails. signals enforces
// its real idempotency constraint so a row processed twice is visible as such.

function createFakeSupabase(opts: { storedCursor?: string | null; priorErrorCount?: number } = {}) {
  const cursorUpserts: Record<string, unknown>[] = []
  const signalInserts: Record<string, unknown>[] = []
  const suppressedEmails: string[] = []
  const seenSignalKeys = new Set<string>()
  let nextSignalId = 1

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'campaigns') {
        const builder: any = {
          select: () => builder,
          not: () => builder,
          is: () => builder,
          eq: () => builder,
          // Reply path resolves one campaign by external_id.
          maybeSingle: async () => ({
            data: { id: CAMPAIGN.id, organisation_id: CAMPAIGN.organisation_id },
            error: null,
          }),
          // Lead-status path awaits the builder for the full campaign list.
          then: (resolve: (v: unknown) => unknown) => resolve({ data: [CAMPAIGN], error: null }),
        }
        return builder
      }

      if (table === 'polling_cursors') {
        const builder: any = {
          select: () => builder,
          is: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: {
              last_cursor: opts.storedCursor ?? null,
              error_count: opts.priorErrorCount ?? 0,
            },
            error: null,
          }),
          upsert: async (row: Record<string, unknown>) => {
            cursorUpserts.push(row)
            return { error: null }
          },
        }
        return builder
      }

      if (table === 'signals') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: async () => {
              // Mirrors idx_signals_idempotency (organisation_id, source, external_event_id).
              const key = `${row.organisation_id}|${row.source}|${row.external_event_id}`
              if (seenSignalKeys.has(key)) {
                return { data: null, error: { code: '23505', message: 'idx_signals_idempotency' } }
              }
              seenSignalKeys.add(key)
              signalInserts.push(row)
              return { data: [{ id: `signal-${nextSignalId++}` }], error: null }
            },
          }),
        }
      }

      if (table === 'suppressed_emails') {
        return {
          insert: async (row: Record<string, unknown>) => {
            const email = row.email as string
            if (suppressedEmails.includes(email)) {
              return { error: { code: '23505', message: 'suppressed_emails_active_unique' } }
            }
            suppressedEmails.push(email)
            return { error: null }
          },
        }
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, cursorUpserts, signalInserts, suppressedEmails }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A reply row with no thread-reference field, so fetchOutboundEmailBody returns without
// issuing a request and every counted fetch is a list call.
function replyRow(id: string): Record<string, unknown> {
  return { id, eaccount: 'sender@example.com', campaign_id: CAMPAIGN.external_id }
}

function leadRow(id: string, status: number): Record<string, unknown> {
  return { id, email: `${id}@example.com`, status }
}

// Reads the single polling_cursors row a run upserts.
function onlyUpsert(rows: Record<string, unknown>[]): Record<string, unknown> {
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTANTLY_API_ACTIVE = 'true'
  delete process.env.INSTANTLY_API_BASE_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_ACTIVE
})

// ── The cursor path itself ────────────────────────────────────────────────────

describe('next_starting_after is read from the top level of the response', () => {
  it('replies: consumes BOTH pages of a two-page response and processes every row', async () => {
    // Page one carries a top-level next_starting_after. No pagination object anywhere,
    // which is the real Instantly shape. Under the old nested read this returned one
    // page and one signal.
    const fetchStub = vi.fn(async (url: string | URL) => {
      const target = new URL(String(url))
      const startingAfter = target.searchParams.get('starting_after')
      if (startingAfter === null) {
        return jsonResponse({ items: [replyRow('email-1')], next_starting_after: 'cur-page-2' })
      }
      if (startingAfter === 'cur-page-2') {
        return jsonResponse({ items: [replyRow('email-2')] })
      }
      throw new Error(`unexpected starting_after ${startingAfter}`)
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, signalInserts, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.written).toBe(2)
    expect(result.errors).toBe(0)
    expect(signalInserts.map(r => r.external_event_id)).toEqual(['email-1', 'email-2'])
    expect(onlyUpsert(cursorUpserts).last_error).toBeNull()
  })

  it('leads: consumes BOTH pages of a two-page response and suppresses every row', async () => {
    const fetchStub = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.starting_after === undefined) {
        return jsonResponse({
          items: [leadRow('lead-1', INSTANTLY_LEAD_STATUS_BOUNCED)],
          next_starting_after: 'cur-page-2',
        })
      }
      if (body.starting_after === 'cur-page-2') {
        return jsonResponse({ items: [leadRow('lead-2', INSTANTLY_LEAD_STATUS_BOUNCED)] })
      }
      throw new Error(`unexpected starting_after ${body.starting_after}`)
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, signalInserts, suppressedEmails, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.written).toBe(2)
    expect(result.errors).toBe(0)
    expect(signalInserts.map(r => r.external_event_id)).toEqual(['lead-1', 'lead-2'])
    // Page two's row reached the consequence, not just the detection.
    expect(suppressedEmails).toEqual(['lead-1@example.com', 'lead-2@example.com'])
    expect(onlyUpsert(cursorUpserts).last_error).toBeNull()
  })

  it('still reads a nested pagination.next_starting_after as a fallback', async () => {
    // Top level first, nested second. If Instantly ever grows a pagination object the
    // loop degrades instead of breaking.
    const fetchStub = vi.fn(async (url: string | URL) => {
      const startingAfter = new URL(String(url)).searchParams.get('starting_after')
      if (startingAfter === null) {
        return jsonResponse({
          items: [replyRow('email-1')],
          pagination: { next_starting_after: 'cur-nested' },
        })
      }
      return jsonResponse({ items: [replyRow('email-2')] })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, signalInserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(signalInserts).toHaveLength(2)
  })

  it('treats an empty-string next_starting_after as no more pages, not as a cursor', async () => {
    // Sending "" back as starting_after would restart the scan from the beginning.
    const fetchStub = vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1')], next_starting_after: '' })
    )
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase()
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(result.errors).toBe(0)
  })
})

// ── Normal termination ────────────────────────────────────────────────────────

describe('the loop stops when the cursor comes back absent', () => {
  it('replies: three pages then no cursor, and the run reports clean', async () => {
    const cursors = ['cur-2', 'cur-3', null]
    let call = 0
    const fetchStub = vi.fn(async () => {
      const next = cursors[call]
      call++
      return jsonResponse(
        next === null
          ? { items: [replyRow(`email-${call}`)] }
          : { items: [replyRow(`email-${call}`)], next_starting_after: next }
      )
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(3)
    expect(result.written).toBe(3)
    expect(result.errors).toBe(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error).toBeNull()
    expect(row.error_count).toBe(0)
    expect(typeof row.last_polled_at).toBe('string')
  })

  it('leads: stops on the page that omits next_starting_after entirely', async () => {
    let call = 0
    const fetchStub = vi.fn(async () => {
      call++
      return jsonResponse(
        call === 1
          ? {
              items: [leadRow('lead-1', INSTANTLY_LEAD_STATUS_UNSUBSCRIBED)],
              next_starting_after: 'cur-2',
            }
          : { items: [leadRow('lead-2', INSTANTLY_LEAD_STATUS_UNSUBSCRIBED)] }
      )
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      'lead_unsubscribed'
    )

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.errors).toBe(0)
    expect(onlyUpsert(cursorUpserts).last_error).toBeNull()
  })
})

// ── Safety guard: the page cap ────────────────────────────────────────────────

describe('the max-pages cap is a recorded failure, not a silent stop', () => {
  // A server that always hands back a fresh cursor: the cursor advances every time, so
  // only the cap can end this loop.
  function endlessPages() {
    let call = 0
    return vi.fn(async () => {
      call++
      return jsonResponse({
        items: [replyRow(`email-${call}`)],
        next_starting_after: `cur-${call + 1}`,
      })
    })
  }

  it('replies: stops at the cap, writes last_error and error_count, run is not clean', async () => {
    const fetchStub = endlessPages()
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase({ priorErrorCount: 4 })
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(EXPECTED_MAX_PAGES)
    // Not clean: the cron route's runOk is totalErrors === 0.
    expect(result.errors).toBeGreaterThan(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error as string).toContain('page cap reached')
    expect(row.last_error as string).toContain(String(EXPECTED_MAX_PAGES))
    expect(row.error_count).toBe(5)
  })

  it('replies: the cap still advances the stored cursor so the backlog can drain', async () => {
    // Deliberate, and the opposite of the stuck-cursor case below. The pages before the
    // cap were fetched and written, so the cursor points past finished work. Freezing it
    // would make every future run re-fetch the same 20 pages and never reach page 21.
    vi.stubGlobal('fetch', endlessPages())

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    const row = onlyUpsert(cursorUpserts)
    expect('last_cursor' in row).toBe(true)
    expect(row.last_cursor).toBe(`cur-${EXPECTED_MAX_PAGES + 1}`)
  })

  it('leads: stops at the cap and records the failure against the campaign', async () => {
    let call = 0
    const fetchStub = vi.fn(async () => {
      call++
      return jsonResponse({
        items: [leadRow(`lead-${call}`, INSTANTLY_LEAD_STATUS_BOUNCED)],
        next_starting_after: `cur-${call + 1}`,
      })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(fetchStub).toHaveBeenCalledTimes(EXPECTED_MAX_PAGES)
    expect(result.errors).toBeGreaterThan(0)
    expect(result.written).toBe(EXPECTED_MAX_PAGES)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error as string).toContain('page cap reached')
    expect(row.last_error as string).toContain(CAMPAIGN.external_id)
    expect(row.error_count).toBeGreaterThan(0)
  })
})

// ── Safety guard: the cursor that does not advance ────────────────────────────

describe('a cursor that does not advance stops the loop and records a failure', () => {
  it('replies: the same next_starting_after twice ends the run as a failure', async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-echo')], next_starting_after: 'cur-stuck' })
    )
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyReplies(client, 'test-key')

    // Page one accepts cur-stuck, page two returns it again and is rejected.
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.errors).toBeGreaterThan(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error as string).toContain('not advancing')
    expect(row.last_error as string).toContain('cur-stuck')
    expect(row.error_count).toBeGreaterThan(0)
  })

  it('replies: a stuck cursor does NOT get persisted, unlike a cap hit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ items: [replyRow('email-echo')], next_starting_after: 'cur-stuck' })
      )
    )

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    // Absent key, not a null value: the stored cursor is left exactly as it was.
    expect('last_cursor' in onlyUpsert(cursorUpserts)).toBe(false)
  })

  it('replies: a server echoing back the cursor it was SENT is caught on page one', async () => {
    // The stored cursor is seeded into the guard, so an echo is caught after one call
    // rather than after two.
    const fetchStub = vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1')], next_starting_after: 'cur-stored' })
    )
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase({ storedCursor: 'cur-stored' })
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(result.errors).toBeGreaterThan(0)
    expect(onlyUpsert(cursorUpserts).last_error as string).toContain('not advancing')
  })

  it('leads: the same next_starting_after twice ends the campaign scan as a failure', async () => {
    let call = 0
    const fetchStub = vi.fn(async () => {
      call++
      return jsonResponse({
        items: [leadRow(`lead-${call}`, INSTANTLY_LEAD_STATUS_BOUNCED)],
        next_starting_after: 'cur-stuck',
      })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.errors).toBeGreaterThan(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error as string).toContain('not advancing')
    expect(row.last_error as string).toContain(CAMPAIGN.external_id)
  })
})

// ── Mid-loop failure ──────────────────────────────────────────────────────────

describe('a failure on page 2 reaches last_error and the run does not report clean', () => {
  it('replies: page 1 succeeds, page 2 returns 500, cursor is not advanced', async () => {
    let call = 0
    const fetchStub = vi.fn(async () => {
      call++
      if (call === 1) {
        return jsonResponse({ items: [replyRow('email-1')], next_starting_after: 'cur-2' })
      }
      return new Response('upstream exploded', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts, signalInserts } = createFakeSupabase({ priorErrorCount: 1 })
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(2)
    // Page one's row was processed and kept.
    expect(signalInserts.map(r => r.external_event_id)).toEqual(['email-1'])
    // The run reached Instantly, so polled is true. That must not read as clean.
    expect(result.polled).toBe(true)
    expect(result.errors).toBeGreaterThan(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error as string).toContain('500')
    expect(row.last_error as string).toContain('upstream exploded')
    expect(row.error_count).toBe(2)
    // The failed page must be re-fetched next run, so the cursor stays put.
    expect('last_cursor' in row).toBe(false)
  })

  it('leads: page 1 succeeds, page 2 returns 502, page 1 rows survive and the run fails', async () => {
    let call = 0
    const fetchStub = vi.fn(async () => {
      call++
      if (call === 1) {
        return jsonResponse({
          items: [leadRow('lead-1', INSTANTLY_LEAD_STATUS_BOUNCED)],
          next_starting_after: 'cur-2',
        })
      }
      return new Response('bad gateway', { status: 502 })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts, signalInserts, suppressedEmails } = createFakeSupabase()
    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(signalInserts.map(r => r.external_event_id)).toEqual(['lead-1'])
    expect(suppressedEmails).toEqual(['lead-1@example.com'])
    expect(result.polled).toBe(true)
    expect(result.errors).toBeGreaterThan(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error as string).toContain('502')
    expect(row.last_error as string).toContain('page 2')
    expect(row.error_count).toBeGreaterThan(0)
  })
})

// ── The two sets are not the same set ─────────────────────────────────────────

describe('all three resources page; only replies persists a cursor across runs', () => {
  // Every case below is served the SAME two-page response, so any difference in the
  // polling_cursors row is a difference the production code chose.
  function twoPages(rowFor: (n: number) => Record<string, unknown>) {
    let call = 0
    return vi.fn(async () => {
      call++
      return jsonResponse(
        call === 1
          ? { items: [rowFor(1)], next_starting_after: 'cur-final' }
          : { items: [rowFor(2)] }
      )
    })
  }

  it('replies PAGES and PERSISTS last_cursor', async () => {
    const fetchStub = twoPages(n => replyRow(`email-${n}`))
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    expect(fetchStub).toHaveBeenCalledTimes(2)
    const row = onlyUpsert(cursorUpserts)
    expect(row.resource).toBe('replies')
    expect('last_cursor' in row).toBe(true)
    // The final page carried no cursor, so the resume point is the last row's id.
    expect(row.last_cursor).toBe('email-2')
  })

  it('leads_bounced PAGES but does NOT persist last_cursor', async () => {
    const fetchStub = twoPages(n => leadRow(`lead-${n}`, INSTANTLY_LEAD_STATUS_BOUNCED))
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts, signalInserts } = createFakeSupabase()
    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    // Paged: both pages consumed.
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(signalInserts).toHaveLength(2)

    const row = onlyUpsert(cursorUpserts)
    expect(row.resource).toBe('leads_bounced')
    // Did not persist: absent key leaves any stored value untouched. This resource
    // re-scans in full every run, because a lead created weeks ago can bounce today.
    expect('last_cursor' in row).toBe(false)
  })

  it('leads_unsubscribed PAGES but does NOT persist last_cursor', async () => {
    const fetchStub = twoPages(n => leadRow(`lead-${n}`, INSTANTLY_LEAD_STATUS_UNSUBSCRIBED))
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts, signalInserts } = createFakeSupabase()
    await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      'lead_unsubscribed'
    )

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(signalInserts).toHaveLength(2)

    const row = onlyUpsert(cursorUpserts)
    expect(row.resource).toBe('leads_unsubscribed')
    expect('last_cursor' in row).toBe(false)
  })

  it('a returned cursor does not tempt the full-scan resources into persisting one', async () => {
    // Every page carries a cursor including the last, and items run out. The resource
    // must still write no last_cursor.
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        return jsonResponse(
          call === 1
            ? {
                items: [leadRow('lead-1', INSTANTLY_LEAD_STATUS_BOUNCED)],
                next_starting_after: 'cur-2',
              }
            : { items: [], next_starting_after: 'cur-3' }
        )
      })
    )

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    expect('last_cursor' in onlyUpsert(cursorUpserts)).toBe(false)
  })
})
