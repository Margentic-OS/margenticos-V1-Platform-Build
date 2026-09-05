// A reply whose signal row fails to write must not be skipped past.
//
// THE DEFECT THESE LOCK OUT, measured 2026-09-04 against production.
//
// pollInstantlyReplies advanced polling_cursors.last_cursor on PAGE-FETCH success. A reply
// whose signal row failed to write hit `else result.errors++`, the loop continued, and the
// cursor moved past it. The event was unrecoverable short of hand-editing last_cursor.
//
// Two things made it invisible rather than merely bad:
//   1. writeSignal's error path never called recordPollFailure, so state.failures stayed 0
//      and writePollState then wrote error_count 0 and last_error NULL. The run that lost a
//      reply CLEARED the poller's error state and reported itself clean.
//   2. Nothing read polling_cursors. Zero of the 23 mon_* views touched it. MON-027, added
//      in the same commit, is the reader.
//
// Every test here drives the REAL pollInstantlyReplies. The assertions are on the
// polling_cursors row the production code upserted and the signal rows it wrote.
//
// MUTATION-PROVED. Deleting the `if (pageWriteFailed)` block in instantly.ts turns the first
// three tests in this file red. Removing only the recordPollFailure call inside it turns the
// error_count / last_error assertions red while the cursor assertion stays green, which is
// why those are separate expectations rather than one combined check.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

import { pollInstantlyReplies } from './instantly'

const CAMPAIGN = {
  id: 'internal-a',
  organisation_id: 'org-a',
  external_id: 'campaign-a',
}

// ── Fake Supabase ─────────────────────────────────────────────────────────────
//
// Models the signals idempotency constraint faithfully, because the whole recovery argument
// rests on it: a re-fetched page must dedupe the rows that already landed rather than
// double-writing them.
//
// failWriteFor names event ids whose insert returns a NON-unique error (a CHECK violation
// here). That is the class the poller must now stop for. It is deliberately distinct from
// the 23505 path, which is not an error at all.
function createFakeSupabase(opts: {
  storedCursor?: string | null
  priorErrorCount?: number
  failWriteFor?: Set<string>
} = {}) {
  const cursorUpserts: Record<string, unknown>[] = []
  const signalInserts: Record<string, unknown>[] = []
  const seenSignalKeys = new Set<string>()
  const failWriteFor = opts.failWriteFor ?? new Set<string>()
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
          maybeSingle: async () => ({
            data: { id: CAMPAIGN.id, organisation_id: CAMPAIGN.organisation_id },
            error: null,
          }),
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
              const eventId = row.external_event_id as string

              // Idempotency first: a row that already landed is 'skipped', never an error,
              // and never reaches the failure injection below. This ordering is what makes
              // the re-fetch test meaningful.
              const key = `${row.organisation_id}|${row.source}|${eventId}`
              if (seenSignalKeys.has(key)) {
                return { data: null, error: { code: '23505', message: 'idx_signals_idempotency' } }
              }

              if (failWriteFor.has(eventId)) {
                return {
                  data: null,
                  error: { code: '23514', message: 'signals_check_violation' },
                }
              }

              seenSignalKeys.add(key)
              signalInserts.push(row)
              return { data: [{ id: `signal-${nextSignalId++}` }], error: null }
            },
          }),
        }
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, cursorUpserts, signalInserts, failWriteFor }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// No thread-reference field, so fetchOutboundEmailBody issues no request.
function replyRow(id: string): Record<string, unknown> {
  return { id, eaccount: 'sender@example.com', campaign_id: CAMPAIGN.external_id }
}

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

describe('a page with a failed signal write does not move the stored cursor', () => {
  it('omits last_cursor entirely, so the stored value is preserved for the next run', async () => {
    // One page, three replies, the middle one fails to write.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        items: [replyRow('email-1'), replyRow('email-2'), replyRow('email-3')],
        next_starting_after: 'cur-page-2',
      })
    ))

    const { client, cursorUpserts, signalInserts } = createFakeSupabase({
      storedCursor: 'cur-page-1',
      failWriteFor: new Set(['email-2']),
    })

    const result = await pollInstantlyReplies(client, 'test-key')

    // The two that could be written were written. The failure did not abort the page.
    expect(signalInserts.map(r => r.external_event_id)).toEqual(['email-1', 'email-3'])
    expect(result.errors).toBe(1)

    // The load-bearing assertion. An omitted key is absent from the upsert's ON CONFLICT
    // SET clause, so the stored cursor keeps its previous value rather than being nulled.
    // Under the old code this key was present and carried 'cur-page-2', stepping over
    // email-2 for ever.
    const row = onlyUpsert(cursorUpserts)
    expect('last_cursor' in row).toBe(false)
  })

  it('records the failure in error_count and last_error instead of clearing them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1')], next_starting_after: 'cur-page-2' })
    ))

    const { client, cursorUpserts } = createFakeSupabase({
      priorErrorCount: 4,
      failWriteFor: new Set(['email-1']),
    })

    await pollInstantlyReplies(client, 'test-key')

    const row = onlyUpsert(cursorUpserts)
    // Was 0 and null before this change: the run that lost a reply reset the alarm.
    expect(row.error_count).toBe(5)
    expect(String(row.last_error)).toContain('signal write failed')
    expect(String(row.last_error)).toContain('email-1')
  })

  it('stops paging at the failed page rather than reading on past it', async () => {
    const fetchStub = vi.fn(async (url: string | URL) => {
      const startingAfter = new URL(String(url)).searchParams.get('starting_after')
      if (startingAfter === null) {
        return jsonResponse({ items: [replyRow('email-1')], next_starting_after: 'cur-page-2' })
      }
      return jsonResponse({ items: [replyRow('email-2')] })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase({ failWriteFor: new Set(['email-1']) })
    await pollInstantlyReplies(client, 'test-key')

    // Exactly one list call. Continuing to page would pile more unwritten events behind a
    // cursor that is already being held.
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
})

describe('the held page is recoverable on the next run', () => {
  it('re-fetching writes the previously failed row and dedupes the ones that landed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1'), replyRow('email-2')] })
    ))

    // One fake across both runs, so seenSignalKeys carries the first run's writes forward
    // exactly as the real unique index would.
    const fake = createFakeSupabase({ failWriteFor: new Set(['email-2']) })

    const first = await pollInstantlyReplies(fake.client, 'test-key')
    expect(first.written).toBe(1)
    expect(first.errors).toBe(1)

    // The condition clears — the constraint violation is fixed, the DB accepts the row.
    fake.failWriteFor.delete('email-2')

    const second = await pollInstantlyReplies(fake.client, 'test-key')

    // email-1 dedupes on the idempotency constraint, email-2 finally lands. This is the
    // whole safety argument for holding the cursor: re-reading a page costs one API call
    // and cannot double-write.
    expect(second.written).toBe(1)
    expect(second.skipped).toBe(1)
    expect(second.errors).toBe(0)
    expect(fake.signalInserts.map(r => r.external_event_id)).toEqual(['email-1', 'email-2'])
  })
})

describe('the hold is scoped to write failures and does not over-block', () => {
  it('a clean page still advances the cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1')] })
    ))

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    const row = onlyUpsert(cursorUpserts)
    // Last page with no next_starting_after falls back to the last row's id.
    expect(row.last_cursor).toBe('email-1')
    expect(row.error_count).toBe(0)
    expect(row.last_error).toBeNull()
  })

  it('a deterministic parse failure does NOT hold the cursor', async () => {
    // Missing eaccount can never become a row however many times it is re-fetched, so
    // holding for it would be a stall no operator action can clear. It is counted and
    // logged, and the cursor moves on. This is the one place the fix deliberately does
    // not fire, and it is asserted so the scoping cannot be widened by accident.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        items: [{ id: 'email-1', campaign_id: CAMPAIGN.external_id }],
      })
    ))

    const { client, cursorUpserts } = createFakeSupabase()
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(result.errors).toBe(1)
    const row = onlyUpsert(cursorUpserts)
    expect(row.last_cursor).toBe('email-1')
  })
})
