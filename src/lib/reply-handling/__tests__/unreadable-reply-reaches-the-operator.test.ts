// A reply the classifier cannot read must reach BOTH the triage queue and the operator.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT THESE TESTS PIN DOWN, AND WHY THERE ARE TWO INDEPENDENT HALVES
//
// An unreadable reply was invisible for two separate reasons, and closing either one alone
// would have left it invisible through the other:
//
//   1. The empty-body branch in process-reply wrote its action row, marked the signal
//      processed and RETURNED — and that return sat above the operator-notification block.
//      It also wrote no reply_drafts row, and the triage queue, MON-028 and the sidebar
//      badge all read reply_drafts and nothing else. So: no card, and no notification.
//
//   2. 'unclear' was on the notification exclusion list, described there as "logged" with
//      nothing waiting on the operator. Untrue: routeIntent sends unclear to tier_3, the
//      orchestrator drafts it, and a card sits in the queue waiting for a person.
//
// Each test below targets exactly one of those. Reinstating either defect on its own must
// turn exactly one of them red — that independence is the point, because a single test
// covering both would let one half regress silently behind the other.
//
// ═══════════════════════════════════════════════════════════════════════════════
// MUTATION-TESTED, both directions, before this file was committed:
//
//   restore the early return in the empty-body branch
//       -> "writes a triage card"        FAILS   (fake throws: no reply_drafts insert)
//       -> "notifies the operator"       FAILS
//       -> the 'unclear' test            PASSES  (independent, as required)
//
//   re-add 'unclear' to the notification exclusion list
//       -> the 'unclear' test            FAILS
//       -> both empty-body tests         PASS    (independent, as required)
//
// A test that only asserted "processReplies did not throw" passes against BOTH defects,
// which is how this survived to production in the first place.

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

const classifyReply = vi.fn()
vi.mock('@/lib/agents/reply-classifier', () => ({
  classifyReply: (...a: unknown[]) => classifyReply(...(a as [])),
}))

// Typed arg, so mock.calls[0][0] is inspectable rather than inferred as never.
const sendOperatorReplyNotification = vi.fn(
  async (_args: Record<string, unknown>) => ({ sent: true }),
)
vi.mock('@/lib/notifications/send-operator-reply-notification', () => ({
  sendOperatorReplyNotification: (args: Record<string, unknown>) =>
    sendOperatorReplyNotification(args),
}))

// Returning log_only keeps the orchestrator out of the way. The 'unclear' test is about
// whether the OPERATOR IS TOLD, not about what the orchestrator does with the intent.
vi.mock('../draft-orchestrator', () => ({
  orchestrateDraft: vi.fn(async () => ({ kind: 'log_only' })),
}))

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiActive: vi.fn(async () => false),
}))

import { processReplies } from '../process-reply'

/* eslint-disable @typescript-eslint/no-explicit-any */

function signalWithBody(body: unknown) {
  return {
    id: 'sig-1',
    organisation_id: 'org-1',
    campaign_id: 'camp-1',
    raw_data: {
      from_address_email: 'someone@example.com',
      subject: 'Re: your note',
      body,
      id: 'email-1',
      eaccount: 'sender@example.com',
    },
    original_outbound_body: 'the original outbound email',
    created_at: '2026-09-01T00:00:00Z',
  }
}

interface Recorded {
  draftInserts: Array<Record<string, unknown>>
  actionInserts: Array<Record<string, unknown>>
  signalUpdates: Array<Record<string, unknown>>
}

/**
 * A fake serving only the tables this path touches, and THROWING on any other.
 *
 * The throw is load-bearing and is what makes the "writes a triage card" test meaningful.
 * A fake that returned a chain for an unknown table would let the code write to
 * reply_drafts, or fail to, with no assertion able to tell the difference — the shape
 * CLAUDE.md names, where the production code is correct and the test is structurally
 * incapable of noticing when it stops being.
 */
function createFakeDb() {
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
          limit: async () => ({ data: [client.__signal], error: null }),
          update: (v: Record<string, unknown>) => { state.values = v; return b },
          then: (resolve: (x: unknown) => unknown) => {
            if (state.values) rec.signalUpdates.push({ ...state.values, __id: state.eq.id })
            return Promise.resolve(resolve({ data: null, error: null }))
          },
        }
        return b
      }

      if (table === 'reply_drafts') {
        const b: any = {
          insert: (v: Record<string, unknown>) => { rec.draftInserts.push(v); return b },
          select: () => b,
          maybeSingle: async () => ({ data: { id: 'draft-1' }, error: null }),
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
          update: () => b,
          maybeSingle: async () => ({
            data: { id: 'p1', first_name: 'Sam', suppressed: false, email: 'someone@example.com', outbound_lead_id: 'lead-1' },
            error: null,
          }),
          then: (resolve: (x: unknown) => unknown) =>
            Promise.resolve(resolve({ data: null, error: null })),
        }
        return b
      }

      if (table === 'organisations') {
        const b: any = {
          select: () => b,
          eq: () => b,
          single: async () => ({ data: { id: 'org-1', archived_at: null }, error: null }),
          maybeSingle: async () => ({
            data: { name: 'Org', booking_url: null, founder_first_name: 'Sam' },
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
  sendOperatorReplyNotification.mockClear()
})

// ── HALF ONE: the empty-body early return ────────────────────────────────────────

describe('a reply whose body could not be extracted', () => {
  it('writes a triage card, so the queue and MON-028 can see it', async () => {
    // body.text absent is the real shape: an HTML-only reply, or a provider format change.
    const db = createFakeDb()
    db.__signal = signalWithBody({ html: '<p>sure, send a time</p>' })

    const result = await processReplies(db, 'key')

    expect(result.processed).toBe(1)

    // A card exists at all. Without it there is no queue row, no MON-028 age and no badge:
    // three instruments all correctly green about a set that does not contain this reply.
    expect(db.rec.draftInserts).toHaveLength(1)

    const draft = db.rec.draftInserts[0]
    expect(draft.status).toBe('manual_required')
    expect(draft.signal_id).toBe('sig-1')

    // Required by the reply_drafts_body_required CHECK: manual_required rows carry no body.
    expect(draft.ai_draft_body).toBeNull()
    // Required by the reply_drafts_tier_check CHECK, which permits only 2 or 3.
    expect(draft.tier).toBe(3)

    // The reason travels on the row, so an operator opening the queue knows why there is
    // nothing to approve before they open it.
    expect(draft.draft_metadata).toMatchObject({ reason: 'classifier_skipped_empty_body' })
  })

  it('notifies the operator, which the early return used to skip entirely', async () => {
    const db = createFakeDb()
    db.__signal = signalWithBody({ html: '<p>sure, send a time</p>' })

    await processReplies(db, 'key')

    expect(sendOperatorReplyNotification).toHaveBeenCalledTimes(1)
    expect(sendOperatorReplyNotification.mock.calls[0][0]).toMatchObject({
      organisationId: 'org-1',
      signalId: 'sig-1',
      classifiedIntent: 'unclear',
    })
  })

  it('does not call the classifier, because there is nothing to classify', async () => {
    // Guards the fix against the lazy version of itself: making the reply visible by
    // sending an empty body to the model would cost money on every malformed payload.
    const db = createFakeDb()
    db.__signal = signalWithBody({ html: '<p>hello</p>' })

    await processReplies(db, 'key')

    expect(classifyReply).not.toHaveBeenCalled()
  })
})

// ── HALF TWO: the 'unclear' exclusion ────────────────────────────────────────────

describe("a reply the classifier read but could not interpret ('unclear')", () => {
  it('notifies the operator, because unclear routes to tier 3 and waits on a person', async () => {
    // This reply HAS a readable body, so it goes through the classifier and reaches the
    // shared notification block. 'unclear' used to be excluded there on the stated grounds
    // that nothing waits on the operator, which was false.
    classifyReply.mockResolvedValue({
      intent: 'unclear', confidence: 0.4, reasoning: 'cannot tell what they are asking',
    })

    const db = createFakeDb()
    db.__signal = signalWithBody({ text: 'ok' })

    await processReplies(db, 'key')

    expect(sendOperatorReplyNotification).toHaveBeenCalledTimes(1)
    expect(sendOperatorReplyNotification.mock.calls[0][0]).toMatchObject({
      classifiedIntent: 'unclear',
    })
  })

  it('still does not notify for opt_out or out_of_office', async () => {
    // The exclusion list must not be emptied. These two really are handled without a
    // person, and notifying on them is what would train the operator to ignore the alert
    // — the same argument that makes the unclear case worth notifying.
    for (const intent of ['opt_out', 'out_of_office']) {
      sendOperatorReplyNotification.mockClear()
      classifyReply.mockResolvedValue({ intent, confidence: 0.99, reasoning: 'r' })

      const db = createFakeDb()
      db.__signal = signalWithBody({ text: 'please remove me' })

      await processReplies(db, 'key')

      expect(sendOperatorReplyNotification, `${intent} must not notify`).not.toHaveBeenCalled()
    }
  })
})
