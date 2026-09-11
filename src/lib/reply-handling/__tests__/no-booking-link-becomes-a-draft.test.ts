// A prospect who asks to book, at an organisation with no booking link, must reach a
// person. Before 2026-09-10 they reached nobody.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT
//
// A high-confidence booking reply took the automatic send path whatever the organisation
// had configured. With organisations.calendly_url empty it failed the link check, wrote a
// failed action row and returned. The next cron run saw that row, marked the signal
// processed, and never retried. No reply_drafts row was ever written, so the triage queue,
// MON-028 and the sidebar badge could not see it either. The prospect received nothing.
//
// Two of the three live client organisations had no link when this was found.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE RUNS THE REAL ORCHESTRATOR
//
// process-reply.test.ts and the other reply tests mock draft-orchestrator. That is fine for
// what they test, and useless here: the orchestrator THREW on a Tier 1 booking intent, so a
// mocked orchestrator would have passed a fix that only changed process-reply while every
// real reply died in that throw. So only the model calls and the send are stubbed. The
// routing, the orchestrator and the reply_drafts insert are the real code.
//
// The send stub is a spy, and "no send attempted" is always paired with a positive control
// in which the same harness DOES record a send. Without that, a spy that could never fire
// would make the absence assertion pass vacuously.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'checkin'),
  flush: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/suppression/provider-suppression', () => ({
  suppressProspectAtProvider: vi.fn(),
  suppressAddressAtProvider: vi.fn(),
}))

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiActive: vi.fn(async () => false),
}))

const classifyReply = vi.fn()
vi.mock('@/lib/agents/reply-classifier', () => ({
  classifyReply: (...a: unknown[]) => classifyReply(...(a as [])),
}))

const sendOperatorReplyNotification = vi.fn(async (_args: Record<string, unknown>) => ({ sent: true }))
vi.mock('@/lib/notifications/send-operator-reply-notification', () => ({
  sendOperatorReplyNotification: (args: Record<string, unknown>) => sendOperatorReplyNotification(args),
}))

// The one function that puts a reply in a prospect's inbox. A spy, so an attempt is visible.
const sendThreadReply = vi.fn(
  async (_args: { bodyText: string }, ..._rest: unknown[]) => ({ ok: true, raw: { id: 'm1' }, message_id: 'm1' }),
)
vi.mock('@/lib/integrations/handlers/instantly/reply-actions', () => ({
  sendThreadReply: (args: { bodyText: string }, ...rest: unknown[]) => sendThreadReply(args, ...rest),
}))

vi.mock('@/lib/faq/matcher', () => ({
  findFaqMatches: vi.fn(async () => []),
}))

vi.mock('../load-org-context', () => ({
  loadOrgContext: vi.fn(async () => ({
    tovDocument: 'tov',
    positioningDocument: 'positioning',
    organisationName: 'Org',
    senderFirstName: 'Sam',
  })),
}))

// The model call, stubbed. Written the way the drafter prompt asks: the link as a
// placeholder, filled in at send from the organisation's booking link.
const draftReply = vi.fn(async (_args: Record<string, unknown>) => ({
  tier: 2 as const,
  draft_body: 'Great to hear from you. Happy to find a time that works: {calendly_link}',
  faq_ids_used: [],
  confidence_at_draft: 0.95,
  prompt_version: 'test',
}))
vi.mock('@/lib/agents/reply-draft-agent', () => ({
  draftReply: (args: Record<string, unknown>) => draftReply(args),
}))

import { processReplies } from '../process-reply'

/* eslint-disable @typescript-eslint/no-explicit-any */

const SIGNAL = {
  id: 'sig-1',
  organisation_id: 'org-1',
  campaign_id: 'camp-1',
  raw_data: {
    from_address_email: 'prospect@example.com',
    subject: 'Re: your note',
    body: { text: 'Yes, keen to talk. Send me a time.' },
    id: 'email-1',
    eaccount: 'sender@example.com',
  },
  original_outbound_body: 'the original outbound email',
  created_at: '2026-09-10T00:00:00Z',
}

interface Recorded {
  draftInserts: Array<Record<string, unknown>>
  actionInserts: Array<Record<string, unknown>>
  signalUpdates: Array<Record<string, unknown>>
}

/**
 * Serves only the tables this path touches and THROWS on any other, so a write to a table
 * no assertion is watching cannot pass unnoticed.
 */
function createFakeDb(opts: { calendlyUrl: string | null }) {
  const rec: Recorded = { draftInserts: [], actionInserts: [], signalUpdates: [] }

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
          insert: (v: Record<string, unknown>) => {
            state.values = v; state.mode = 'insert'; rec.actionInserts.push(v); return b
          },
          update: (v: Record<string, unknown>) => { state.values = v; state.mode = 'update'; return b },
          eq: (c: string, v: unknown) => {
            state.eq[c] = v
            if (state.mode === 'update') return Promise.resolve({ error: null })
            // The idempotency read: no prior action for this signal.
            if (!state.mode) return Promise.resolve({ data: [], error: null })
            return b
          },
          maybeSingle: async () => ({ data: { id: 'action-1' }, error: null }),
        }
        return b
      }

      if (table === 'reply_drafts') {
        // Two reads end here: the orchestrator's idempotency check (.maybeSingle, no
        // existing draft) and the insert's read-back of the new id (.single).
        const b: any = {
          select: () => b,
          eq: () => b,
          insert: (v: Record<string, unknown>) => { rec.draftInserts.push(v); return b },
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: { id: 'draft-1' }, error: null }),
        }
        return b
      }

      if (table === 'agent_runs') {
        // The drafter failure circuit breaker: no recent failures.
        const b: any = {
          select: () => b,
          eq: () => b,
          gte: async () => ({ data: [], error: null }),
        }
        return b
      }

      if (table === 'prospects') {
        const b: any = {
          select: () => b,
          eq: () => b,
          ilike: () => b,
          update: () => b,
          maybeSingle: async () => ({
            data: { id: 'p1', first_name: 'Jo', suppressed: false, email: 'prospect@example.com', outbound_lead_id: 'lead-1' },
            error: null,
          }),
          then: (resolve: (x: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: null })),
        }
        return b
      }

      if (table === 'organisations') {
        const b: any = {
          select: () => b,
          eq: () => b,
          single: async () => ({ data: { id: 'org-1', archived_at: null }, error: null }),
          maybeSingle: async () => ({
            data: { name: 'Org', calendly_url: opts.calendlyUrl, founder_first_name: 'Sam' },
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
  classifyReply.mockReset()
  classifyReply.mockResolvedValue({
    intent: 'positive_direct_booking', confidence: 0.95, reasoning: 'asked for a time',
  })
  sendThreadReply.mockClear()
  sendOperatorReplyNotification.mockClear()
  draftReply.mockClear()
})

describe('a booking reply at an organisation with no booking link', () => {
  it('writes a draft to the triage queue and attempts no send', async () => {
    const db = createFakeDb({ calendlyUrl: null })

    const result = await processReplies(db, 'key')

    expect(result.errors).toBe(0)
    expect(result.processed).toBe(1)

    // THE CARD. This is what the old path never wrote.
    expect(db.rec.draftInserts).toHaveLength(1)
    expect(db.rec.draftInserts[0]).toMatchObject({
      organisation_id: 'org-1',
      signal_id: 'sig-1',
      prospect_id: 'p1',
      intent: 'positive_direct_booking',
      status: 'pending',
      tier: 2,
    })
    // The placeholder survives into the draft, so the link is filled in at send once the
    // operator has set one.
    expect(db.rec.draftInserts[0].ai_draft_body).toContain('{calendly_link}')
    expect(draftReply).toHaveBeenCalledTimes(1)
    expect(draftReply.mock.calls[0][0]).toMatchObject({ tierHint: 2 })

    // NO SEND. Paired with the positive control below, which proves this spy does fire.
    expect(sendThreadReply).not.toHaveBeenCalled()
    // And no send_reply action row: the one action row written records the draft.
    expect(db.rec.actionInserts.map((r: Record<string, unknown>) => r.action_taken)).toEqual(['drafted'])

    // Handled, so it does not loop, and the operator was told.
    expect(db.rec.signalUpdates.some((u: Record<string, unknown>) => u.processed === true)).toBe(true)
    expect(sendOperatorReplyNotification).toHaveBeenCalledTimes(1)
  })

  it('treats a whitespace-only link as no link, rather than sending a blank one', async () => {
    const db = createFakeDb({ calendlyUrl: '   ' })

    await processReplies(db, 'key')

    // Positive half first: the reply went somewhere, and that somewhere is the queue.
    expect(db.rec.draftInserts).toHaveLength(1)
    expect(sendThreadReply).not.toHaveBeenCalled()
  })
})

describe('POSITIVE CONTROL: the same reply at an organisation WITH a booking link', () => {
  it('is sent automatically with the link, and writes no draft', async () => {
    const db = createFakeDb({ calendlyUrl: 'https://booking.test/alex' })

    const result = await processReplies(db, 'key')

    expect(result.processed).toBe(1)

    // The spy fires in this harness, so its silence in the tests above means something.
    expect(sendThreadReply).toHaveBeenCalledTimes(1)
    expect(sendThreadReply.mock.calls[0][0].bodyText).toContain('https://booking.test/alex')

    expect(db.rec.draftInserts).toHaveLength(0)
    expect(draftReply).not.toHaveBeenCalled()
    expect(db.rec.actionInserts.map((r: Record<string, unknown>) => r.action_taken)).toEqual(['send_reply'])
  })
})
