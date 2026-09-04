// Tests for the opt-out dispatch in process-reply: what happens to the SIGNAL and the
// ACTION ROW when the sending provider could not be told.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE USED TO BE, AND WHY IT IS WORTH SAYING
//
// It held three tests about "the Instantly lead resolution guard". None of them called the
// module. Each declared local variables and then asserted on those same locals:
//
//     const isActive = false
//     expect(isActive).toBe(false)
//
// So the file was green whatever process-reply did, and it stayed green when the function
// it named, resolveInstantlyLeadId, was deleted outright. That is the same family as a fake
// that does not honour a filter: the suite reports success about something it never reached.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE BUG THESE TESTS PIN DOWN
//
// The suppress dispatch used to set { ok: true } when no provider lead id could be
// resolved. The signal was marked processed, the action row said succeeded, and the retry
// never happened. The reasoning written beside it was that the database is authoritative,
// which is true for FUTURE uploads and false for the sequence already in flight, which is
// the only thing that call can stop.
//
// So the case where the call mattered most was the one recorded as a success.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'checkin'),
  flush: vi.fn(() => Promise.resolve()),
}))

const suppressProspectAtProvider = vi.fn()
const suppressAddressAtProvider = vi.fn()
vi.mock('@/lib/suppression/provider-suppression', () => ({
  suppressProspectAtProvider: (...a: unknown[]) => suppressProspectAtProvider(...(a as [])),
  suppressAddressAtProvider: (...a: unknown[]) => suppressAddressAtProvider(...(a as [])),
}))

const classifyReply = vi.fn()
vi.mock('@/lib/agents/reply-classifier', () => ({
  classifyReply: (...a: unknown[]) => classifyReply(...(a as [])),
}))

vi.mock('@/lib/notifications/send-first-reply-email', () => ({
  sendFirstReplyEmail: vi.fn(async () => undefined),
}))

vi.mock('./draft-orchestrator', () => ({
  orchestrateDraft: vi.fn(async () => ({ action_taken: 'log_only' })),
}))

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiActive: vi.fn(async () => false),
}))

import { processReplies } from './process-reply'

/* eslint-disable @typescript-eslint/no-explicit-any */

const SIGNAL = {
  id: 'sig-1',
  organisation_id: 'org-1',
  campaign_id: 'camp-1',
  raw_data: {
    from_address_email: 'optout@example.com',
    subject: 'stop',
    body: { text: 'please remove me' },
    id: 'email-1',
    eaccount: 'sender@example.com',
  },
  original_outbound_body: null,
  created_at: '2026-09-01T00:00:00Z',
}

interface Recorded {
  actionUpdates: Array<Record<string, unknown>>
  signalUpdates: Array<Record<string, unknown>>
  prospectUpdates: Array<Record<string, unknown>>
}

/**
 * A fake Supabase serving only the four tables this path touches, and THROWING on any
 * other. A fake that returns a chain for an unknown table lets the code under test write
 * somewhere no assertion is looking.
 */
function createFakeDb(opts: { prospect?: Record<string, unknown> | null } = {}) {
  const rec: Recorded = { actionUpdates: [], signalUpdates: [], prospectUpdates: [] }
  const prospect = opts.prospect === undefined
    ? { id: 'p1', first_name: 'Sam', suppressed: false, email: 'optout@example.com', outbound_lead_id: 'lead-1' }
    : opts.prospect

  const client: any = {
    rec,
    from(table: string) {
      const state: any = { eq: {}, values: undefined, mode: undefined }

      if (table === 'signals') {
        const b: any = {
          select: () => b,
          eq: (c: string, v: unknown) => { state.eq[c] = v; return b },
          order: () => b,
          limit: async () => ({ data: [SIGNAL], error: null }),
          update: (v: Record<string, unknown>) => { state.values = v; return b },
          then: (resolve: (x: unknown) => unknown) => {
            if (state.values) rec.signalUpdates.push({ ...state.values, __id: state.eq.id })
            return Promise.resolve(resolve({ data: null, error: null }))
          },
        }
        return b
      }

      if (table === 'reply_handling_actions') {
        const b: any = {
          select: () => b,
          insert: (v: Record<string, unknown>) => { state.values = v; state.mode = 'insert'; return b },
          update: (v: Record<string, unknown>) => { state.values = v; state.mode = 'update'; return b },
          eq: (c: string, v: unknown) => {
            state.eq[c] = v
            if (state.mode === 'update') {
              rec.actionUpdates.push({ ...state.values, __id: state.eq.id })
              return Promise.resolve({ error: null })
            }
            // The idempotency read ends on its only .eq().
            if (!state.mode) return Promise.resolve({ data: [], error: null })
            return b
          },
          maybeSingle: async () => ({ data: { id: 'action-1' }, error: null }),
        }
        return b
      }

      if (table === 'prospects') {
        const b: any = {
          select: () => b,
          eq: () => b,
          ilike: () => b,
          update: (v: Record<string, unknown>) => { state.values = v; return b },
          maybeSingle: async () => ({ data: prospect, error: null }),
          then: (resolve: (x: unknown) => unknown) => {
            if (state.values) rec.prospectUpdates.push(state.values)
            return Promise.resolve(resolve({ data: null, error: null }))
          },
        }
        return b
      }

      if (table === 'organisations') {
        // Read TWICE on this path, with different terminators: the archived-org gate ends
        // on .single(), and the name/calendly read ends on .maybeSingle(). Serving only one
        // of them is how the first version of this fake made every test throw.
        const b: any = {
          select: () => b,
          eq: () => b,
          single: async () => ({ data: { id: 'org-1', archived_at: null }, error: null }),
          maybeSingle: async () => ({
            data: { name: 'Org', calendly_url: null, founder_first_name: 'Sam' },
            error: null,
          }),
        }
        return b
      }

      throw new Error(`fake does not implement table ${table}`)
    },
  }
  return client
}

beforeEach(() => {
  suppressProspectAtProvider.mockReset()
  suppressAddressAtProvider.mockReset()
  classifyReply.mockReset()
  classifyReply.mockResolvedValue({ intent: 'opt_out', confidence: 0.99, reasoning: 'asked to stop' })
})

describe('process-reply opt-out dispatch', () => {
  it('records a FAILURE when the provider could not be told, and leaves the signal to retry', async () => {
    // THE REGRESSION TEST FOR THE FABRICATED SUCCESS. This is the exact case that used to
    // return { ok: true }: nothing could be resolved at the provider.
    suppressProspectAtProvider.mockResolvedValue({
      status: 'failed',
      stoppedLeadIds: [],
      error: 'no provider lead could be resolved',
    })

    const db = createFakeDb()
    const result = await processReplies(db, 'key')

    expect(result.errors).toBe(1)
    expect(result.processed).toBe(0)

    // The action row says it did NOT succeed, and carries why.
    expect(db.rec.actionUpdates[0].action_succeeded).toBe(false)
    expect(String(db.rec.actionUpdates[0].action_error)).toContain('no provider lead')

    // AND THE SIGNAL IS NOT MARKED PROCESSED, so the next cron run retries. This is the
    // half the old code lost: it marked processed and the retry never came.
    expect(db.rec.signalUpdates).toHaveLength(0)
  })

  it('still applies the database suppression when the provider call fails', async () => {
    // The two halves are independent. A provider that cannot be reached must not cost the
    // prospect their database suppression, which is what gates every future upload.
    suppressProspectAtProvider.mockResolvedValue({
      status: 'failed', stoppedLeadIds: [], error: 'provider 503',
    })

    const db = createFakeDb()
    await processReplies(db, 'key')

    expect(db.rec.prospectUpdates[0]).toMatchObject({
      suppressed: true,
      suppression_reason: 'explicit_opt_out',
    })
  })

  it('writes the database suppression BEFORE calling the provider', async () => {
    // Order matters. Provider first, then a failed database write, would leave the person
    // stopped at the provider while our record still said they may be mailed.
    const order: string[] = []
    const db = createFakeDb()
    const originalFrom = db.from.bind(db)
    db.from = (t: string) => {
      const b = originalFrom(t)
      if (t === 'prospects') {
        const update = b.update.bind(b)
        b.update = (v: Record<string, unknown>) => { order.push('db'); return update(v) }
      }
      return b
    }
    suppressProspectAtProvider.mockImplementation(async () => {
      order.push('provider')
      return { status: 'confirmed', stoppedLeadIds: ['lead-1'], error: null }
    })

    await processReplies(db, 'key')
    expect(order).toEqual(['db', 'provider'])
  })

  it('marks the signal processed when the provider confirms', async () => {
    suppressProspectAtProvider.mockResolvedValue({
      status: 'confirmed', stoppedLeadIds: ['lead-1'], error: null,
    })

    const db = createFakeDb()
    const result = await processReplies(db, 'key')

    expect(result.processed).toBe(1)
    expect(db.rec.actionUpdates[0].action_succeeded).toBe(true)
    expect(db.rec.signalUpdates[0]).toMatchObject({ processed: true })
  })

  it('accepts not_required as a pass, because the provider genuinely holds nothing', async () => {
    suppressProspectAtProvider.mockResolvedValue({
      status: 'not_required', stoppedLeadIds: [], error: null,
    })

    const db = createFakeDb()
    expect((await processReplies(db, 'key')).processed).toBe(1)
  })

  it('passes the stored provider lead id AND the address, so duplicates are swept', async () => {
    suppressProspectAtProvider.mockResolvedValue({
      status: 'confirmed', stoppedLeadIds: ['lead-1'], error: null,
    })

    const db = createFakeDb()
    await processReplies(db, 'key')

    expect(suppressProspectAtProvider).toHaveBeenCalledWith(db, {
      id: 'p1',
      organisation_id: 'org-1',
      email: 'optout@example.com',
      outbound_lead_id: 'lead-1',
    })
  })

  it('falls back to the address path when the opt-out has no prospect row', async () => {
    // No prospect row means the database suppression cannot be applied at all, so the
    // provider call is the ONLY thing between this person and the rest of the sequence.
    suppressAddressAtProvider.mockResolvedValue({
      status: 'confirmed', stoppedLeadIds: ['lead-9'], error: null,
    })

    const db = createFakeDb({ prospect: null })
    const result = await processReplies(db, 'key')

    expect(suppressAddressAtProvider).toHaveBeenCalledWith(db, 'org-1', 'optout@example.com')
    expect(suppressProspectAtProvider).not.toHaveBeenCalled()
    expect(result.processed).toBe(1)
    expect(db.rec.prospectUpdates).toHaveLength(0)
  })
})
