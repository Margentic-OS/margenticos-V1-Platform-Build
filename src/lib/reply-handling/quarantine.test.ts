// Quarantine: park, replay, retain.
//
// The invariant every test here defends: a quarantined reply is resolved ONLY by a real
// signal write, and removed ONLY by retention. Nothing may mark a row resolved to make
// MON-031 go green, because green then means "nobody is waiting" when somebody is.
//
// MUTATION PROOFS, each stated on its test:
//   - drop the 23505 branch in quarantineReply           -> the idempotency test goes red
//   - mark redacted rows resolved in replay              -> the redaction test goes red
//   - delete instead of redact at 30 days                -> the retention test goes red

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  quarantineReply,
  replayQuarantinedReplies,
  applyQuarantineRetention,
  QUARANTINE_REDACT_AFTER_DAYS,
  QUARANTINE_DELETE_AFTER_DAYS,
} from './quarantine'

interface Row {
  id: string
  provider: string
  provider_email_id: string
  provider_campaign_id: string | null
  raw_data: unknown
  original_outbound_body: string | null
  first_seen_at: string
  last_seen_at: string
  body_redacted_at: string | null
  resolved_at: string | null
  resolved_signal_id: string | null
}

// ── Fake Supabase ─────────────────────────────────────────────────────────────
//
// Honours every filter these code paths apply, and THROWS on any it does not implement.
// A fake that silently returns everything for an unimplemented filter cannot test that
// filter, and would let the removal of a guard pass green. That failure has already cost
// this project three separate guards.
function createFake(rows: Row[] = [], opts: { signalInsertError?: { code: string; message: string } } = {}) {
  const signalInserts: Record<string, unknown>[] = []
  let nextId = rows.length + 1

  function makeQuery(table: string) {
    let filtered = [...rows]
    let pendingUpdate: Record<string, unknown> | null = null
    let mode: 'select' | 'update' | 'delete' = 'select'

    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter(r => (r as unknown as Record<string, unknown>)[col] === val)
        return q
      },
      is: (col: string, val: null) => {
        if (val !== null) throw new Error('fake: is() only implements null')
        filtered = filtered.filter(r => (r as unknown as Record<string, unknown>)[col] === null)
        return q
      },
      lt: (col: string, val: string) => {
        filtered = filtered.filter(r => String((r as unknown as Record<string, unknown>)[col]) < val)
        return q
      },
      update: (patch: Record<string, unknown>) => { mode = 'update'; pendingUpdate = patch; return q },
      delete: () => { mode = 'delete'; return q },
      // Anything not implemented must be loud, never silently permissive.
      in: () => { throw new Error('fake: in() not implemented') },
      order: () => { throw new Error('fake: order() not implemented') },
      limit: () => { throw new Error('fake: limit() not implemented') },
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update' && pendingUpdate) {
          filtered.forEach(r => Object.assign(r, pendingUpdate))
          return resolve({ data: filtered.map(r => ({ id: r.id })), error: null })
        }
        if (mode === 'delete') {
          filtered.forEach(r => { rows.splice(rows.indexOf(r), 1) })
          return resolve({ data: filtered.map(r => ({ id: r.id })), error: null })
        }
        return resolve({ data: filtered, error: null })
      },
    }
    if (table !== 'unattributed_replies') throw new Error(`fake: unexpected table ${table}`)
    return q
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'signals') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: async () => {
              if (opts.signalInsertError) return { data: null, error: opts.signalInsertError }
              signalInserts.push(row)
              return { data: [{ id: `signal-${nextId++}` }], error: null }
            },
          }),
        }
      }

      const base = makeQuery(table) as any
      base.insert = async (row: Record<string, unknown>) => {
        const dup = rows.find(
          r => r.provider === row.provider && r.provider_email_id === row.provider_email_id
        )
        if (dup) return { error: { code: '23505', message: 'unattributed_replies_provider_email_id_key' } }
        rows.push({
          id: `q-${nextId++}`,
          body_redacted_at: null,
          resolved_at: null,
          resolved_signal_id: null,
          ...row,
        } as Row)
        return { error: null }
      }
      return base
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, rows, signalInserts }
}

function quarantinedRow(over: Partial<Row> = {}): Row {
  return {
    id: 'q-1',
    provider: 'instantly',
    provider_email_id: 'email-1',
    provider_campaign_id: 'campaign-x',
    raw_data: { id: 'email-1', body: { text: 'yes please' } },
    original_outbound_body: 'our original email',
    first_seen_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    last_seen_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    body_redacted_at: null,
    resolved_at: null,
    resolved_signal_id: null,
    ...over,
  }
}

describe('quarantineReply', () => {
  beforeEach(() => vi.clearAllMocks())

  it('parks a reply that has no resolvable campaign', async () => {
    const { client, rows } = createFake([])

    const outcome = await quarantineReply(client, {
      providerEmailId: 'email-1',
      providerCampaignId: 'campaign-unregistered',
      eaccount: 'sender@example.com',
      rawData: { id: 'email-1' },
      originalOutboundBody: null,
    })

    expect(outcome).toBe('parked')
    expect(rows).toHaveLength(1)
    // The campaign id is what MON-031 names and what registering resolves. Without it the
    // row is an alarm nobody can action.
    expect(rows[0].provider_campaign_id).toBe('campaign-unregistered')
    expect(rows[0].raw_data).toEqual({ id: 'email-1' })
  })

  it('is idempotent, and does NOT reset the ageing clock on re-observation', async () => {
    // MUTATION: remove the 23505 branch and this goes red. The poller re-reads pages after
    // a cursor rewind, so without this a single reply would either duplicate or look
    // permanently new and never age into view on MON-031.
    const existing = quarantinedRow()
    const originalFirstSeen = existing.first_seen_at
    const { client, rows } = createFake([existing])

    const outcome = await quarantineReply(client, {
      providerEmailId: 'email-1',
      providerCampaignId: 'campaign-x',
      eaccount: 'sender@example.com',
      rawData: { id: 'email-1' },
      originalOutboundBody: null,
    })

    expect(outcome).toBe('already_held')
    expect(rows).toHaveLength(1)
    expect(rows[0].first_seen_at).toBe(originalFirstSeen)
    expect(rows[0].last_seen_at).not.toBe(originalFirstSeen)
  })
})

describe('replayQuarantinedReplies', () => {
  beforeEach(() => vi.clearAllMocks())

  it('turns a parked reply into a signal and resolves the row', async () => {
    const { client, rows, signalInserts } = createFake([quarantinedRow()])

    const result = await replayQuarantinedReplies(client, {
      providerCampaignId: 'campaign-x',
      organisationId: 'org-a',
      campaignId: 'internal-a',
    })

    expect(result.replayed).toBe(1)
    expect(signalInserts).toHaveLength(1)
    expect(signalInserts[0].organisation_id).toBe('org-a')
    expect(signalInserts[0].external_event_id).toBe('email-1')
    // The stored payload is replayed as-is. Re-fetching from the provider would fail once
    // the campaign is deleted there, which has already happened once on this system.
    expect(signalInserts[0].raw_data).toEqual({ id: 'email-1', body: { text: 'yes please' } })
    expect(rows[0].resolved_at).not.toBeNull()
    expect(rows[0].resolved_signal_id).toBe('signal-2')
  })

  it('leaves a REDACTED row unresolved, so the alarm survives the data being gone', async () => {
    // MUTATION: resolve redacted rows too and this goes red. Resolving them would clear
    // MON-031 while a real person is still waiting for an answer nobody can now send.
    const { client, rows, signalInserts } = createFake([
      quarantinedRow({ body_redacted_at: new Date('2026-09-05T00:00:00Z').toISOString(), raw_data: null }),
    ])

    const result = await replayQuarantinedReplies(client, {
      providerCampaignId: 'campaign-x',
      organisationId: 'org-a',
      campaignId: 'internal-a',
    })

    expect(result.unreplayable).toBe(1)
    expect(result.replayed).toBe(0)
    expect(signalInserts).toHaveLength(0)
    expect(rows[0].resolved_at).toBeNull()
  })

  it('treats an already-existing signal as resolved rather than a permanent alarm', async () => {
    const { client, rows } = createFake([quarantinedRow()], {
      signalInsertError: { code: '23505', message: 'idx_signals_idempotency' },
    })

    const result = await replayQuarantinedReplies(client, {
      providerCampaignId: 'campaign-x',
      organisationId: 'org-a',
      campaignId: 'internal-a',
    })

    expect(result.skipped).toBe(1)
    expect(rows[0].resolved_at).not.toBeNull()
  })

  it('leaves the row quarantined when the signal write genuinely fails', async () => {
    const { client, rows } = createFake([quarantinedRow()], {
      signalInsertError: { code: '23514', message: 'check violation' },
    })

    const result = await replayQuarantinedReplies(client, {
      providerCampaignId: 'campaign-x',
      organisationId: 'org-a',
      campaignId: 'internal-a',
    })

    expect(result.errors).toBe(1)
    expect(rows[0].resolved_at).toBeNull()
  })

  it('only replays rows for the campaign being registered', async () => {
    // The positive control on the filter. A fake that ignored .eq would make every
    // assertion above pass for the wrong reason.
    const { client, signalInserts } = createFake([
      quarantinedRow({ id: 'q-1', provider_email_id: 'email-1', provider_campaign_id: 'campaign-x' }),
      quarantinedRow({ id: 'q-2', provider_email_id: 'email-2', provider_campaign_id: 'campaign-other' }),
    ])

    const result = await replayQuarantinedReplies(client, {
      providerCampaignId: 'campaign-x',
      organisationId: 'org-a',
      campaignId: 'internal-a',
    })

    expect(result.replayed).toBe(1)
    expect(signalInserts).toHaveLength(1)
    expect(signalInserts[0].external_event_id).toBe('email-1')
  })
})

describe('applyQuarantineRetention', () => {
  beforeEach(() => vi.clearAllMocks())

  const NOW = new Date('2026-10-15T00:00:00Z')
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString()

  it('REDACTS at 30 days but KEEPS the row and the campaign id', async () => {
    // MUTATION: delete instead of redact and this goes red. Deleting would make MON-031 go
    // green because the row aged out, which is a monitor healing by forgetting. MON-028's
    // advice text already bans the equivalent move for reply drafts.
    const { client, rows } = createFake([
      quarantinedRow({ first_seen_at: daysAgo(QUARANTINE_REDACT_AFTER_DAYS + 1) }),
    ])

    const result = await applyQuarantineRetention(client, NOW)

    expect(result.redacted).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].raw_data).toBeNull()
    expect(rows[0].original_outbound_body).toBeNull()
    expect(rows[0].body_redacted_at).not.toBeNull()
    // The two things the alarm needs to stay actionable.
    expect(rows[0].provider_campaign_id).toBe('campaign-x')
    expect(rows[0].resolved_at).toBeNull()
  })

  it('leaves a row younger than the horizon completely alone', async () => {
    const { client, rows } = createFake([
      quarantinedRow({ first_seen_at: daysAgo(QUARANTINE_REDACT_AFTER_DAYS - 1) }),
    ])

    const result = await applyQuarantineRetention(client, NOW)

    expect(result.redacted).toBe(0)
    expect(rows[0].raw_data).not.toBeNull()
  })

  it('does not redact a row that was already resolved', async () => {
    const { client, rows } = createFake([
      quarantinedRow({
        first_seen_at: daysAgo(QUARANTINE_REDACT_AFTER_DAYS + 1),
        resolved_at: daysAgo(QUARANTINE_REDACT_AFTER_DAYS),
      }),
    ])

    const result = await applyQuarantineRetention(client, NOW)

    expect(result.redacted).toBe(0)
    expect(rows[0].raw_data).not.toBeNull()
  })

  it('deletes outright at 180 days', async () => {
    const { client, rows } = createFake([
      quarantinedRow({ first_seen_at: daysAgo(QUARANTINE_DELETE_AFTER_DAYS + 1) }),
    ])

    const result = await applyQuarantineRetention(client, NOW)

    expect(result.deleted).toBe(1)
    expect(rows).toHaveLength(0)
  })

  it('the two horizons are what was agreed, not whatever the code drifted to', async () => {
    // The numbers were a decision taken before the table existed. Pinned so a later edit
    // has to be deliberate.
    expect(QUARANTINE_REDACT_AFTER_DAYS).toBe(30)
    expect(QUARANTINE_DELETE_AFTER_DAYS).toBe(180)
  })
})
