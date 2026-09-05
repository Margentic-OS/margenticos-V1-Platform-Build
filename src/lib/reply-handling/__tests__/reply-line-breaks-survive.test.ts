// Line breaks in a sent reply survive as MARKUP in what the provider actually receives.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE ASSERTS ON THE HTTP REQUEST BODY AND NOT ON OUR OWN PAYLOAD
//
// THE DEFECT, measured 2026-09-05 by reading a real delivered message back out of the
// provider. We sent, as body.text:
//
//     "Thanks for coming back to me. Grab a slot here: https://…/15min\n\nDoug"
//
// The provider wrapped that in an HTML document and dropped it into <body> WITHOUT
// converting newlines. HTML collapses whitespace, so what arrived was:
//
//     "Thanks for coming back to me. Grab a slot here: https://…/15min Doug"
//
// The sign-off ran into the call to action. Every line break in every reply vanished.
//
// WHY EIGHT EXISTING TESTS WERE ALL GREEN WHILE THIS SHIPPED. send-approved-draft.test.ts
// stubs sendThreadReply and asserts on the object we hand it. Those assertions were
// CORRECT — the text really did end in "\n\nDoug". The fault was downstream of our last
// line of code, in how a text-only body renders. A test asserting "we send text ending in
// a newline" passes today and proves nothing about what a person receives.
//
// So these tests stub GLOBAL FETCH and assert on the JSON body of the HTTP request, which
// is the last thing we control and the first thing the provider sees. Line breaks must be
// present there as markup, not as raw \n.
//
// MUTATION-PROVED. Removing the plainTextToHtml call in send-approved-draft.ts turns the
// first describe block red; removing it in process-reply.ts's Calendly path turns the
// second red. Reverting reply-actions.ts to `body: { text }` turns both red.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
  getInstantlyApiActive: vi.fn(async () => true),
}))

import { sendApprovedDraft } from '../send-approved-draft'
import { sendThreadReply } from '@/lib/integrations/handlers/instantly/reply-actions'

const TEST_ORG = {
  name: 'ZZ Internal Test Org',
  founder_first_name: 'Alex',
  calendly_url: 'https://booking.test/alex',
}

const TEST_SIGNAL = {
  id: 'signal-1',
  raw_data: {
    id: 'provider-thread-1',
    eaccount: 'sender@test.invalid',
    subject: 'Re: a subject',
    body: { text: 'yes please' },
  },
  original_outbound_body: 'the original',
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function createFakeDb() {
  const draft = {
    id: 'draft-1',
    organisation_id: 'org-1',
    signal_id: 'signal-1',
    prospect_id: 'prospect-1',
    tier: 2,
    status: 'approved',
    // Two paragraphs and a placeholder, so the assertion has real structure to check.
    final_sent_body: 'Thanks for coming back to me.\n\nGrab a slot here: {calendly_link}',
    ai_draft_body: null as string | null,
  }
  const client: any = {
    from(table: string) {
      if (table === 'reply_drafts') {
        const b: any = {
          select: () => b, eq: () => b,
          maybeSingle: async () => ({ data: draft, error: null }),
          update: (values: Record<string, unknown>, options?: { count?: string }) => {
            if (typeof values.status === 'string') draft.status = values.status
            const settled = { error: null, count: options?.count === 'exact' ? 1 : null }
            const chain: any = {
              eq: () => chain,
              in: async () => settled,
              then: (r: (v: unknown) => unknown) => Promise.resolve(r(settled)),
            }
            return chain
          },
        }
        return b
      }
      if (table === 'organisations') {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: TEST_ORG, error: null }) }
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

// Captures the JSON body of the outbound HTTP request — the provider's-eye view.
function captureRequestBody() {
  const calls: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify({ id: 'provider-msg-1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTANTLY_API_ACTIVE = 'true'
  process.env.INSTANTLY_API_BASE_URL = 'https://mock.test/api/v2'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_ACTIVE
  delete process.env.INSTANTLY_API_BASE_URL
})

describe('an operator-approved reply reaches the provider with its structure intact', () => {
  it('sends an html body in which the paragraph break is markup, not a raw newline', async () => {
    const calls = captureRequestBody()
    const result = await sendApprovedDraft('draft-1', createFakeDb())

    expect(result.kind).toBe('sent')
    expect(calls).toHaveLength(1)

    const html = (calls[0].body as { html?: string }).html
    expect(html).toBeDefined()

    // THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG. The delivered structure has to be
    // carried by markup, because a raw \n is exactly what the provider throws away.
    expect(html).toContain('</p><p>')
    expect(html).not.toContain('\n\n')

    // And each piece landed in its own paragraph rather than running together.
    expect(html).toContain('<p>Thanks for coming back to me.</p>')
    expect(html).toContain('https://booking.test/alex')
  })

  it('puts the sign-off in its own paragraph, which is the exact thing that shipped broken', async () => {
    const calls = captureRequestBody()
    await sendApprovedDraft('draft-1', createFakeDb())

    const html = (calls[0].body as { html: string }).html
    // The real delivered message read "...15min Doug" on one line. This is that case.
    expect(html).toContain('<p>Alex</p>')
    expect(html).not.toMatch(/15min Alex|alex Alex/)
  })

  it('still sends text alongside the html, so a plain-text client is not left with nothing', async () => {
    const calls = captureRequestBody()
    await sendApprovedDraft('draft-1', createFakeDb())

    const body = calls[0].body as { text?: string; html?: string }
    expect(body.text).toBeDefined()
    expect(body.html).toBeDefined()
    // The text half keeps the real newlines a text client needs.
    expect(body.text).toContain('\n\nAlex')
  })
})

describe('the API boundary forwards html without composing it', () => {
  it('passes through exactly the html it was handed', async () => {
    const calls = captureRequestBody()

    await sendThreadReply(
      {
        replyToUuid: 'uuid-1',
        eaccount: 'sender@test.invalid',
        subject: 'Re: a subject',
        bodyText: 'one\n\ntwo',
        bodyHtml: '<p>one</p><p>two</p>',
      },
      'key',
      'https://mock.test/api/v2',
      true,
    )

    // reply-actions.ts states it composes nothing. If it ever starts deriving html from
    // text itself, this fails and the header's promise is enforced rather than merely
    // written down.
    expect((calls[0].body as { html: string }).html).toBe('<p>one</p><p>two</p>')
    expect((calls[0].body as { text: string }).text).toBe('one\n\ntwo')
  })
})

// ── The AUTOMATED path ────────────────────────────────────────────────────────
//
// The Calendly reply for a high-confidence booking intent sends WITHOUT an operator
// seeing it. buildCalendlyReplyBody returns a greeting, a line carrying the booking link,
// and a sign-off, separated by blank lines. Under a text-only body all three arrived as
// one run-on line, unreviewed, to a prospect who had just said they want to book.
//
// This block has its own fake rather than reusing process-reply.test.ts's, because that
// file pins getInstantlyApiActive to false so its sends go through mock dispatch and never
// reach fetch. Asserting on the request body needs the real path.

const classifyReplyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agents/reply-classifier', () => ({
  classifyReply: (...a: unknown[]) => classifyReplyMock(...(a as [])),
}))
vi.mock('@/lib/suppression/provider-suppression', () => ({
  suppressProspectAtProvider: vi.fn(), suppressAddressAtProvider: vi.fn(),
}))
vi.mock('@/lib/notifications/send-operator-reply-notification', () => ({
  sendOperatorReplyNotification: vi.fn(async () => ({ sent: true })),
}))
vi.mock('../draft-orchestrator', () => ({
  orchestrateDraft: vi.fn(async () => ({ action_taken: 'log_only' })),
}))

import { processReplies } from '../process-reply'

const AUTO_SIGNAL = {
  id: 'sig-auto',
  organisation_id: 'org-1',
  campaign_id: 'camp-1',
  raw_data: {
    from_address_email: 'prospect@test.invalid',
    subject: 'Re: a subject',
    body: { text: 'yes, send me a time' },
    id: 'provider-thread-1',
    eaccount: 'sender@test.invalid',
  },
  original_outbound_body: null,
  created_at: '2026-09-05T00:00:00Z',
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function createAutoReplyDb() {
  const client: any = {
    from(table: string) {
      const state: any = { values: undefined, mode: undefined }
      if (table === 'signals') {
        const b: any = {
          select: () => b, eq: () => b, order: () => b,
          limit: async () => ({ data: [AUTO_SIGNAL], error: null }),
          update: (v: Record<string, unknown>) => { state.values = v; return b },
          then: (r: (x: unknown) => unknown) => Promise.resolve(r({ data: null, error: null })),
        }
        return b
      }
      if (table === 'reply_handling_actions') {
        const b: any = {
          select: () => b,
          insert: (v: Record<string, unknown>) => { state.values = v; state.mode = 'insert'; return b },
          update: (v: Record<string, unknown>) => { state.values = v; state.mode = 'update'; return b },
          eq: () => {
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
          select: () => b, eq: () => b, ilike: () => b,
          update: (v: Record<string, unknown>) => { state.values = v; return b },
          maybeSingle: async () => ({
            data: { id: 'p1', first_name: 'Sam', suppressed: false,
                    email: 'prospect@test.invalid', outbound_lead_id: 'lead-1' },
            error: null,
          }),
          then: (r: (x: unknown) => unknown) => Promise.resolve(r({ data: null, error: null })),
        }
        return b
      }
      if (table === 'organisations') {
        const b: any = {
          select: () => b, eq: () => b,
          single: async () => ({ data: { id: 'org-1', archived_at: null }, error: null }),
          maybeSingle: async () => ({
            data: { name: 'ZZ Internal Test Org', calendly_url: 'https://booking.test/alex',
                    founder_first_name: 'Alex' },
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
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('the automated booking reply keeps its structure too', () => {
  it('sends html whose paragraphs are markup, on a path no operator reviews', async () => {
    classifyReplyMock.mockResolvedValue({
      intent: 'positive_direct_booking', confidence: 0.99, reasoning: 'asked for a time',
    })
    const calls = captureRequestBody()

    await processReplies(createAutoReplyDb(), 'key')

    const replyCall = calls.find(c => 'reply_to_uuid' in c)
    expect(replyCall).toBeDefined()

    const html = (replyCall!.body as { html?: string }).html
    expect(html).toBeDefined()
    // Greeting, booking line and sign-off each in their own paragraph.
    expect(html).toContain('</p><p>')
    expect(html).toContain('<p>Alex</p>')
    expect(html).not.toContain('\n\n')
    // The booking link survived, and is not glued to the sign-off.
    expect(html).toContain('https://booking.test/alex')
    expect(html).not.toMatch(/email Alex/)
  })
})
