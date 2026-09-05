// The approve-and-send path, driven end to end against a TEST ORGANISATION.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: THE PATH HAD NEVER RUN
//
// Measured in production 2026-09-04: reply_drafts has ever held ONE row, status
// manual_required, with reviewed_at, reviewed_by_user_id, sent_at, instantly_message_id
// and send_error all NULL. ever_reviewed = 0. ever_sent = 0.
//
// So every step below — Calendly substitution, sign-off assembly, thread context, the
// provider payload, the atomic status transition — had shipped and been reviewed but had
// never once executed. A path that has never run is not a working path, it is an untested
// one, and the two are indistinguishable until something goes through it.
//
// THE ONE STEP THIS FILE DOES NOT PROVE is the literal HTTPS request. sendThreadReply is
// stubbed at the module boundary, so the assembled payload is asserted rather than
// delivered. Everything on either side of that call is real code.
//
// It runs entirely against a fabricated test organisation. No production row is read or
// written, and no email is sent to anybody.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// Typed explicitly rather than inferred. Inference from a zero-argument arrow makes
// mock.calls[0] a zero-length tuple, so reading the payload the code under test built is a
// type error — and the assertion that matters most in this file is exactly that payload.
interface ThreadReplyPayload {
  replyToUuid: string
  eaccount: string
  subject: string
  bodyText: string
}
interface ThreadReplyResult {
  ok: boolean
  message_id: string | null
  error: string | null
}
const sendThreadReply = vi.hoisted(() =>
  vi.fn(async (
    _payload: ThreadReplyPayload,
    _apiKey?: string,
    _baseUrl?: string,
    _isActive?: boolean,
    _opts?: unknown,
  ): Promise<ThreadReplyResult> => ({ ok: true, message_id: 'provider-msg-1', error: null }))
)
vi.mock('@/lib/integrations/handlers/instantly/reply-actions', () => ({ sendThreadReply }))

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
  getInstantlyApiActive: vi.fn(async () => false),
}))

vi.mock('@/lib/integrations/handlers/instantly/constants', () => ({
  resolveInstantlyBaseUrl: () => 'https://mock.test',
}))

import { sendApprovedDraft } from './send-approved-draft'

// A fabricated organisation. Nothing here corresponds to any real client: the names are
// deliberately generic placeholders, per the standing rule that no company, industry,
// sector, country or buyer type enters code, comments, tests or fixtures.
// Typed to the real column nullability rather than inferred from the literal. Inferred,
// calendly_url would be `string` and a test could not override it to null — which is the
// exact case the "refuses to send when the booking placeholder cannot be filled" test needs.
interface TestOrg {
  name: string
  founder_first_name: string | null
  calendly_url: string | null
}
const TEST_ORG: TestOrg = {
  name: 'Test Organisation',
  founder_first_name: 'Alex',
  calendly_url: 'https://booking.test/alex',
}

const TEST_SIGNAL = {
  id: 'test-signal-1',
  raw_data: {
    id: 'provider-thread-1',
    eaccount: 'sender@test.invalid',
    subject: 'Re: a subject',
    body: { text: 'Sounds good, send me a time.' },
  },
  original_outbound_body: 'The original outbound email.',
}

interface Draft {
  id: string
  organisation_id: string
  signal_id: string
  prospect_id: string | null
  tier: number
  status: string
  final_sent_body: string | null
  ai_draft_body: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function createFakeDb(opts: { draft?: Partial<Draft>; org?: Partial<TestOrg> } = {}) {
  const draft: Draft = {
    id: 'test-draft-1',
    organisation_id: 'test-org-1',
    signal_id: 'test-signal-1',
    prospect_id: 'test-prospect-1',
    tier: 2,
    status: 'approved',
    final_sent_body: 'Happy to talk. Grab a slot here: {calendly_link}',
    ai_draft_body: null,
    ...opts.draft,
  }
  const org = { ...TEST_ORG, ...opts.org }
  const updates: Array<{ values: Record<string, unknown>; countRequested: boolean }> = []

  const client: any = {
    updates,
    from(table: string) {
      if (table === 'reply_drafts') {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: draft, error: null }),
          update: (values: Record<string, unknown>, options?: { count?: string }) => {
            updates.push({ values, countRequested: options?.count === 'exact' })
            // Mirror the real row so a later read sees the transition.
            if (typeof values.status === 'string') draft.status = values.status
            // Two real callers end this chain differently: the success path is
            // .eq('id').eq('status','approved') and markSendFailed is
            // .eq('id').in('status',[...]). A fake serving only one of them makes the
            // other throw from inside the code under test, which is how the first run of
            // this file failed. Both terminators are honoured.
            const settled = {
              error: null,
              count: options?.count === 'exact' ? 1 : null,
            }
            const chain: any = {
              eq: () => chain,
              in: async () => settled,
              then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(settled)),
            }
            return chain
          },
        }
        return b
      }
      if (table === 'organisations') {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: org, error: null }) }
        return b
      }
      if (table === 'signals') {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: TEST_SIGNAL, error: null }) }
        return b
      }
      throw new Error(`fake does not implement table ${table}`)
    },
  }
  return client
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  vi.clearAllMocks()
  sendThreadReply.mockResolvedValue({ ok: true, message_id: 'provider-msg-1', error: null })
})

describe('a draft an operator approved reaches the provider, assembled correctly', () => {
  it('sends, and marks the row sent with the provider message id', async () => {
    const db = createFakeDb()
    const result = await sendApprovedDraft('test-draft-1', db)

    expect(result).toMatchObject({ kind: 'sent', instantly_message_id: 'provider-msg-1' })
    expect(sendThreadReply).toHaveBeenCalledTimes(1)

    const sentRow = db.updates.find((u: { values: Record<string, unknown> }) => u.values.status === 'sent')
    expect(sentRow).toBeDefined()
    expect(sentRow!.values).toMatchObject({ status: 'sent', instantly_message_id: 'provider-msg-1' })
    // The idempotency guard has to actually ask for a count, or its count === 0 branch is
    // unreachable. Same defect class as the approve route's 409.
    expect(sentRow!.countRequested).toBe(true)
  })

  it('substitutes the booking link and ends the body with the sign-off', async () => {
    const db = createFakeDb()
    await sendApprovedDraft('test-draft-1', db)

    const body = sendThreadReply.mock.calls[0][0].bodyText

    // The placeholder is gone and the real link is in its place. Shipping the literal
    // '{calendly_link}' to a prospect is the failure this guards.
    expect(body).toContain('https://booking.test/alex')
    expect(body).not.toContain('{calendly_link}')

    // The sign-off is the last thing in the body.
    expect(body.trimEnd().endsWith('Alex')).toBe(true)

    // WHAT THIS TEST DOES NOT PROVE, stated because the first version of it claimed
    // otherwise. sendApprovedDraft substitutes the booking link and THEN inserts the
    // sign-off, and the source comments treat that order as load-bearing. It is not
    // observable here: swapping the two calls was mutation-tested and all eight tests in
    // this file stayed GREEN. With substituteBookingLink replacing in place and
    // insertSignoff appending, either order yields the same bytes for any body whose
    // placeholder sits before the sign-off, which is every body the agent can produce.
    //
    // So the order is currently a convention, not a constraint, and no test should imply
    // it is pinned. It WOULD become observable if the sign-off ever contained a
    // placeholder itself, or if substitution began appending rather than replacing. If
    // either changes, pin the order then, with a fixture that can tell them apart.
  })

  it('carries the thread context the provider needs to thread the reply', async () => {
    const db = createFakeDb()
    await sendApprovedDraft('test-draft-1', db)

    // Taken from the SIGNAL's raw_data, not from the draft. Losing this sends a fresh
    // email instead of a reply, which the prospect sees as a stranger writing to them.
    expect(sendThreadReply.mock.calls[0][0]).toMatchObject({
      replyToUuid: 'provider-thread-1',
      eaccount: 'sender@test.invalid',
      subject: 'Re: a subject',
    })
  })
})

describe('the failure invariant: never left at approved', () => {
  it('marks send_failed and does not claim success when the provider refuses', async () => {
    sendThreadReply.mockResolvedValue({ ok: false, message_id: null, error: 'provider rejected' })

    const db = createFakeDb()
    const result = await sendApprovedDraft('test-draft-1', db)

    expect(result.kind).toBe('send_failed')
    expect(db.updates.some((u: { values: Record<string, unknown> }) => u.values.status === 'send_failed')).toBe(true)
    expect(db.updates.some((u: { values: Record<string, unknown> }) => u.values.status === 'sent')).toBe(false)
  })

  it('refuses to send an empty body rather than mailing a blank reply', async () => {
    const db = createFakeDb({ draft: { final_sent_body: '   ' } })
    const result = await sendApprovedDraft('test-draft-1', db)

    expect(result).toMatchObject({ kind: 'send_failed', reason: 'final_sent_body_empty' })
    expect(sendThreadReply).not.toHaveBeenCalled()
  })

  it('refuses to send when the booking placeholder cannot be filled', async () => {
    // Sending the literal '{calendly_link}' to a prospect is worse than not sending.
    const db = createFakeDb({ org: { calendly_url: null } })
    const result = await sendApprovedDraft('test-draft-1', db)

    expect(result).toMatchObject({ kind: 'send_failed', reason: 'calendly_link_required_but_missing' })
    expect(sendThreadReply).not.toHaveBeenCalled()
  })

  it('refuses to send without a sender first name rather than signing off blank', async () => {
    const db = createFakeDb({ org: { founder_first_name: '  ' } })
    const result = await sendApprovedDraft('test-draft-1', db)

    expect(result).toMatchObject({ kind: 'send_failed', reason: 'founder_first_name_required_but_missing' })
    expect(sendThreadReply).not.toHaveBeenCalled()
  })

  it('skips a row already sent instead of sending twice', async () => {
    const db = createFakeDb({ draft: { status: 'sent' } })
    const result = await sendApprovedDraft('test-draft-1', db)

    expect(result.kind).toBe('idempotent_skip')
    expect(sendThreadReply).not.toHaveBeenCalled()
  })
})
