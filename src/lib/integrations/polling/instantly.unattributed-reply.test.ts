// A reply the poller cannot attribute is parked, not dropped.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THIS BRANCH USED TO DO
//
// A reply whose campaign_id resolved to no row in `campaigns` was discarded: the cursor
// advanced past it and nothing re-read it. Worse, the branch never called
// recordPollFailure, and writePollState writes
//     error_count: state.failures > 0 ? prior + state.failures : 0
//     last_error:  state.failures > 0 ? state.firstError : null
// so the run that lost the reply reset error_count to 0 and last_error to NULL,
// destroying the record of earlier runs' real failures on its way past. MON-027 reads
// error_count, saw 0, reported OK.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT IT DOES NOW
//
// The reply is QUARANTINED with the provider's campaign id and email id, and registering
// that campaign replays it into a real signal. This is possible because the reply poll is
// workspace-wide: the poller already had the reply in hand, and was throwing it away.
//
// So the unresolved-campaign case is no longer counted as an error. It is a handled
// outcome, and counting it would pin MON-002 red on every run holding a quarantined
// reply. MON-031 owns the alerting. recordPollFailure now fires here only when the
// QUARANTINE WRITE ITSELF FAILS, which is the case where the reply really is lost.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THESE ASSERT ON THE CAMPAIGN ID AND NOT ON "NOT NULL"
//
// A non-null last_error only proves something was recorded. What an operator needs is
// WHICH campaign to register, and that string is the entire remedy. A test satisfied by
// any non-empty message would pass against one saying "an error occurred".
//
// MUTATION PROOFS:
//   remove the quarantineReply call            -> "parks the reply" goes red
//   drop the failed-write recordPollFailure    -> "records a poll failure ONLY" goes red
//   record a failure on the success path too   -> "parks the reply" goes red on result.errors

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

const REGISTERED = {
  id: 'internal-a',
  organisation_id: 'org-a',
  external_id: 'campaign-registered',
}

const UNREGISTERED_EXTERNAL_ID = 'campaign-nobody-registered'

// ── Fake Supabase ─────────────────────────────────────────────────────────────
//
// The campaigns lookup honours external_id, because that is the filter under test: a
// fake that returned the same campaign whatever it was asked for could not tell a
// resolved campaign from an unresolved one, and every assertion below would be vacuous.
function createFakeSupabase(
  opts: { priorErrorCount?: number; failQuarantineWrite?: boolean } = {}
) {
  const cursorUpserts: Record<string, unknown>[] = []
  const signalInserts: Record<string, unknown>[] = []
  const quarantined: Record<string, unknown>[] = []

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'campaigns') {
        let requestedExternalId: string | null = null
        const builder: any = {
          select: () => builder,
          eq: (column: string, value: string) => {
            if (column === 'external_id') requestedExternalId = value
            return builder
          },
          maybeSingle: async () => ({
            data: requestedExternalId === REGISTERED.external_id
              ? { id: REGISTERED.id, organisation_id: REGISTERED.organisation_id }
              : null,
            error: null,
          }),
        }
        return builder
      }

      if (table === 'polling_cursors') {
        const builder: any = {
          select: () => builder,
          is: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: { last_cursor: null, error_count: opts.priorErrorCount ?? 0 },
            error: null,
          }),
          upsert: async (row: Record<string, unknown>) => {
            cursorUpserts.push(row)
            return { error: null }
          },
        }
        return builder
      }

      if (table === 'unattributed_replies') {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (opts.failQuarantineWrite) {
              return { error: { code: '23514', message: 'quarantine insert refused' } }
            }
            quarantined.push(row)
            return { error: null }
          },
        }
      }

      if (table === 'signals') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: async () => {
              signalInserts.push(row)
              return { data: [{ id: 'signal-1' }], error: null }
            },
          }),
        }
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, cursorUpserts, signalInserts, quarantined }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// No thread-reference field, so fetchOutboundEmailBody issues no request.
function replyRow(id: string, campaignExternalId: string): Record<string, unknown> {
  return { id, eaccount: 'sender@example.com', campaign_id: campaignExternalId }
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

describe('a reply on an unregistered campaign is recorded, not silently swallowed', () => {
  it('parks the reply with its provider campaign id, rather than dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1', UNREGISTERED_EXTERNAL_ID)] })
    ))

    const { client, signalInserts, quarantined } = createFakeSupabase()
    const result = await pollInstantlyReplies(client, 'test-key')

    // No signal, because no organisation could be resolved. But the reply survives.
    expect(signalInserts).toHaveLength(0)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0].provider_campaign_id).toBe(UNREGISTERED_EXTERNAL_ID)
    expect(quarantined[0].provider_email_id).toBe('email-1')
    // Counted as skipped, NOT as an error: a quarantined reply is a handled outcome and
    // reddening MON-002 on every run that holds one would pin the poll heartbeat.
    expect(result.errors).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('records a poll failure ONLY when the quarantine write itself fails', async () => {
    // This is the case where the reply really is lost, so it must be loud. The campaign id
    // is in the message because that is the remedy, not merely the symptom.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1', UNREGISTERED_EXTERNAL_ID)] })
    ))

    const { client, cursorUpserts } = createFakeSupabase({ failQuarantineWrite: true })
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(result.errors).toBe(1)
    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error).toContain(UNREGISTERED_EXTERNAL_ID)
    expect(row.last_error).toContain('could not be quarantined')
  })

  it('ADDS to error_count instead of resetting it when a reply is genuinely lost', async () => {
    // The erasure this closes: a run that lost a reply used to write error_count 0 over a
    // prior 4, destroying the record of earlier failures on its way past.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1', UNREGISTERED_EXTERNAL_ID)] })
    ))

    const { client, cursorUpserts } = createFakeSupabase({
      priorErrorCount: 4,
      failQuarantineWrite: true,
    })
    await pollInstantlyReplies(client, 'test-key')

    expect(onlyUpsert(cursorUpserts).error_count).toBe(5)
  })

  it('still advances the cursor, because the reply is safely parked', async () => {
    // Quarantined is not held. Holding here would stall every later reply behind a payload
    // that can never resolve until an operator acts, which is strictly worse.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1', UNREGISTERED_EXTERNAL_ID)] })
    ))

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    expect(onlyUpsert(cursorUpserts).last_cursor).toBe('email-1')
  })

  it('a malformed reply with no id is recorded too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [{ eaccount: 'x@example.com', campaign_id: REGISTERED.external_id }] })
    ))

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    expect(onlyUpsert(cursorUpserts).last_error).toContain('missing id')
  })

  it('a reply with no eaccount is recorded, and names the reply it lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [{ id: 'email-9', campaign_id: REGISTERED.external_id }] })
    ))

    const { client, cursorUpserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error).toContain('email-9')
    expect(row.last_error).toContain('eaccount')
  })
})

describe('the recording is scoped, and does not fire on a healthy run', () => {
  it('a resolvable campaign writes a signal and leaves the error state clean', async () => {
    // The positive control for this whole file. If the fake could not resolve a campaign
    // at all, every assertion above would pass for the wrong reason.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [replyRow('email-1', REGISTERED.external_id)] })
    ))

    const { client, cursorUpserts, signalInserts } = createFakeSupabase({ priorErrorCount: 4 })
    const result = await pollInstantlyReplies(client, 'test-key')

    expect(signalInserts).toHaveLength(1)
    expect(signalInserts[0].organisation_id).toBe(REGISTERED.organisation_id)
    expect(result.errors).toBe(0)

    const row = onlyUpsert(cursorUpserts)
    expect(row.last_error).toBeNull()
    // A clean run genuinely does clear the counter. That is the intended behaviour and it
    // is only safe because a failing run now records rather than staying silent.
    expect(row.error_count).toBe(0)
  })
})
